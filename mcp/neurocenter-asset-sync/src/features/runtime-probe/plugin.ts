import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Package } from '../../bridge/package.js';
import { readBoundedUtf8 } from '../../bridge/read-bounded.js';
import { assetKey } from '../../bridge/installation-receipt.js';
import { ProbeError } from './model.js';
import { configurePlugin, type ProbeProfile } from './profile.js';
import type { ProbeScope } from './process.js';
import { resolvePreparedRuntimeArtifact } from '../runtime-artifacts/cache.js';

/** Wrapper подтверждает только init; hooks намеренно не регистрируются в диагностическом OpenCode. */
function wrapperSource(entry: string, marker: string): string {
    return `import fs from 'node:fs/promises';
export default async function probe(input) {
    let state = 'failed';
    try {
        const mod = await import(${JSON.stringify(entry)});
        const value = mod.default;
        if (value && typeof value === 'object' && ('id' in value || 'server' in value || 'tui' in value)) {
            if (typeof value.id !== 'string' || !value.id.trim() || typeof value.server !== 'function' || value.tui !== undefined) throw new Error();
            await value.server(input, undefined);
        } else {
            const seen = new Set();
            if (!Object.keys(mod).length) throw new Error();
            for (const entry of Object.values(mod)) {
                if (seen.has(entry)) continue;
                seen.add(entry);
                const fn = typeof entry === 'function' ? entry : entry && typeof entry.server === 'function' ? entry.server : undefined;
                if (!fn) throw new Error();
                await fn(input, undefined);
            }
        }
        state = 'passed';
    } catch (error) {
        if (error && ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(error.code) || error instanceof Error && /Cannot find (?:package|module)/.test(error.message)) state = 'dependency-required';
    }
    await fs.writeFile(${JSON.stringify(marker)}, JSON.stringify({state}), {flag:'wx',mode:0o600});
    return {};
}
`;
}

export async function probePlugin(pkg: Package, profile: ProbeProfile, scope: ProbeScope, binary: string, authorize: () => Promise<void>): Promise<void> {
    const entrypoint = pkg.config?.entrypoint;
    const artifact=await resolvePreparedRuntimeArtifact(pkg);
    if (artifact ? artifact.executable || !/\.(?:[cm]?js|tsx?)$/i.test(artifact.entrypoint)
        : !entrypoint || !pkg.files.some(file => file.path === entrypoint) || !/\.(?:[cm]?js|tsx?)$/i.test(entrypoint)) {
        throw new ProbeError('unsupported', 'entrypoint-unsupported');
    }
    const marker = path.join(profile.root, `plugin-result-${assetKey(pkg)}.json`);
    const wrapper = path.join(profile.root, `probe-plugin-${assetKey(pkg)}.mjs`);
    await fs.writeFile(wrapper, wrapperSource(pathToFileURL(artifact?.entrypoint ?? path.join(profile.packageDirectory(pkg), entrypoint!)).href, marker));
    await configurePlugin(profile, wrapper);
    const exit = await scope.command(binary, ['debug', 'config'], profile.project, profile.env, authorize);
    if (exit.code !== 0) { throw new ProbeError('failed', 'plugin-initialization-failed'); }
    let state: unknown;
    try { state = (JSON.parse(await readBoundedUtf8(marker, 128)) as { state?: unknown }).state; }
    catch { throw new ProbeError('failed', 'plugin-initialization-failed'); }
    if (state === 'dependency-required') { throw new ProbeError('needs_configuration', 'dependency-required'); }
    if (state !== 'passed') { throw new ProbeError('failed', 'plugin-initialization-failed'); }
    if ((await fs.readdir(path.join(profile.config, 'node_modules'))).length) { throw new ProbeError('unsupported', 'dependency-required'); }
}
