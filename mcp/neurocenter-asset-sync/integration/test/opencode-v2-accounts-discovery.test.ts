import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createServer, type Server } from 'node:http';
import { AccountsClient } from '../../src/features/opencode-local-providers/v2-accounts/client.js';
const roots: string[] = [],
    servers: Server[] = [];
afterEach(async () => {
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
    const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nc-v2-discovery-')));
    roots.push(home);
    const file = path.join(home, '.local/state/opencode/service.json');
    await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    let reads = 0,
        mode = 'normal';
    const server = createServer((req, res) => {
        if (req.headers.authorization !== 'Basic ' + Buffer.from('opencode:fixture-password').toString('base64')) {
            res.writeHead(401);
            res.end();
            return;
        }
        if (req.url === '/api/info') {
            res.end(JSON.stringify({ version: '2.2.2', pid: process.pid }));
            return;
        }
        reads++;
        if (mode === 'redirect') {
            res.writeHead(302, { Location: 'http://127.0.0.1:1/private' });
            res.end();
            return;
        }
        if (mode === 'large') {
            res.end('a'.repeat(20000));
            return;
        }
        if (mode === 'slow') return;
        res.end(JSON.stringify({ data: [] }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error();
    const registration = {
        id: 'owned',
        version: '2.2.2',
        url: `http://127.0.0.1:${address.port}`,
        pid: process.pid,
        password: 'fixture-password',
    };
    await fs.writeFile(file, JSON.stringify(registration), { mode: 0o600 });
    return {
        home,
        file,
        registration,
        reads: () => reads,
        mode: (value: string) => {
            mode = value;
        },
    };
}
it('accepts private regular registration and projects only the credential endpoint', async () => {
    const f = await fixture(),
        client = await AccountsClient.discover(f.home, {}, 16384);
    expect(await client.list()).toEqual([]);
    expect(f.reads()).toBe(1);
});
it.each(['symlink', 'hardlink', 'mode'])('rejects unsafe registry %s before credential reads', async (kind) => {
    const f = await fixture();
    if (kind === 'mode') await fs.chmod(f.file, 0o644);
    else {
        await fs.rename(f.file, f.file + '.original');
        if (kind === 'symlink') await fs.symlink(f.file + '.original', f.file);
        else await fs.link(f.file + '.original', f.file);
    }
    await expect(AccountsClient.discover(f.home, {}, 16384)).rejects.toThrow();
    expect(f.reads()).toBe(0);
});
it('detects registry replacement before reading credentials', async () => {
    const f = await fixture(),
        client = await AccountsClient.discover(f.home, {}, 16384);
    await fs.writeFile(f.file, JSON.stringify({ ...f.registration, id: 'replacement' }));
    await expect(client.list()).rejects.toThrow();
    expect(f.reads()).toBe(0);
});
it.each(['redirect', 'large'])('bounds unsafe API response %s', async (mode) => {
    const f = await fixture(),
        client = await AccountsClient.discover(f.home, {}, 16384);
    f.mode(mode);
    await expect(client.list()).rejects.toThrow();
    expect(f.reads()).toBe(1);
});
it('cancels an outstanding credential request without leaving an active mutation', async () => {
    const f = await fixture(),
        controller = new AbortController(),
        client = await AccountsClient.discover(f.home, {}, 16384, controller.signal);
    f.mode('slow');
    const pending = client.list();
    controller.abort();
    await expect(pending).rejects.toThrow();
});
