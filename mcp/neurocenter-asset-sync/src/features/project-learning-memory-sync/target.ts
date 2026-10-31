import { projectFolder, projectBindingId, projectInstanceId } from '../../bridge/workspace.js';
import { readState, hub, type Credentials } from '../../bridge/state.js';
import { verify, type Package } from '../../bridge/package.js';
import { inspectInstallation } from '../../bridge/installation-inspection.js';
import { assertInspectionIdentity } from '../../bridge/inspection-identity.js';
import { resolvePreparedRuntimeArtifact } from '../runtime-artifacts/cache.js';
import { memoryRecipeSupported, type MemorySyncPayload } from './contract.js';

/** Reuse the installed, inspected runtime; never run an arbitrary command from OpenCode configuration. */
export async function memoryTarget(payload: MemorySyncPayload, pkg: Package, deviceId: string) {
    verify(pkg);
    if (
        !memoryRecipeSupported(pkg) ||
        pkg.plugin.id !== payload.assetId ||
        pkg.plugin.version !== payload.version ||
        pkg.manifest.sha256 !== payload.manifest
    )
        throw new Error('Обновите управляемый MCP Memory из каталога.');
    const site = hub(),
        root = await projectFolder(payload.projectId);
    const assertCurrent = async () => {
        if (
            hub() !== site ||
            (await readState<Credentials>('credentials'))?.deviceId !== deviceId ||
            (await projectFolder(payload.projectId)) !== root ||
            (await projectBindingId(payload.projectId)) !== payload.bindingId ||
            (await projectInstanceId(payload.projectId)) !== payload.instanceId
        )
            throw new Error('Компьютер, площадка или привязка Memory изменились.');
        const inspection = await inspectInstallation(payload.projectId, pkg);
        assertInspectionIdentity(inspection, payload.projectId, payload.bindingId, pkg);
        if (inspection.state !== 'checked' || inspection.status !== 'synced')
            throw new Error('Подключение Memory выключено или изменено вручную. Восстановите установку через каталог.');
    };
    await assertCurrent();
    const runtime = await resolvePreparedRuntimeArtifact(pkg);
    if (!runtime || runtime.executable)
        throw new Error('Подготовленный комплект Memory недоступен. Обновите установку.');
    return { site, root, runtime, assertCurrent };
}
