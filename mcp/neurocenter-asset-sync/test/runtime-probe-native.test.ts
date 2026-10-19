import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runRuntimeProbe } from '../src/features/runtime-probe/index.js';
import { ProbeScope } from '../src/features/runtime-probe/process.js';
import { createProfile, removeProfile } from '../src/features/runtime-probe/profile.js';
import { probePlugin } from '../src/features/runtime-probe/plugin.js';
import { hash } from '../src/bridge/state.js';
import { workspaceFixture } from './bridge-fixture.js';
import { noop, probeInput, probePackage, snapshot } from './runtime-probe-fixture.js';

const binary = process.env.NEUROCENTER_TEST_OPENCODE_PATH;
describe.runIf(Boolean(binary) && process.platform !== 'win32')('Настоящий pinned OpenCode 1.14.48 в отдельном профиле', () => {
    let fixture: Awaited<ReturnType<typeof workspaceFixture>>;
    let engine: { path: string; version: '1.14.48'; sha256: string };
    beforeEach(async () => {
        fixture = await workspaceFixture();
        engine = { path: binary!, version: '1.14.48', sha256: hash(await fs.readFile(binary!)) };
    });
    afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(fixture.temporary, { recursive: true, force: true }); });

    it('Инициализирует настоящий plugin, не выполняя его config/event hooks и не меняя проект', async () => {
        const marker = path.join(fixture.temporary, 'HOOK_НЕ_ДОЛЖЕН_ВЫПОЛНИТЬСЯ');
        const pkg = probePackage('plugin', `import fs from 'node:fs';
export default {id:'test-probe',server:async(input)=>{
if(!input.directory.includes('neurocenter-runtime-probe-')||process.env.OPENAI_API_KEY)throw new Error('Чужой профиль');
console.log('СЕКРЕТНЫЙ_ЛОГ_ПЛАГИНА');
return {config(){fs.writeFileSync(${JSON.stringify(marker)},'config')},event(){fs.writeFileSync(${JSON.stringify(marker)},'event')}};
}};`);
        vi.stubEnv('OPENAI_API_KEY', 'ЛИЧНЫЙ_КЛЮЧ_НЕЛЬЗЯ_НАСЛЕДОВАТЬ');
        const input = await probeInput(pkg, engine); const before = await snapshot(fixture.temporary);
        const result = await runRuntimeProbe(input);
        expect(result).toMatchObject({ status: 'passed', code: 'verified', engineVersion: '1.14.48', engineSha256: engine.sha256,
            counts: { packages: 1, pluginsInitialized: 1, mcp: 0, skills: 0 } });
        await expect(fs.access(marker)).rejects.toThrow(); expect(await snapshot(fixture.temporary)).toEqual(before);
        for (const secret of [fixture.temporary, 'СЕКРЕТНЫЙ_ЛОГ_ПЛАГИНА', 'ЛИЧНЫЙ_КЛЮЧ_НЕЛЬЗЯ_НАСЛЕДОВАТЬ']) { expect(JSON.stringify(result)).not.toContain(secret); }
    }, 20_000);
    it('Не принимает exit 0 OpenCode за успешную инициализацию plugin с исключением', async () => {
        const pkg = probePackage('plugin', `export default async()=>{throw new Error('СЕКРЕТ_ИСКЛЮЧЕНИЯ')}`);
        const result = await runRuntimeProbe(await probeInput(pkg, engine));
        expect(result).toMatchObject({ status: 'failed', code: 'plugin-initialization-failed', counts: { pluginsInitialized: 0 } });
        expect(JSON.stringify(result)).not.toContain('СЕКРЕТ_ИСКЛЮЧЕНИЯ');
    }, 20_000);
    it('Отсутствующая npm зависимость не устанавливается: registry tripwire получает ноль запросов', async () => {
        let registryRequests = 0;
        const registry = http.createServer((_request, response) => { registryRequests++; response.writeHead(500); response.end(); });
        registry.listen(0, '127.0.0.1'); await once(registry, 'listening');
        const scope = new ProbeScope();
        const pkg = probePackage('plugin', `import absent from '@neurocenter/runtime-probe-does-not-exist';export default async()=>({});`);
        const profile = await createProfile([pkg], scope);
        const packageLock = await fs.readFile(path.join(profile.config, 'package-lock.json'));
        try {
            const url = `http://127.0.0.1:${(registry.address() as { port: number }).port}`;
            profile.env.NPM_CONFIG_REGISTRY = url; profile.env.npm_config_registry = url;
            await fs.writeFile(path.join(profile.config, '.npmrc'), `registry=${url}\noffline=true\nignore-scripts=true\n`);
            await expect(probePlugin(pkg, profile, scope, binary!, noop)).rejects.toMatchObject({ status: 'needs_configuration', code: 'dependency-required' });
            expect(registryRequests).toBe(0);
            expect(await fs.readdir(path.join(profile.config, 'node_modules'))).toEqual([]);
            expect(await fs.readdir(path.join(profile.root, 'node_modules'))).toEqual([]);
            expect(await fs.readFile(path.join(profile.config, 'package-lock.json'))).toEqual(packageLock);
            await expect(fs.access(path.join(profile.root, 'npm-cache'))).rejects.toThrow();
            await expect(fs.access(path.join(profile.root, 'bun-cache'))).rejects.toThrow();
        } finally {
            scope.close(); await removeProfile(profile);
            registry.closeAllConnections(); await new Promise<void>(resolve => registry.close(() => resolve()));
        }
    }, 20_000);
});
