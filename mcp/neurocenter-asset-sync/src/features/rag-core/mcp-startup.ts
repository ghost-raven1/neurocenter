import path from 'node:path';
import { verify, type Package } from '../../bridge/package.js';
import { assetBase } from '../../bridge/installation-receipt.js';
import { projectFolder, projectBindingId } from '../../bridge/workspace.js';
import { inspectInstallation } from '../../bridge/installation-inspection.js';
import { assertInspectionIdentity } from '../../bridge/inspection-identity.js';
import { readMcpConfiguration, parseLocalConfiguration } from '../local-configuration/index.js';
import { ProbeScope } from '../runtime-probe/process.js';
import { probeMcp } from '../runtime-probe/mcp.js';
import { packageEnvironment } from '../runtime-probe/profile.js';
import { localRagCore } from './contract.js';

/** Короткий initialize/list без tools/call и без OpenCode; вызывается отдельной операцией после commit файлов. */
export async function probeInstalledRagMcp(
    projectId: string,
    bindingId: string,
    pkg: Package,
    authorize: () => Promise<void>,
) {
    const scope = new ProbeScope(12000);
    try {
        verify(pkg);
        if (
            pkg.plugin.kind !== 'mcp' ||
            !localRagCore(pkg) ||
            pkg.config?.entrypoint !== 'opencode-rag.mjs' ||
            JSON.stringify(pkg.config.args) !== '["mcp"]'
        )
            throw new Error('Версия не поддерживает управляемый запуск MCP.');
        await scope.authorize(authorize);
        if ((await projectBindingId(projectId)) !== bindingId) throw new Error('Папка изменилась.');
        const root = await projectFolder(projectId),
            inspection = await scope.wait(inspectInstallation(projectId, pkg));
        assertInspectionIdentity(inspection, projectId, bindingId, pkg);
        if (inspection.state !== 'checked' || inspection.status !== 'synced')
            throw new Error('Требуется проверка установки.');
        const values = parseLocalConfiguration(pkg)
            ? await scope.wait(readMcpConfiguration(projectId, pkg, undefined, authorize))
            : undefined;
        const env = { ...packageEnvironment(pkg, process.env), ...values?.env };
        const counts = await probeMcp(
            pkg,
            {
                root,
                project: root,
                config: path.join(root, '.opencode'),
                env,
                packageDirectory: (member) => path.join(root, assetBase(member)),
            },
            scope,
            authorize,
        );
        await scope.authorize(authorize);
        if ((await projectBindingId(projectId)) !== bindingId || counts.tools === 0)
            throw new Error('MCP не подтвердил инструменты.');
        return counts;
    } finally {
        scope.close();
    }
}
