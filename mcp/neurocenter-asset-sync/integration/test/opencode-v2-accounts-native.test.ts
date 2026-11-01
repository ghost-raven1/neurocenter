import { expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { AccountsEditor } from '../../src/features/opencode-local-providers/v2-accounts/editor.js';
import { AccountsClient } from '../../src/features/opencode-local-providers/v2-accounts/client.js';
import * as transport from '../../src/features/opencode-local-providers/v2-accounts/transport.js';
import { contract } from '../../src/features/opencode-local-providers/contract.js';
const binary = process.env.NEUROCENTER_TEST_OPENCODE_V2_BINARY;
/** Opt-in exact official binary; owns HOME, database, stdio lease and synthetic credentials. */
it.skipIf(!binary)(
    'actual V2 adapter adds and recovers accounts without replacing old credentials',
    async () => {
        expect(process.platform).toBe('darwin');
        expect(process.arch).toBe('arm64');
        for (const file of [
            '/Library/Application Support/opencode',
            `/Library/Managed Preferences/${os.userInfo().username}/ai.opencode.managed.plist`,
            '/Library/Managed Preferences/ai.opencode.managed.plist',
        ]) {
            await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' });
        }
        const executable = path.resolve(binary!);
        expect(
            createHash('sha256')
                .update(await fs.readFile(executable))
                .digest('hex'),
        ).toBe('149708831fbbc06ae4190af4c7d8e1c784eaa4d9ff5352d89d8bef06907d7405');
        const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nc-opencode-v2-native-')));
        await fs.chmod(root, 0o700);
        for (const name of ['home', 'config', 'data', 'state', 'cache', 'tmp', 'project'])
            await fs.mkdir(path.join(root, name), { mode: 0o700 });
        const password = randomBytes(32).toString('base64url');
        const environment = {
            PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
            HOME: path.join(root, 'home'),
            OPENCODE_TEST_HOME: path.join(root, 'home'),
            XDG_CONFIG_HOME: path.join(root, 'config'),
            XDG_DATA_HOME: path.join(root, 'data'),
            XDG_STATE_HOME: path.join(root, 'state'),
            XDG_CACHE_HOME: path.join(root, 'cache'),
            TMPDIR: path.join(root, 'tmp'),
            OPENCODE_CONFIG_DIR: path.join(root, 'config/opencode'),
            OPENCODE_DB: path.join(root, 'data/fixture.db'),
            OPENCODE_PASSWORD: password,
            OPENCODE_DISABLE_MODELS_FETCH: '1',
            OPENCODE_CONFIG_PROJECT_DISABLE: '1',
            OPENCODE_DISABLE_CLAUDE_CODE: '1',
            OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: '1',
            OPENCODE_DISABLE_FFF: '1',
            OPENCODE_FILEWATCHER_DISABLE: '1',
            NO_COLOR: '1',
        };
        const child = spawn(executable, ['serve', '--stdio', '--hostname', '127.0.0.1', '--port', '0'], {
            cwd: path.join(root, 'project'),
            env: environment,
            detached: true,
            stdio: ['pipe', 'pipe', 'ignore'],
        });
        const exited = once(child, 'exit');
        let leaseClosed = false;
        const originalRequest = transport.accountRequest;
        try {
            const url = await new Promise<string>((resolve, reject) => {
                let buffer = '',
                    bytes = 0;
                const timer = setTimeout(() => reject(Error('Owned fixture readiness timed out')), 30000);
                child.once('exit', () => {
                    clearTimeout(timer);
                    reject(Error('Owned fixture exited'));
                });
                child.stdout.on('data', (chunk: Buffer) => {
                    bytes += chunk.length;
                    if (bytes > 262144) {
                        clearTimeout(timer);
                        reject(Error('Readiness bound'));
                        return;
                    }
                    buffer += chunk.toString();
                    for (;;) {
                        const end = buffer.indexOf('\n');
                        if (end < 0) break;
                        const line = buffer.slice(0, end);
                        buffer = buffer.slice(end + 1);
                        try {
                            const value = JSON.parse(line);
                            if (typeof value.url === 'string') {
                                clearTimeout(timer);
                                resolve(value.url);
                            }
                        } catch {
                            /* Non-JSON startup line. */
                        }
                    }
                });
            });
            const file = path.join(root, 'state/opencode/service.json');
            await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
            await fs.writeFile(
                file,
                JSON.stringify({ id: 'owned-stdio-fixture', version: '2.2.2', url, pid: child.pid, password }),
                { mode: 0o600 },
            );
            const authorize = async () => {};
            const client = await AccountsClient.discover(environment.HOME, environment, 1048576);
            const make = () =>
                new AccountsEditor({
                    home: environment.HOME,
                    environment,
                    authorize,
                    assertCompatibleCli: async () => ({ assertCurrent: () => client.current() }),
                    limits: contract.globalProvidersLimits({}),
                });
            expect(await make().inventory()).toEqual({ accounts: [], issues: [] });
            const first = make(),
                firstPreview = await first.prepare({ providerId: 'anthropic', apiKey: 'owned-first-synthetic-key' });
            await first.save({ previewId: firstPreview.previewId });
            const activation = async () => {
                const raw = (await originalRequest(new URL('/api/credential', url), password, 1048576)) as {
                    data: Array<{ id: string; active: boolean }>;
                };
                return raw.data.filter((row) => row.active).map((row) => row.id);
            };
            expect(await activation()).toEqual([firstPreview.previewId]);
            let posts = 0;
            vi.spyOn(transport, 'accountRequest').mockImplementation(async (...args) => {
                const response = await originalRequest(...args);
                if (args[4] !== undefined) {
                    posts++;
                    throw Error('Owned deliberately discarded ACK');
                }
                return response;
            });
            const second = make(),
                secondPreview = await second.prepare({ providerId: 'anthropic', apiKey: 'owned-second-synthetic-key' });
            await second.save({ previewId: secondPreview.previewId });
            await make().resume({ intentId: secondPreview.previewId });
            expect(posts).toBe(1);
            vi.restoreAllMocks();
            const rows = await client.list();
            expect(rows).toHaveLength(2);
            expect(await activation()).toEqual([firstPreview.previewId]);
            expect(
                rows.find((row) => row.id === firstPreview.previewId)?.value.key === 'owned-first-synthetic-key',
            ).toBe(true);
            expect(
                rows.find((row) => row.id === secondPreview.previewId)?.value.key === 'owned-second-synthetic-key',
            ).toBe(true);
            expect(await make().inventory()).toEqual({
                accounts: [{ integrationId: 'anthropic', hasApiKey: true, hasOAuth: false, hasExternal: false }],
                issues: [],
            });
            // Cancelling the fixture's owned stdio lease must not leave a server process behind.
            child.stdin.end();
            leaseClosed = true;
            const exit = await Promise.race([
                exited,
                new Promise<never>((_, reject) => setTimeout(() => reject(Error('Lease cleanup timeout')), 10000)),
            ]);
            expect(exit[0]).toBe(0);
            expect(() => process.kill(-child.pid!, 0)).toThrow();
        } finally {
            vi.restoreAllMocks();
            vi.unstubAllGlobals();
            if (!leaseClosed) child.stdin.end();
            if (child.exitCode === null) {
                try {
                    process.kill(-child.pid!, 'SIGTERM');
                } catch {
                    /* Already gone. */
                }
                await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3000))]);
            }
            if (child.exitCode === null) {
                try {
                    process.kill(-child.pid!, 'SIGKILL');
                } catch {
                    /* Already gone. */
                }
                await exited;
            }
            await fs.rm(root, { recursive: true, force: true });
        }
    },
    60000,
);
