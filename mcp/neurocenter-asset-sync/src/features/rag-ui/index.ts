import path from 'node:path';
import { verify, type Package } from '../../bridge/package.js';
import { projectFolder, projectBindingId, projectInstanceId } from '../../bridge/workspace.js';
import { inspectInstallation } from '../../bridge/installation-inspection.js';
import { assertInspectionIdentity } from '../../bridge/inspection-identity.js';
import { resolvePreparedRuntimeArtifact } from '../runtime-artifacts/cache.js';
import { parseLocalConfiguration, readMcpConfiguration } from '../local-configuration/index.js';
import { packageEnvironment } from '../runtime-probe/profile.js';
import { localRagUi } from './contract.js';
import { openRagBrowserWindow } from './browser-window.js';
import { startRagUiProcess, type UiProcess } from './process.js';

interface Session {
    process: UiProcess;
    key: string;
    root: string;
    timer: NodeJS.Timeout;
}
const sessions = new Map<string, Session>();
export const RAG_UI_NOTE = 'Локальный интерфейс готов; система приняла запрос на отдельное окно браузера.';
/** Остановка не трогает браузеры, чужие PID или UI других worker. */
export async function closeRagUis(): Promise<void> {
    const owned = [...sessions.values()];
    sessions.clear();
    await Promise.all(
        owned.map(async (session) => {
            clearInterval(session.timer);
            await session.process.stop();
        }),
    );
}
/** Восстановление закрывает только свой UI и ждёт graceful-выхода; чужой writer не прерывается. */
export async function closeOwnRagUi(projectId: string): Promise<void> {
    const session = sessions.get(projectId);
    if (!session) return;
    await session.process.stop({ force: false, timeoutMs: 120000 });
    clearInterval(session.timer);
    if (sessions.get(projectId) === session) sessions.delete(projectId);
}
/** Только текущая квитанция, физический экземпляр папки и полностью проверенный SHA-архив. */
export async function openRagUi(
    input: { projectId: string; bindingId: string; instanceId: string; pkg: Package },
    authorize: () => Promise<void>,
) {
    const pkg = structuredClone(input.pkg);
    verify(pkg);
    const descriptor = localRagUi(pkg);
    if (!descriptor) throw new Error('Обновите OpenCodeRAG: эта версия не содержит управляемого интерфейса.');
    const identity = async () => {
        if (
            (await projectBindingId(input.projectId)) !== input.bindingId ||
            (await projectInstanceId(input.projectId)) !== input.instanceId
        )
            throw new Error('Папка проекта изменилась. Откройте интерфейс из актуальной установки.');
    };
    await authorize();
    await identity();
    const root = await projectFolder(input.projectId);
    const inspection = await inspectInstallation(input.projectId, pkg);
    assertInspectionIdentity(inspection, input.projectId, input.bindingId, pkg);
    if (inspection.state !== 'checked' || inspection.status !== 'synced')
        throw new Error('Файлы установки изменились или проект занят. Проверьте установленный OpenCodeRAG.');
    const artifact = await resolvePreparedRuntimeArtifact(pkg);
    if (!artifact) throw new Error('Готовый комплект OpenCodeRAG отсутствует. Обновите установленный инструмент.');
    const cliPkg = {
        ...pkg,
        config: { ...pkg.config, extra: pkg.config?.extra ? { ...pkg.config.extra } : undefined },
    };
    // Проверяющий кэш сверяет, что и дополнительная UI-точка входит в одобренный архив.
    cliPkg.config.extra = {
        ...cliPkg.config.extra,
        runtimeArtifacts: pkg.config!.extra!.runtimeArtifacts!.map((item) => ({
            ...item,
            entrypoint: descriptor.entrypoint,
            executable: false,
        })),
    };
    const uiArtifact = await resolvePreparedRuntimeArtifact(cliPkg);
    if (
        !uiArtifact ||
        uiArtifact.root !== artifact.root ||
        uiArtifact.entrypoint !== path.join(artifact.root, descriptor.entrypoint)
    )
        throw new Error('Точка входа интерфейса не закреплена в комплекте.');
    let env = packageEnvironment(pkg, process.env);
    let configurationRevision: string | null = null;
    if (parseLocalConfiguration(pkg)) {
        const configuration = await readMcpConfiguration(input.projectId, pkg, undefined, authorize);
        env = { ...env, ...configuration.env };
        configurationRevision = configuration.revision;
    }
    const key = JSON.stringify([input.bindingId, artifact.sha256, pkg.manifest.sha256, configurationRevision]);
    let session = sessions.get(input.projectId);
    let reused = false;
    if (
        session &&
        (session.key !== key ||
            session.process.child.connected === false ||
            session.process.child.exitCode !== null ||
            session.process.child.signalCode !== null)
    ) {
        await session.process.stop({ force: false, timeoutMs: 5000 });
        sessions.delete(input.projectId);
        clearInterval(session.timer);
        session = undefined;
    }
    await authorize();
    await identity();
    if (!session) {
        const process = await startRagUiProcess(uiArtifact.entrypoint, descriptor.args, root, env);
        const timer = setInterval(() => {
            void identity().catch(async () => {
                const current = sessions.get(input.projectId);
                if (current?.process === process) {
                    sessions.delete(input.projectId);
                    clearInterval(timer);
                    await process.stop();
                }
            });
        }, 15000);
        timer.unref();
        session = { key, root, process, timer };
        sessions.set(input.projectId, session);
        const forget = () => {
            process.child.off('exit', forget);
            process.child.off('close', forget);
            clearInterval(timer);
            if (sessions.get(input.projectId)?.process === process) sessions.delete(input.projectId);
        };
        process.child.once('exit', forget);
        process.child.once('close', forget);
        if (process.child.exitCode != null || process.child.signalCode != null) forget();
    } else reused = true;
    try {
        await authorize();
        await identity();
        await openRagBrowserWindow(session.process.url);
    } catch (error) {
        if (!reused) {
            sessions.delete(input.projectId);
            clearInterval(session.timer);
            await session.process.stop();
        }
        throw error;
    }
    return { opened: true as const, reused, note: RAG_UI_NOTE };
}
