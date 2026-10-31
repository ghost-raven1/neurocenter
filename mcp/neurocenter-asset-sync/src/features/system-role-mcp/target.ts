import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { projectFolder, projectBindingId, projectInstanceId } from '../../bridge/workspace.js';
import { readState, hub, type Credentials } from '../../bridge/state.js';
import { verify, type Package } from '../../bridge/package.js';
import type { InstallSet } from '../../bridge/install-set.js';
import { assetBase } from '../../bridge/installation-receipt.js';
import { inspectInstallation } from '../../bridge/installation-inspection.js';
import { assertInspectionIdentity } from '../../bridge/inspection-identity.js';
import { resolvePreparedRuntimeArtifact } from '../runtime-artifacts/cache.js';
import { readMcpConfiguration, parseLocalConfiguration } from '../local-configuration/index.js';
import { packageEnvironment } from '../runtime-probe/profile.js';
import { systemRoleMcpDigest, roleMcpProducer, type RoleMcpSessionContext } from './contract.js';
import type { RoleMcpLaunch } from './client.js';
import type { RoleMcpLocalSession } from './local-session.js';

/** Only inspected catalogue bytes and private parameters belonging to this exact folder may become a launch. */
export async function roleMcpTarget(
    context: RoleMcpSessionContext,
    deviceId: string,
    authorize: () => Promise<void>,
    ownership?: RoleMcpLocalSession,
) {
    const { target, projectId } = context,
        pkg = context.package as Package,
        set = context.installSet as InstallSet | undefined;
    verify(pkg);
    const producer = roleMcpProducer(pkg);
    if (
        target.runtime !== 'device' ||
        target.deviceId !== deviceId ||
        !producer ||
        producer.assetKind !== (target.assetKind ?? 'mcp') ||
        pkg.plugin.id !== target.assetId ||
        pkg.plugin.version !== target.version ||
        pkg.manifest.sha256 !== target.manifest
    )
        throw new Error('Нужен точный установленный MCP выбранного компьютера.');
    const site = hub(),
        root = await projectFolder(projectId);
    const check = async () => {
        await authorize();
        if (
            hub() !== site ||
            (await readState<Credentials>('credentials'))?.deviceId !== deviceId ||
            (await projectFolder(projectId)) !== root ||
            (await projectBindingId(projectId)) !== target.bindingId ||
            (await projectInstanceId(projectId)) !== target.instanceId
        )
            throw new Error('Компьютер или папка проекта изменились.');
        const inspection = await inspectInstallation(projectId, pkg);
        assertInspectionIdentity(inspection, projectId, target.bindingId, pkg);
        if (inspection.state !== 'checked' || inspection.status !== 'synced')
            throw new Error('Установка MCP выключена или изменена. Восстановите её через каталог.');
        const revisions = [];
        for (const item of set?.packages ?? [pkg])
            if (parseLocalConfiguration(item)) {
                const config = await readMcpConfiguration(projectId, item, set, authorize);
                revisions.push({ assetId: item.plugin.id, manifest: item.manifest.sha256, revision: config.revision });
            }
        revisions.sort((a, b) => a.assetId.localeCompare(b.assetId));
        if (systemRoleMcpDigest(revisions) !== systemRoleMcpDigest(target.configurationRevisions))
            throw new Error('Локальная настройка MCP изменилась. Выберите инструменты заново.');
        await authorize();
    };
    await check();
    const local = parseLocalConfiguration(pkg)
        ? await readMcpConfiguration(projectId, pkg, set, authorize)
        : { env: {}, headers: {} };
    const runtime = await resolvePreparedRuntimeArtifact(pkg),
        entry =
            producer.assetKind === 'plugin' && runtime
                ? path.join(runtime.root, producer.entrypoint!)
                : (runtime?.entrypoint ??
                  (producer.entrypoint ? path.join(root, assetBase(pkg), producer.entrypoint) : undefined));
    if (
        pkg.config?.transport !== 'remote' &&
        (!entry || (!runtime && !['node', process.execPath].includes(pkg.config?.command ?? '')))
    )
        throw new Error('Исполняемый комплект MCP не подготовлен. Обновите управляемую установку.');
    const temporary = ownership ? await ownership.home() : undefined;
    const home = temporary?.path ?? (await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-role-mcp-')));
    await fs.chmod(home, 0o700);
    const clean = temporary?.close ?? (() => fs.rm(home, { recursive: true, force: true }));
    try {
        const env = packageEnvironment(pkg, {
            PATH: process.env.PATH ?? '/usr/bin:/bin',
            HOME: home,
            USERPROFILE: home,
            TMPDIR: home,
            XDG_CONFIG_HOME: home,
            XDG_CACHE_HOME: home,
            LANG: 'C.UTF-8',
            NO_COLOR: '1',
            DO_NOT_TRACK: '1',
        });
        const executable = producer.assetKind === 'mcp' && runtime?.executable;
        const launch: RoleMcpLaunch = {
            pkg,
            cwd: root,
            env: { ...env, ...local.env },
            headers: { ...pkg.config?.headers, ...local.headers },
            ...(ownership ? { ownership: ownership.process } : {}),
            ...(entry
                ? {
                      command: executable ? entry : process.execPath,
                      args: [...(executable ? [] : [entry]), ...producer.args],
                  }
                : {}),
        };
        return { launch, check, close: clean };
    } catch (error) {
        await clean();
        throw error;
    }
}
