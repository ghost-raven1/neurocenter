import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Package } from '../../bridge/package.js';
import { assetKey } from '../../bridge/installation-receipt.js';
import { ProbeError } from './model.js';
import type { ProbeScope } from './process.js';

export interface ProbeProfile {
    root: string;
    project: string;
    config: string;
    env: NodeJS.ProcessEnv;
    packageDirectory(pkg: Package): string;
}
const lockedDependency = { '@opencode-ai/plugin': '1.14.48' };
const forbiddenEnvironment =
    /^(HOME|USERPROFILE|PATH|SHELL|ENV|BASH_ENV|APPDATA|LOCALAPPDATA|TMPDIR|TMP|TEMP|NODE_OPTIONS|NODE_PATH|XDG_.*|OPENCODE_.*|BUN_.*|NPM_.*|PIP_.*|PYTHON.*|LD_.*|DYLD_.*)$/i;

export function packageEnvironment(pkg: Package, base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const env = pkg.config?.env ?? {};
    if (Object.keys(env).some((key) => forbiddenEnvironment.test(key))) {
        throw new ProbeError('unsupported', 'unsafe-environment');
    }
    if (Object.values(env).some((value) => typeof value !== 'string' || /\{env:|\$\{/.test(value))) {
        throw new ProbeError('needs_configuration', 'configuration-required');
    }
    return { ...base, ...env };
}

/** MDM не перенаправляется через HOME; наличие профиля запрещает запуск, содержимое не читается. */
export async function assertNoManagedPreferences(): Promise<void> {
    if (process.platform !== 'darwin') {
        return;
    }
    for (const file of [
        path.join('/Library/Managed Preferences', os.userInfo().username, 'ai.opencode.managed.plist'),
        '/Library/Managed Preferences/ai.opencode.managed.plist',
    ]) {
        try {
            await fs.lstat(file);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                continue;
            }
        }
        throw new ProbeError('unsupported', 'managed-configuration');
    }
}

/** Материализует только одобренные байты, полностью исключая личные конфиги и переменные окружения. */
export async function createProfile(packages: Package[], scope: ProbeScope): Promise<ProbeProfile> {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-runtime-probe-')));
    try {
        await fs.chmod(root, 0o700);
        const home = path.join(root, 'home');
        const project = path.join(root, 'project');
        const config = path.join(home, 'config/opencode');
        const bin = path.join(root, 'bin');
        for (const directory of [
            project,
            config,
            bin,
            path.join(root, 'node_modules'),
            path.join(project, 'node_modules'),
            path.join(config, 'node_modules'),
        ]) {
            await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        }
        await fs.writeFile(
            path.join(config, '.gitignore'),
            'node_modules\npackage.json\npackage-lock.json\nbun.lock\n.gitignore\n',
        );
        await fs.writeFile(
            path.join(config, 'package.json'),
            JSON.stringify({ private: true, dependencies: lockedDependency }),
        );
        await fs.writeFile(
            path.join(config, 'package-lock.json'),
            JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: lockedDependency } } }),
        );
        await fs.writeFile(path.join(project, 'package.json'), '{"private":true,"type":"module"}');
        const bunfig = 'telemetry = false\nenv = false\n[install]\nauto = "disable"\n';
        await fs.writeFile(path.join(project, 'bunfig.toml'), bunfig);
        await fs.writeFile(path.join(home, '.bunfig.toml'), bunfig);
        await fs.writeFile(path.join(home, 'config/.bunfig.toml'), bunfig);
        const npmrc = 'offline=true\nignore-scripts=true\nregistry=http://127.0.0.1:9\n';
        await fs.writeFile(path.join(home, '.npmrc'), npmrc);
        await fs.writeFile(path.join(config, '.npmrc'), npmrc);
        const env: NodeJS.ProcessEnv = {
            HOME: home,
            USERPROFILE: home,
            XDG_CONFIG_HOME: path.join(home, 'config'),
            XDG_DATA_HOME: path.join(home, 'data'),
            XDG_STATE_HOME: path.join(home, 'state'),
            XDG_CACHE_HOME: path.join(home, 'cache'),
            TMPDIR: path.join(root, 'tmp'),
            PATH: bin,
            TERM: 'dumb',
            NO_COLOR: '1',
            DO_NOT_TRACK: '1',
            OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(root, 'managed'),
            OPENCODE_DISABLE_PROJECT_CONFIG: '1',
            OPENCODE_DISABLE_AUTOUPDATE: '1',
            OPENCODE_DISABLE_MODELS_FETCH: '1',
            OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
            OPENCODE_DISABLE_LSP_DOWNLOAD: '1',
            OPENCODE_DISABLE_CLAUDE_CODE: '1',
            OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
            OPENCODE_DISABLE_AUTOCOMPACT: '1',
            OPENCODE_DISABLE_PRUNE: '1',
            NPM_CONFIG_OFFLINE: 'true',
            NPM_CONFIG_IGNORE_SCRIPTS: 'true',
            NPM_CONFIG_REGISTRY: 'http://127.0.0.1:9',
            NPM_CONFIG_CACHE: path.join(root, 'npm-cache'),
            BUN_INSTALL_CACHE_DIR: path.join(root, 'bun-cache'),
            PIP_NO_INDEX: '1',
            PIP_DISABLE_PIP_VERSION_CHECK: '1',
        };
        await fs.mkdir(env.TMPDIR!, { mode: 0o700 });
        const packageDirectory = (pkg: Package): string => path.join(root, 'packages', assetKey(pkg));
        for (const pkg of packages) {
            for (const file of pkg.files) {
                scope.remaining();
                const destination = path.join(packageDirectory(pkg), file.path);
                await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
                await fs.writeFile(
                    destination,
                    Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8'),
                    { mode: 0o600 },
                );
            }
        }
        return { root, project, config, env, packageDirectory };
    } catch (error) {
        await fs.rm(root, { recursive: true, force: true });
        throw error;
    }
}

export async function configurePlugin(profile: ProbeProfile, wrapper: string): Promise<void> {
    await fs.chmod(profile.config, 0o700);
    await fs.chmod(path.join(profile.config, 'opencode.json'), 0o600).catch(() => {});
    await fs.writeFile(
        path.join(profile.config, 'opencode.json'),
        JSON.stringify({
            $schema: 'https://opencode.ai/config.json',
            username: 'runtime-probe',
            plugin: [pathToFileURL(wrapper).href],
            mcp: {},
            enabled_providers: [],
            provider: {},
            lsp: false,
            formatter: false,
            autoupdate: false,
            snapshot: false,
            share: 'disabled',
            permission: { '*': 'deny' },
            watcher: { ignore: ['**'] },
        }),
        { mode: 0o400 },
    );
    // В pinned 1.14.48 Npm.install сначала проверяет writable(dir); preseeded lock — вторая защита.
    await fs.chmod(path.join(profile.config, 'node_modules'), 0o500);
    await fs.chmod(profile.config, 0o500);
}

/** Перед очисткой возвращает права только собственному временному config directory. */
export async function removeProfile(profile: ProbeProfile): Promise<void> {
    await fs.chmod(profile.config, 0o700).catch(() => {});
    await fs.chmod(path.join(profile.config, 'node_modules'), 0o700).catch(() => {});
    await fs.rm(profile.root, { recursive: true, force: true });
}
