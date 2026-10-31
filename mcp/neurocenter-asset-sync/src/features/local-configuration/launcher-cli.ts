import { missingLaunchFields } from './launch-fields.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readPrivateConfiguration } from './private-store.js';
import { launcherDescriptorKey, type LauncherDescriptor } from './launcher-descriptor.js';
import { configurationContext } from './context.js';
import { readConfiguration } from './state.js';
import { configurationTargets } from './schema.js';
import { assetBase, assetKey } from '../../bridge/installation-receipt.js';
import { resolvePreparedRuntimeArtifact } from '../runtime-artifacts/cache.js';
import { startConfiguredRemote } from './remote-proxy.js';
import { windowsJobHelper } from '../runtime-probe/windows-job.js';

/** Launcher читает параметры только после проверки собственного экземпляра и текущих управляемых файлов. */
async function launch(): Promise<void> {
    const [root, key, manifest] = process.argv.slice(2);
    if (
        !root ||
        !path.isAbsolute(root) ||
        !/^[a-f0-9]{24}$/.test(key ?? '') ||
        !/^[a-f0-9]{64}$/.test(manifest ?? '')
    ) {
        throw new Error();
    }
    const marker = JSON.parse(await fs.readFile(path.join(root, '.opencode/neurocenter.json'), 'utf8')) as {
        projectId: string;
    };
    const descriptor = await readPrivateConfiguration<LauncherDescriptor>(
        await launcherDescriptorKey(marker.projectId, key!, manifest!),
    );
    if (
        !descriptor ||
        descriptor.schemaVersion !== 1 ||
        descriptor.projectId !== marker.projectId ||
        assetKey(descriptor.pkg) !== key ||
        descriptor.pkg.manifest.sha256 !== manifest
    ) {
        throw new Error();
    }
    const context = await configurationContext(marker.projectId, descriptor.pkg, undefined, async () => {});
    if (context.root !== (await fs.realpath(root))) {
        throw new Error();
    }
    const stored = await readConfiguration(context);
    if (missingLaunchFields(context.pkg, context.schema, stored?.values ?? {}).length) {
        throw new Error();
    }
    const values = configurationTargets(context.schema, stored?.values ?? {});
    if (context.pkg.config?.transport === 'remote') {
        await startConfiguredRemote(context.pkg, values.headers);
        return;
    }
    const artifact = await resolvePreparedRuntimeArtifact(context.pkg);
    const entrypoint =
        artifact?.entrypoint ??
        (context.pkg.config?.entrypoint
            ? path.join(root, assetBase(context.pkg), context.pkg.config.entrypoint)
            : undefined);
    if (!entrypoint || (!artifact && !['node', process.execPath].includes(context.pkg.config?.command ?? ''))) {
        throw new Error();
    }
    const command = artifact?.executable ? entrypoint : process.execPath;
    const args = [...(artifact?.executable ? [] : [entrypoint]), ...(context.pkg.config?.args ?? [])];
    const helper = process.platform === 'win32' ? await windowsJobHelper() : undefined;
    if (process.platform === 'win32' && !helper) {
        throw new Error();
    }
    const child = spawn(
        helper ?? command,
        helper ? ['--parent-pid', String(process.pid), '--', command, ...args] : args,
        {
            cwd: root,
            env: { ...process.env, ...context.pkg.config?.env, ...values.env },
            detached: process.platform !== 'win32',
            shell: false,
            stdio: 'inherit',
            windowsHide: true,
        },
    );
    const close = () => {
        try {
            if (process.platform === 'win32') {
                child.kill('SIGKILL');
            } else if (child.pid) {
                process.kill(-child.pid, 'SIGKILL');
            }
        } catch {}
    };
    process.once('SIGTERM', close);
    process.once('SIGINT', close);
    child.once('error', () => {
        process.stderr.write('MCP: запуск недоступен.\n');
        process.exitCode = 1;
    });
    child.once('close', (code) => {
        close();
        process.exitCode = code ?? 1;
    });
}
void launch().catch(() => {
    process.stderr.write('MCP: требуется актуальная локальная настройка и проверенная установка.\n');
    process.exitCode = 1;
});
