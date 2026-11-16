import { ConflictException } from '@nestjs/common';
import { sha } from '../agents/agent-validation';
import type { IAgentTrialReceipt } from './agent-readiness.interfaces';
import type { ITrialRow } from './agent-readiness.repository';

/**
 * FR-307 opencode readiness. The probe is a *contentful* check: it runs a tool/command in the OpenCode
 * environment and returns a verifiable content hash of the executed output — not a bare card. The
 * catalog service only defines the probe boundary; the actual OpenCode runtime lives on the device
 * (epic 7), so it is injected here and never duplicated. A deployment without a wired probe reports
 * `needs_setup` with the actionable next step (`setup-runtime`), following the agent-method-workflows
 * needs_setup pattern.
 */
export interface IOpenCodeProbeInput {
    projectId: string;
    agentId: string;
    nonce: string;
    signal: AbortSignal;
}
export interface IOpenCodeProbeOutcome {
    /** SHA-256 of the normalized executed output — proof of actual execution, never raw stdout. */
    contentSha256: string;
    /** Short human-readable summary (<= 512 bytes, no raw output, no secrets). */
    detail: string;
}
export interface IOpenCodeReadinessProbe {
    /** True only when an OpenCode runtime is wired in for this deployment. */
    readonly available: boolean;
    /** Run a read-only, contentful probe in the OpenCode environment. */
    run(input: IOpenCodeProbeInput): Promise<IOpenCodeProbeOutcome>;
}
/** Default probe: no runtime wired in, so the surface is available-for-setup, not runnable. */
export class NoOpenCodeProbe implements IOpenCodeReadinessProbe {
    readonly available = false;
    async run(): Promise<IOpenCodeProbeOutcome> {
        throw new OpenCodeNeedsSetupException();
    }
}
/** The actionable next step when the OpenCode environment is not ready (agent-method-workflows action). */
export const OPENCODE_SETUP_ACTION = 'setup-runtime';
/** needs_setup: the OpenCode environment cannot run the contentful probe yet. */
export class OpenCodeNeedsSetupException extends ConflictException {
    constructor() {
        super(
            `OpenCode среда не готова к содержательной пробе. Следующий шаг: установите и подключите runtime OpenCode (${OPENCODE_SETUP_ACTION}).`,
        );
    }
}
const MAX_DETAIL = 512;
/**
 * Runs the opencode trial: a single contentful probe. Not available -> needs_setup (setup-runtime);
 * ran -> validates the returned content hash and records the opencode_probe check.
 */
export class AgentOpenCodeTrialRunner {
    constructor(private readonly probe: IOpenCodeReadinessProbe) {}
    async run(row: ITrialRow, receipt: IAgentTrialReceipt, signal: AbortSignal): Promise<void> {
        signal.throwIfAborted();
        if (!this.probe.available) {
            receipt.checks[0] = {
                kind: 'opencode_probe',
                status: 'not_run',
                message: 'Проба не выполнена: runtime OpenCode недоступен в этом развёртывании.',
            };
            throw new OpenCodeNeedsSetupException();
        }
        const outcome = await this.probe.run({
            projectId: row.project_id,
            agentId: row.agent_id,
            nonce: row.snapshot.nonce,
            signal,
        });
        signal.throwIfAborted();
        if (!sha(outcome?.contentSha256)) {
            receipt.checks[0] = {
                kind: 'opencode_probe',
                status: 'failed',
                message: 'Проба не вернула корректное подтверждение фактического выполнения.',
            };
            throw new ConflictException('Проба OpenCode не подтвердила фактическое выполнение.');
        }
        if (
            typeof outcome.detail !== 'string' ||
            !outcome.detail.trim() ||
            Buffer.byteLength(outcome.detail, 'utf8') > MAX_DETAIL
        ) {
            receipt.checks[0] = {
                kind: 'opencode_probe',
                status: 'failed',
                message: 'Проба вернула недопустимое описание результата.',
            };
            throw new ConflictException('Проба OpenCode вернула недопустимый результат.');
        }
        receipt.checks[0] = {
            kind: 'opencode_probe',
            status: 'passed',
            message: `Исполнение в OpenCode подтверждено содержательной пробой (content ${outcome.contentSha256.slice(0, 12)}…). ${outcome.detail.trim()}`,
        };
        receipt.checks[1] = {
            kind: 'model_response',
            status: 'passed',
            message: 'Среда OpenCode выполнила диагностическую команду и вернула подтверждённое содержимое.',
        };
    }
}
