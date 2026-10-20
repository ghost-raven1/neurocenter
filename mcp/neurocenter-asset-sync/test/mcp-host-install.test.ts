import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { artifactFixture } from '../../../scripts/test/runtime-artifact-fixture.cjs';
import { ensureRuntimeArtifact } from '../src/features/runtime-artifacts/cache.js';
import { runtimeArtifactTarget } from '../src/features/runtime-artifacts/model.js';
import { canonicalV4, verify, type Package } from '../src/bridge/package.js';
import { hash, stateDir, writeState } from '../src/bridge/state.js';
import { bindProject, setRoot } from '../src/bridge/workspace.js';
import { install } from '../src/bridge/installer.js';
import { inspectInstallation } from '../src/bridge/installation-inspection.js';
import { InstallationPlan } from '../src/bridge/installation-plan.js';
import { planInstall } from '../src/bridge/installation-planner.js';
import { receiptPath } from '../src/bridge/installation-receipt.js';
import { isHostedMcpUrl, hostedMcpPath } from '../src/features/mcp-host/connect.js';

const TICKET = Buffer.from(JSON.stringify({ v: 1 })).toString('base64url') + '.sig';
const folders: string[] = [];
const servers: Array<http.Server | net.Server> = [];

interface MockHub extends http.Server { port: number; seen: { connect: number; channel: number } }
const startHub = (options: { connectStatus?: number; channelStatus?: number } = {}): Promise<MockHub> =>
    new Promise(resolve => {
        const seen = { connect: 0, channel: 0 };
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                if (req.method === 'POST' && req.url === '/api/mcp-host/connect') {
                    seen.connect += 1;
                    const status = options.connectStatus ?? 200;
                    res.writeHead(status, { 'content-type': 'application/json' });
                    res.end(status === 200 ? JSON.stringify({ path: `/api/mcp-host/m/${TICKET}` }) : JSON.stringify({ message: 'refused' }));
                    return;
                }
                if (req.method === 'POST' && req.url === `/api/mcp-host/m/${TICKET}`) {
                    seen.channel += 1;
                    const status = options.channelStatus ?? 200;
                    if (status !== 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32603, message: 'host down' }, id: null })); return; }
                    const message = JSON.parse(body) as { method?: string; id?: number };
                    res.writeHead(200, { 'content-type': 'application/json' });
                    if (message.method === 'initialize') {
                        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } } }));
                        return;
                    }
                    if (message.method === 'tools/list') {
                        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'fixture', description: 'd', inputSchema: { type: 'object' } }] } }));
                        return;
                    }
                    res.end();
                    return;
                }
                res.writeHead(404); res.end();
            });
        }) as MockHub;
        server.listen(0, '127.0.0.1', () => {
            server.port = (server.address() as net.AddressInfo).port;
            server.seen = seen;
            resolve(server);
        });
    });

/** Привязка выполняется уже под URL площадки: stateDir завязан на хаб, менять его запрещено. */
const hostedFixture = async (hubUrl: string) => {
    const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-hosted-')));
    folders.push(temporary);
    vi.stubEnv('NEUROCENTER_BRIDGE_HOME', path.join(temporary, 'private'));
    vi.stubEnv('NEUROCENTER_URL', hubUrl);
    const root = path.join(temporary, 'projects', 'hosted project');
    await fs.mkdir(root, { recursive: true });
    await setRoot(path.dirname(root));
    await bindProject('test-project', path.basename(root));
    await writeState('credentials', { token: '0'.repeat(64), deviceId: randomUUID(), email: 'fixture@example.test' });
    return { temporary, root };
};

const pkgFor = (descriptor: ReturnType<typeof artifactFixture>['descriptor'], version: number, hosted: boolean): Package => {
    const pkg: Package = {
        schemaVersion: 5,
        plugin: { id: 'ai-plug-hosted', name: 'hosted-mcp', kind: 'mcp', version },
        config: { transport: 'local', extra: { runtimeArtifacts: [descriptor], ...(hosted ? { hostedMcp: true } : {}) } },
        files: [],
        manifest: { sha256: '', filesCount: 0 },
    };
    pkg.manifest.sha256 = hash(JSON.stringify(canonicalV4({ schemaVersion: pkg.schemaVersion, plugin: pkg.plugin, config: pkg.config, files: [] })));
    return pkg;
};

const noOp = async () => undefined;
const installFor = (root: string) => install.bind(null, 'test-project');

afterEach(async () => {
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
    for (const folder of folders.splice(0)) { await fs.rm(folder, { recursive: true, force: true }); }
    void installFor;
});

describe('Управляемый MCP на хосте площадки', () => {
    it('Свежая установка: канал в конфигурации, локальный кэш не скачивается, канал подтверждён', async () => {
        const hub = await startHub(); servers.push(hub);
        const f = await hostedFixture(`http://127.0.0.1:${hub.port}`);
        const { descriptor } = artifactFixture(undefined, runtimeArtifactTarget());
        const pkg = pkgFor(descriptor, 1, true); verify(pkg);
        await install('test-project', pkg, noOp, noOp);
        const url = `http://127.0.0.1:${hub.port}/api/mcp-host/m/${TICKET}`;
        const receipt = JSON.parse(await fs.readFile(path.join(f.root, receiptPath(pkg)), 'utf8'));
        expect(receipt.config.value).toEqual({ type: 'remote', enabled: true, url });
        const config = JSON.parse(await fs.readFile(path.join(f.root, 'opencode.json'), 'utf8'));
        expect(config.mcp['neurocenter-hosted-mcp']).toEqual({ type: 'remote', enabled: true, url });
        expect(await fs.readdir(path.join(stateDir(), 'runtime-artifacts')).catch(() => null)).toBeNull();
        expect(hub.seen.connect).toBe(1);
        expect(hub.seen.channel).toBeGreaterThanOrEqual(2);
        expect((await inspectInstallation('test-project', pkg)).status).toBe('synced');
    });

    it('Повторная установка не переподключает живой канал', async () => {
        const hub = await startHub(); servers.push(hub);
        const f = await hostedFixture(`http://127.0.0.1:${hub.port}`);
        const { descriptor } = artifactFixture(undefined, runtimeArtifactTarget());
        const pkg = pkgFor(descriptor, 1, true); verify(pkg);
        await install('test-project', pkg, noOp, noOp);
        await install('test-project', pkg, noOp, noOp);
        expect(hub.seen.connect).toBe(1);
        const receipt = JSON.parse(await fs.readFile(path.join(f.root, receiptPath(pkg)), 'utf8'));
        expect(receipt.config.value.url).toBe(`http://127.0.0.1:${hub.port}/api/mcp-host/m/${TICKET}`);
    });

    it('Локальная установка мигрирует на хост при появлении флага', async () => {
        const hub = await startHub(); servers.push(hub);
        const f = await hostedFixture(`http://127.0.0.1:${hub.port}`);
        const { archive, descriptor } = artifactFixture(undefined, runtimeArtifactTarget());
        const first = pkgFor(descriptor, 1, false); verify(first);
        await ensureRuntimeArtifact(first, { download: async () => Readable.from([archive]) });
        await install('test-project', first, noOp, noOp);
        const localReceipt = JSON.parse(await fs.readFile(path.join(f.root, receiptPath(first)), 'utf8'));
        expect(localReceipt.config.value.type).toBe('local');
        const next = pkgFor(descriptor, 2, true); verify(next);
        await install('test-project', next, noOp, noOp);
        const config = JSON.parse(await fs.readFile(path.join(f.root, 'opencode.json'), 'utf8'));
        const entries = Object.values(config.mcp) as Array<Record<string, unknown>>;
        expect(entries).toEqual([{ type: 'remote', enabled: true, url: `http://127.0.0.1:${hub.port}/api/mcp-host/m/${TICKET}` }]);
        expect(hub.seen.connect).toBe(1);
    });

    it('Отказ площадки останавливает установку без изменений проекта', async () => {
        const hub = await startHub({ connectStatus: 403 }); servers.push(hub);
        const f = await hostedFixture(`http://127.0.0.1:${hub.port}`);
        const { descriptor } = artifactFixture(undefined, runtimeArtifactTarget());
        const pkg = pkgFor(descriptor, 1, true); verify(pkg);
        const before = await fs.readFile(path.join(f.root, 'opencode.json'), 'utf8').catch(() => null);
        await expect(install('test-project', pkg, noOp, noOp)).rejects.toThrow(/не разрешил/);
        expect(await fs.readFile(path.join(f.root, 'opencode.json'), 'utf8').catch(() => null)).toBe(before);
        await expect(fs.stat(path.join(f.root, receiptPath(pkg)))).rejects.toThrow();
    });

    it('Неподтверждённый канал не фиксирует файлы и конфигурацию', async () => {
        const hub = await startHub({ channelStatus: 500 }); servers.push(hub);
        const f = await hostedFixture(`http://127.0.0.1:${hub.port}`);
        const { descriptor } = artifactFixture(undefined, runtimeArtifactTarget());
        const pkg = pkgFor(descriptor, 1, true); verify(pkg);
        const before = await fs.readFile(path.join(f.root, 'opencode.json'), 'utf8').catch(() => null);
        await expect(install('test-project', pkg, noOp, noOp)).rejects.toThrow(/хост/i);
        expect(await fs.readFile(path.join(f.root, 'opencode.json'), 'utf8').catch(() => null)).toBe(before);
        await expect(fs.stat(path.join(f.root, receiptPath(pkg)))).rejects.toThrow();
    });

    it('Восстановление повторяет сохранённый канал, не запрашивая новый билет', async () => {
        const hub = await startHub(); servers.push(hub);
        const f = await hostedFixture(`http://127.0.0.1:${hub.port}`);
        const { descriptor } = artifactFixture(undefined, runtimeArtifactTarget());
        const pkg = pkgFor(descriptor, 1, true); verify(pkg);
        await install('test-project', pkg, noOp, noOp);
        const second = new InstallationPlan(f.root);
        let requested = 0;
        await planInstall(second, pkg, {
            repair: true,
            hostedMcp: async () => { requested += 1; return '/api/mcp-host/m/other'; },
        });
        expect(requested).toBe(0);
        const text = await second.read('opencode.json');
        expect(text).toContain(`http://127.0.0.1:${hub.port}/api/mcp-host/m/${TICKET}`);
    });

    it('Билет с чужого хоста и битый канал отклоняются распознавателем', () => {
        vi.stubEnv('NEUROCENTER_URL', 'http://localhost:5173');
        expect(hostedMcpPath('/api/mcp-host/m/' + TICKET)).toBe(true);
        expect(hostedMcpPath('/api/mcp-host/m/..%2fescape')).toBe(false);
        expect(isHostedMcpUrl('http://localhost:5173/api/mcp-host/m/' + TICKET)).toBe(true);
        expect(isHostedMcpUrl('http://other.example/api/mcp-host/m/' + TICKET)).toBe(false);
        expect(isHostedMcpUrl('http://localhost:5173/api/mcp-host/m/x')).toBe(false);
    });
});
