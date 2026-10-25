import {MEMORY_SYNC_CAPABILITY} from '../features/project-learning-memory-sync/contract.js';
import {SYSTEM_ROLE_MCP_CAPABILITY} from '../features/system-role-mcp/contract.js';
import {roleMcpLifecycleSupported} from '../features/system-role-mcp/owned-process.js';
import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {OPENCODE_PROVIDER_CAPABILITY,OPENCODE_OLLAMA_CAPABILITY} from '../features/opencode-providers/contract.js';
import {DEVICE_CODEX_CAPABILITY,DEVICE_CODEX_DISPATCH_CAPABILITY} from '../features/device-codex-inference/contract.js';

const packageVersion: unknown = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
if (typeof packageVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(packageVersion)) throw new Error('Некорректная версия пакета моста.');
/** Версия клиента читается из того же package.json, который входит в поставку. */
export const BRIDGE_VERSION = packageVersion;
export const BRIDGE_PROTOCOL = 2;
// Advertised only by builds containing the one-shot trusted Codex executor.
export const BRIDGE_CAPABILITIES = ['runtime-cache-target-v2','bridge-update-cleanup-v1','runtime-cache-policy-v1',...(roleMcpLifecycleSupported()?[SYSTEM_ROLE_MCP_CAPABILITY]:[]),DEVICE_CODEX_CAPABILITY,DEVICE_CODEX_DISPATCH_CAPABILITY,'project-learning-quirks-v1',MEMORY_SYNC_CAPABILITY,'project-configuration-v1',OPENCODE_PROVIDER_CAPABILITY,OPENCODE_OLLAMA_CAPABILITY,'opencode-model-sync-v2', 'durable-completions', 'managed-installations', 'package-v3', 'package-v4', 'package-v5', 'runtime-artifacts-v1', 'local-mcp-config-v1', 'install-set-v1', 'installation-inspection-v1', 'workspace-instance-v1', 'local-change-plan-v1', 'runtime-probe-v1', 'project-inventory-v1', 'adopt-installation-v1', 'local-recovery-v1', 'project-rag-generations-v1', 'hosted-rag-model-v1', 'hosted-rag-grants-v1', 'hosted-rag-reindex-v1', 'hosted-rag-profile-values-v1', 'hosted-rag-core-v1', 'opencode-model-scan-v2', 'project-snapshots-v1', 'project-agents-v2','project-learning-v1'];

/** Отпечаток всей сборки позволяет заменить worker даже при повторной установке той же версии. */
export async function bridgeBuildId(): Promise<string> {
    try { return (JSON.parse(await fs.readFile(new URL('../build.json', import.meta.url), 'utf8')) as { buildId: string }).buildId; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return 'source-' + BRIDGE_VERSION; } throw error; }
}
