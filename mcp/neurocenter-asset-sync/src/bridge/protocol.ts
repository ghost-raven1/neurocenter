import fs from 'node:fs/promises';

/** Версия клиента и явно поддерживаемый контракт доставки заданий. */
export const BRIDGE_VERSION = '0.9.4';
export const BRIDGE_PROTOCOL = 2;
export const BRIDGE_CAPABILITIES = ['durable-completions', 'managed-installations', 'package-v3', 'package-v4', 'package-v5', 'runtime-artifacts-v1', 'local-mcp-config-v1', 'install-set-v1', 'installation-inspection-v1', 'workspace-instance-v1', 'local-change-plan-v1', 'runtime-probe-v1', 'project-inventory-v1', 'adopt-installation-v1', 'local-recovery-v1'];

/** Отпечаток всей сборки позволяет заменить worker даже при повторной установке той же версии. */
export async function bridgeBuildId(): Promise<string> {
    try { return (JSON.parse(await fs.readFile(new URL('../build.json', import.meta.url), 'utf8')) as { buildId: string }).buildId; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return 'source-' + BRIDGE_VERSION; } throw error; }
}
