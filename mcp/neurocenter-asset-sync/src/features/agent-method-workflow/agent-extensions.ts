import fs from 'node:fs/promises';
import path from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import { hash } from '../../bridge/state.js';
import { readBoundedUtf8 } from '../../bridge/read-bounded.js';
import { CONFIG_PATHS } from '../../bridge/installation-files.js';
import { safeTarget } from '../../bridge/workspace.js';
import { agentsPrivateProof } from '../project-agents/receipt.js';
import type { IAgentExtension } from '../../../../../services/shared/project-agents.cjs';
import type { AgentMethodWorkflowPayload } from './contract.js';
import { MethodExecutionError } from './process.js';

const notReady = () => new MethodExecutionError('SELECTED_AGENT_NOT_READY');
const agentIdPattern = /^agent-[a-z0-9][a-z0-9-]{0,120}$/;
const shaPattern = /^[a-f0-9]{64}$/;
/** FR-306: per-agent kit overlay; the runner re-verifies it byte-exactly before applying the mcp whitelist. */
export const agentOverlayPath = (agentId: string): string => `.nc/agents/${agentId}/kit.json`;
export interface IAgentKitOverlay {
    schemaVersion: 1;
    agentId: string;
    projectId: string;
    agentsManifestSha256: string;
    extensions: IAgentExtension[];
    /** Pre-computed mcp isolation for the agent's opencode process; null when no mcp extension is present. */
    mcpOverride: Record<string, unknown> | null;
    sha256: string;
}
const overlaySha = (kit: Omit<IAgentKitOverlay, 'sha256'>): string =>
    hash(
        JSON.stringify({
            agentId: kit.agentId,
            projectId: kit.projectId,
            agentsManifestSha256: kit.agentsManifestSha256,
            extensions: kit.extensions,
            mcpOverride: kit.mcpOverride,
        }),
    );
const mcpOverrideShape = (value: unknown): boolean =>
    value === null ||
    (object(value) &&
        Object.keys(value).length <= 64 &&
        Object.keys(value).every((key) => !!key && key.length <= 200) &&
        Object.values(value).every((entry) => object(entry)));
const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
const extensionShape = (value: unknown): value is IAgentExtension =>
    object(value) &&
    ['assetId', 'assetKind', 'manifest', 'origin', 'version'].every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => ['assetId', 'assetKind', 'manifest', 'origin', 'version'].includes(key)) &&
    typeof value.assetId === 'string' &&
    !!value.assetId &&
    value.assetId.length <= 512 &&
    typeof value.assetKind === 'string' &&
    ['mcp', 'plugin', 'skill'].includes(value.assetKind) &&
    Number.isSafeInteger(value.version) &&
    Number(value.version) >= 1 &&
    typeof value.manifest === 'string' &&
    shaPattern.test(value.manifest) &&
    typeof value.origin === 'string' &&
    ['approved', 'experimental'].includes(value.origin);
/** Byte-exact overlay check for the runner: any drift between the argv kit and the committed file is refused. */
export function validateKitOverlay(raw: string): IAgentKitOverlay | null {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return null;
    }
    const keys = [
        'agentId',
        'agentsManifestSha256',
        'extensions',
        'mcpOverride',
        'projectId',
        'schemaVersion',
        'sha256',
    ];
    if (
        !object(value) ||
        keys.some((key) => !Object.hasOwn(value, key)) ||
        Object.keys(value).some((key) => !keys.includes(key)) ||
        value.schemaVersion !== 1 ||
        typeof value.agentId !== 'string' ||
        !agentIdPattern.test(value.agentId) ||
        typeof value.projectId !== 'string' ||
        !value.projectId ||
        value.projectId.length > 200 ||
        typeof value.agentsManifestSha256 !== 'string' ||
        !shaPattern.test(value.agentsManifestSha256) ||
        !Array.isArray(value.extensions) ||
        value.extensions.length > 16 ||
        !value.extensions.every(extensionShape) ||
        !mcpOverrideShape(value.mcpOverride)
    )
        return null;
    const seen = new Set(value.extensions.map((entry) => entry.assetKind + ':' + entry.assetId));
    if (seen.size !== value.extensions.length) return null;
    const kit = value as unknown as IAgentKitOverlay;
    if (typeof kit.sha256 !== 'string' || !shaPattern.test(kit.sha256) || kit.sha256 !== overlaySha(kit)) return null;
    return kit;
}
const receiptKey = (kind: string, assetId: string): string => hash(kind + ':' + assetId).slice(0, 24);
interface IReceiptConfig {
    path: string;
    key: string;
    value: unknown;
}
async function optionalRead(file: string, maximum: number): Promise<string | null> {
    try {
        return await readBoundedUtf8(file, maximum);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}
/** The committed local receipt must prove the exact version/manifest of a kit entry. */
async function approvedReceipt(root: string, extension: IAgentExtension): Promise<unknown | null> {
    const raw = await optionalRead(
        await safeTarget(
            root,
            '.opencode/neurocenter/receipts/' + receiptKey(extension.assetKind, extension.assetId) + '.json',
        ),
        64 * 1024,
    );
    if (raw === null) return null;
    let receipt: unknown;
    try {
        receipt = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!object(receipt) || receipt.version !== extension.version || receipt.manifest !== extension.manifest)
        return null;
    return receipt;
}
/** The mcp receipt must also carry the approved config entry that the whitelist pins. */
async function approvedMcpReceipt(
    root: string,
    extension: IAgentExtension,
): Promise<{ key: string; value: unknown } | null> {
    const receipt = await approvedReceipt(root, extension);
    if (receipt === null || !object((receipt as { config?: unknown }).config)) return null;
    const config = (receipt as { config: IReceiptConfig }).config;
    if (!CONFIG_PATHS.includes(config.path) || typeof config.key !== 'string' || !config.key) return null;
    return { key: config.key, value: config.value };
}
/**
 * FR-306: the selected agent's kit comes from the committed agents receipt, never from the job payload.
 * Approved entries must be provable by local install receipts; experimental entries must be device-local
 * capability-test folders. The result is the overlay the runner verifies before starting opencode.
 */
export async function prepareAgentKit(
    root: string,
    payload: AgentMethodWorkflowPayload,
): Promise<{ extensions: IAgentExtension[]; overlay: string } | undefined> {
    const selected = payload.agent;
    if (!selected) return undefined;
    const proof = await agentsPrivateProof(root, payload.projectId);
    const receipt = proof?.receipt;
    if (
        !proof ||
        !receipt ||
        receipt.schemaVersion !== 2 ||
        receipt.projectId !== payload.projectId ||
        receipt.revision !== selected.agentsRevision ||
        receipt.manifestSha256 !== selected.agentsManifestSha256 ||
        receipt.compiledManifestSha256 !== selected.compiledManifestSha256
    )
        throw notReady();
    const agent = receipt.agents.find((entry) => entry.id === selected.agentId);
    if (
        !agent ||
        !agent.enabled ||
        agent.slug !== selected.slug ||
        agent.version !== selected.version ||
        agent.sha256 !== selected.fileSha256
    )
        throw notReady();
    const extensions = agent.extensions ?? [];
    if (!extensions.length) return undefined;
    for (const extension of extensions) {
        if (extension.origin === 'approved') {
            if ((await approvedReceipt(root, extension)) === null) throw notReady();
        } else {
            const folder = await fs
                .stat(path.join(root, '.nc/agents', selected.agentId, 'experimental', extension.assetId))
                .catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
            if (!folder?.isDirectory()) throw notReady();
        }
    }
    // The mcp isolation is computed here, while the receipts and project config are still verifiable in this
    // process; the runner only re-verifies the committed overlay (byte-exact sha256) and applies it.
    const mcpOverride = await agentMcpWhitelist(root, { extensions });
    const kit: Omit<IAgentKitOverlay, 'sha256'> = {
        schemaVersion: 1,
        agentId: selected.agentId,
        projectId: payload.projectId,
        agentsManifestSha256: selected.agentsManifestSha256,
        extensions,
        mcpOverride,
    };
    const overlay = agentOverlayPath(selected.agentId);
    const target = await safeTarget(root, overlay);
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = path.join(path.dirname(target), '.' + path.basename(overlay) + '.' + process.pid + '.tmp');
    try {
        await fs.writeFile(temporary, JSON.stringify({ ...kit, sha256: overlaySha(kit) }), {
            encoding: 'utf8',
            mode: 0o600,
        });
        await fs.rename(temporary, target);
    } catch {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        throw notReady();
    }
    return { extensions, overlay };
}
/**
 * MCP isolation for the agent's opencode process: approved kit servers keep their receipt-proven
 * config, every other project-level mcp entry is disabled. Works under both deep-merge and whole-key
 * replacement of the inline environment config. Only receipt-proven (approved) servers are enabled:
 * an unproven server is never granted to the agent (fail-closed).
 */
export async function agentMcpWhitelist(
    root: string,
    kit: { extensions: IAgentExtension[] },
): Promise<Record<string, unknown> | null> {
    if (!kit.extensions.some((extension) => extension.assetKind === 'mcp')) return null;
    const whitelist = new Map<string, unknown>();
    for (const extension of kit.extensions.filter((item) => item.assetKind === 'mcp' && item.origin === 'approved')) {
        const entry = await approvedMcpReceipt(root, extension);
        if (entry === null) throw notReady();
        whitelist.set(entry.key, entry.value);
    }
    const override: Record<string, unknown> = Object.fromEntries([...whitelist]);
    for (const configPath of CONFIG_PATHS) {
        const raw = await optionalRead(await safeTarget(root, configPath), 1024 * 1024);
        if (raw === null) continue;
        const errors: unknown[] = [];
        const parsed: unknown = parseJsonc(raw, errors as never, { allowTrailingComma: true });
        if (errors.length || !object(parsed)) throw notReady();
        if (parsed.mcp === undefined || parsed.mcp === null) continue;
        if (!object(parsed.mcp)) throw notReady();
        for (const key of Object.keys(parsed.mcp)) if (!whitelist.has(key)) override[key] = { enabled: false };
    }
    return Object.keys(override).length ? override : null;
}
