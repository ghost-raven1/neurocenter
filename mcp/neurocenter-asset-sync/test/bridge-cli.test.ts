import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { installBridgeCommand, runBridgeCli } from '../src/bridge/cli.js';
import { api, apiHub, authorizedFetch, hub, stateDir, writeState } from '../src/bridge/state.js';

const folders: string[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); await Promise.all(folders.splice(0).map(folder => fs.rm(folder, { recursive: true, force: true }))); });
async function fixture() {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'nc-bridge-cli-')); folders.push(folder);
    const settingsPath = path.join(folder, 'installation.json');
    await fs.writeFile(settingsPath, JSON.stringify({ schemaVersion: 1, siteUrl: 'https://panel.example.test', apiUrl: 'https://gateway.example.test' }));
    vi.stubEnv('NEUROCENTER_URL', ''); vi.stubEnv('NEUROCENTER_API_URL', '');
    return { folder, settingsPath, write: vi.fn(), connect: vi.fn(async () => ({ connected: true as const, deviceId: 'qa-computer', note: 'saved' })) };
}
describe('Installed command keeps private identity and Gateway transport', () => {
    it('loads saved site/API once and requests browser confirmation without duplicate registration', async () => {
        const f = await fixture(); await runBridgeCli(['connect', '--open'], f);
        expect(hub()).toBe('https://panel.example.test'); expect(apiHub()).toBe('https://gateway.example.test');
        expect(f.connect).toHaveBeenCalledExactlyOnceWith(true, false);
        expect(f.write.mock.calls.join('')).toContain('Существующее подключение сохранено');
        await runBridgeCli(['connect', '--open', '--reconnect'], f); expect(f.connect).toHaveBeenLastCalledWith(true, true);
    });
    it.each([['connect', '--wrong'], ['connect', '--open', '--open'], ['unknown'], ['--install-command', 'extra']])('rejects invalid arguments %s before connecting', async (...args) => {
        const f = await fixture(); await expect(runBridgeCli(args, f)).rejects.toThrow(); expect(f.connect).not.toHaveBeenCalled();
    });
    it.each([{ schemaVersion: 2 }, { schemaVersion: 1, siteUrl: 'https://user:secret@example.test', apiUrl: 'https://api.test' }, { schemaVersion: 1, siteUrl: 'https://panel.example.test', apiUrl: 'https://api.test/path' }])('rejects incomplete or unsafe persisted settings without a provider call', async value => {
        const f = await fixture(); await fs.writeFile(f.settingsPath, JSON.stringify(value)); await expect(runBridgeCli(['connect'], f)).rejects.toThrow(); expect(f.connect).not.toHaveBeenCalled();
    });
    it('missing settings gives an installation action, help/version do not need configuration', async () => {
        const f = await fixture(); await fs.rm(f.settingsPath);
        await expect(runBridgeCli(['connect'], f)).rejects.toThrow(/Повторите установку/);
        await runBridgeCli(['--help'], f); await runBridgeCli(['--version'], f); expect(f.connect).not.toHaveBeenCalled();
    });
    it('routes API and authorized downloads through Gateway while preserving the old state namespace', async () => {
        const f = await fixture(); vi.stubEnv('NEUROCENTER_URL', 'https://panel.example.test'); vi.stubEnv('NEUROCENTER_BRIDGE_HOME', f.folder);
        const previous = stateDir(); await writeState('credentials', { token: 'qa-private-token', deviceId: 'one', email: 'qa@test' });
        vi.stubEnv('NEUROCENTER_API_URL', 'https://gateway.example.test'); expect(stateDir()).toBe(previous);
        const fetch = vi.fn(async () => new Response('{}', { status: 200 })); vi.stubGlobal('fetch', fetch);
        await api('identity'); await authorizedFetch('/api/runtime-artifacts/item');
        expect(fetch.mock.calls.map(call => call[0])).toEqual(['https://gateway.example.test/api/device-channel/identity', 'https://gateway.example.test/api/runtime-artifacts/item']);
        expect(fetch.mock.calls[1]![1]!.headers).toHaveProperty('authorization', 'Bearer qa-private-token');
        vi.stubEnv('NEUROCENTER_API_URL', 'https://user:secret@gateway.example.test'); expect(() => apiHub()).toThrow();
    });
    it('installs a quoted standalone wrapper in a custom folder and preserves another program', async () => {
        const f = await fixture(); vi.stubEnv('NEUROCENTER_URL', 'https://panel.example.test'); vi.stubEnv('NEUROCENTER_API_URL', 'https://gateway.example.test');
        const root = path.join(f.folder, "мост с ' кавычкой"), bin = path.join(f.folder, 'commands');
        await fs.mkdir(path.join(root, 'bin'), { recursive: true }); await fs.mkdir(path.join(root, 'dist'));
        await fs.writeFile(path.join(root, 'dist/bridge-cli.js'), '// fixture');
        await fs.writeFile(path.join(root, 'bin/node'), '#!/bin/sh\nprintf \'%s\\n\' "$@"\n', { mode: 0o755 });
        const command = await installBridgeCommand({ directory: root, binDirectory: bin });
        const output = spawnSync(command, ['connect', '--open', '--reconnect'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
        expect(output.status, output.stderr).toBe(0); expect(output.stdout.trim().split('\n')).toEqual([path.join(root, 'dist/bridge-cli.js'), 'connect', '--open', '--reconnect']);
        expect((await fs.stat(path.join(root, 'installation.json'))).mode & 0o777).toBe(0o600);
        expect((await fs.stat(command)).mode & 0o777).toBe(0o755);
        expect(await installBridgeCommand({ directory: root, binDirectory: bin })).toBe(command);
        await fs.rm(path.join(root, 'bin/node'));
        const missing = spawnSync(command, ['connect'], { encoding: 'utf8' }); expect(missing.status).toBe(1); expect(missing.stderr).toContain('Повторите установку');
        await fs.writeFile(command, '#!/bin/sh\necho another-program');
        await expect(installBridgeCommand({ directory: root, binDirectory: bin })).rejects.toThrow(/занята/);
        expect(await fs.readFile(command, 'utf8')).toContain('another-program');
    });
    it('Windows wrapper disables delayed expansion and quotes standalone paths', async () => {
        const f = await fixture(); vi.stubEnv('NEUROCENTER_URL', 'https://panel.example.test');
        const command = await installBridgeCommand({ directory: f.folder, binDirectory: f.folder, windows: true });
        expect(command).toMatch(/\.cmd$/); const source = await fs.readFile(command, 'utf8');
        expect(source).toContain('setlocal DisableDelayedExpansion'); expect(source).toContain('if not exist'); expect(source).toContain('" %*');
    });
});
