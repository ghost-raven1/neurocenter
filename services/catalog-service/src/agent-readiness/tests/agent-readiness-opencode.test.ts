import { describe, expect, it } from 'vitest';
import { ConflictException, BadRequestException } from '@nestjs/common';
import {
    AgentOpenCodeTrialRunner,
    NoOpenCodeProbe,
    OpenCodeNeedsSetupException,
    OPENCODE_SETUP_ACTION,
    type IOpenCodeProbeOutcome,
    type IOpenCodeReadinessProbe,
} from '../agent-readiness-opencode';
import { startAgentTrial } from '../agent-readiness.validation';
import type { ITrialRow } from '../agent-readiness.repository';
import type { IAgentTrialReceipt } from '../agent-readiness.interfaces';
import type { IAgentDefinition } from '../../../../shared/project-agents.cjs';

const SHA = 'a'.repeat(64);
const MODEL_PIN = 'c'.repeat(64);
const PIN = 'd'.repeat(64);
const PROJECT = 'prj-1';
const AGENT = 'agent-dev1';
const ACTOR = 'admin@example.test';
const REQUEST_ID = '11111111-2222-4333-8444-555555555555';
const definition: IAgentDefinition = {
    description: 'Dev agent',
    prompt: 'Do tasks',
    mode: 'primary',
    permission: { read: 'allow' },
};
const baseRequest = { requestId: REQUEST_ID, expectedRevision: 1, expectedAgentPin: PIN, tool: 'none' as const };

const row = (overrides: Partial<ITrialRow> = {}): ITrialRow => ({
    id: 'trial-1',
    project_id: PROJECT,
    agent_id: AGENT,
    owner_email: ACTOR,
    request_id: REQUEST_ID,
    request_hash: SHA,
    request: { ...baseRequest, executionSurface: 'opencode' },
    snapshot: { definition, agentPin: PIN, nonce: 'nonce-1', toolPin: null },
    receipt: {} as IAgentTrialReceipt,
    status: 'queued',
    revision: 1,
    lease_token: 'lease-1',
    lease_until: null,
    message: '',
    created_at: new Date(),
    finished_at: null,
    ...overrides,
});
const opencodeReceipt = (): IAgentTrialReceipt => ({
    agentVersion: 1,
    agentManifest: SHA,
    agentPin: PIN,
    promptSha256: SHA,
    configSha256: SHA,
    modelId: null,
    modelName: null,
    modelPin: null,
    toolMode: 'none',
    executionSurface: 'opencode',
    checks: [
        { kind: 'opencode_probe', status: 'not_run', message: 'Проба ещё не выполнена.' },
        { kind: 'model_response', status: 'not_run', message: 'Тестовое задание ещё не выполнено.' },
    ],
});
const probe = (available: boolean, outcome?: IOpenCodeProbeOutcome): IOpenCodeReadinessProbe => ({
    available,
    run: async () => {
        if (!outcome) throw new OpenCodeNeedsSetupException();
        return outcome;
    },
});

describe('NoOpenCodeProbe (default boundary)', () => {
    it('reports the surface as not wired in and its run throws the actionable needs_setup step', async () => {
        const none = new NoOpenCodeProbe();
        expect(none.available).toBe(false);
        await expect(none.run()).rejects.toBeInstanceOf(OpenCodeNeedsSetupException);
    });
});

describe('AgentOpenCodeTrialRunner (contentful probe)', () => {
    const signal = () => new AbortController().signal;

    it('marks the probe not_run and raises the actionable next step when no runtime is wired in', async () => {
        const receipt = opencodeReceipt();
        const runner = new AgentOpenCodeTrialRunner(probe(false));
        await expect(runner.run(row(), receipt, signal())).rejects.toMatchObject({
            message: expect.stringContaining(OPENCODE_SETUP_ACTION),
        });
        await expect(runner.run(row(), receipt, signal())).rejects.toBeInstanceOf(OpenCodeNeedsSetupException);
        expect(receipt.checks[0]).toMatchObject({ kind: 'opencode_probe', status: 'not_run' });
        expect(receipt.checks[0].message).toContain('runtime OpenCode недоступен');
    });

    it('passes both checks when the probe returns a verifiable content hash and a short detail', async () => {
        const receipt = opencodeReceipt();
        const runner = new AgentOpenCodeTrialRunner(probe(true, { contentSha256: SHA, detail: 'Команда выполнена.' }));
        await runner.run(row(), receipt, signal());
        expect(receipt.checks[0]).toMatchObject({ kind: 'opencode_probe', status: 'passed' });
        expect(receipt.checks[0].message).toContain(SHA.slice(0, 12));
        expect(receipt.checks[1]).toMatchObject({ kind: 'model_response', status: 'passed' });
    });

    it('records the exact row identity and nonce into the probe input', async () => {
        const seen: Array<{ projectId: string; agentId: string; nonce: string }> = [];
        const runner = new AgentOpenCodeTrialRunner({
            available: true,
            run: async (input) => {
                seen.push({ projectId: input.projectId, agentId: input.agentId, nonce: input.nonce });
                return { contentSha256: SHA, detail: 'ok' };
            },
        });
        await runner.run(row(), opencodeReceipt(), signal());
        expect(seen).toEqual([{ projectId: PROJECT, agentId: AGENT, nonce: 'nonce-1' }]);
    });

    it('fails when the probe does not return a verifiable content hash (a bare card is not proof)', async () => {
        const receipt = opencodeReceipt();
        const runner = new AgentOpenCodeTrialRunner(probe(true, { contentSha256: 'not-a-sha', detail: 'ok' }));
        await expect(runner.run(row(), receipt, signal())).rejects.toBeInstanceOf(ConflictException);
        expect(receipt.checks[0]).toMatchObject({ kind: 'opencode_probe', status: 'failed' });
    });

    it('fails when the detail is empty or exceeds the 512-byte bound', async () => {
        const receipt = opencodeReceipt();
        const runner = new AgentOpenCodeTrialRunner(probe(true, { contentSha256: SHA, detail: '   ' }));
        await expect(runner.run(row(), receipt, signal())).rejects.toBeInstanceOf(ConflictException);
        expect(receipt.checks[0]).toMatchObject({ kind: 'opencode_probe', status: 'failed' });
        const receipt2 = opencodeReceipt();
        const runner2 = new AgentOpenCodeTrialRunner(probe(true, { contentSha256: SHA, detail: 'x'.repeat(513) }));
        await expect(runner2.run(row(), receipt2, signal())).rejects.toBeInstanceOf(ConflictException);
        expect(receipt2.checks[0]).toMatchObject({ kind: 'opencode_probe', status: 'failed' });
    });
});

describe('startAgentTrial validation (surface contract)', () => {
    it('accepts the opencode surface with no model binding and forces the tool off', () => {
        const input = startAgentTrial({ ...baseRequest, executionSurface: 'opencode' });
        expect(input).toEqual({
            requestId: REQUEST_ID,
            expectedRevision: 1,
            expectedAgentPin: PIN,
            tool: 'none',
            toolConsent: false,
            executionSurface: 'opencode',
        });
        expect(input).not.toHaveProperty('modelId');
        expect(input).not.toHaveProperty('expectedModelPin');
    });

    it('rejects a modelId on the opencode surface', () => {
        expect(() => startAgentTrial({ ...baseRequest, executionSurface: 'opencode', modelId: 'model-1' })).toThrow(
            BadRequestException,
        );
    });

    it('rejects an expectedModelPin on the opencode surface', () => {
        expect(() =>
            startAgentTrial({ ...baseRequest, executionSurface: 'opencode', expectedModelPin: MODEL_PIN }),
        ).toThrow(BadRequestException);
    });

    it('rejects a project tool on the opencode surface', () => {
        expect(() => startAgentTrial({ ...baseRequest, executionSurface: 'opencode', tool: 'project_search' })).toThrow(
            BadRequestException,
        );
    });

    it('rejects an unknown surface value', () => {
        expect(() => startAgentTrial({ ...baseRequest, executionSurface: 'device_chat' })).toThrow(BadRequestException);
    });

    it('defaults a legacy request (no surface) to server_chat with a required model pin', () => {
        const input = startAgentTrial({ ...baseRequest, modelId: 'model-1', expectedModelPin: MODEL_PIN });
        expect(input.executionSurface).toBe('server_chat');
        expect(input.modelId).toBe('model-1');
        expect(input.expectedModelPin).toBe(MODEL_PIN);
    });

    it('still requires a model pin for the default server_chat surface', () => {
        expect(() => startAgentTrial({ ...baseRequest, modelId: 'model-1' })).toThrow(BadRequestException);
    });
});
