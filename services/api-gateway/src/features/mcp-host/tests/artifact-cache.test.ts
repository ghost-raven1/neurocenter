import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { materializeArtifact } from '../artifact-cache';
import type { IHostedMcpClaim } from '../ticket';

const TOKEN = 'qa-internal-token';

/** USTAR-одиночник: тот же формат, что валидирует shared/runtime/archive.cjs (production-runtime-artifact.fixture.mjs). */
function archiveFile(name: string, bytes: Buffer): Buffer {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    const octal = (value: number, start: number, length: number) =>
        header.write(value.toString(8).padStart(length - 1, '0') + '\0', start, length, 'ascii');
    octal(0o644, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(bytes.length, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.write(
        header
            .reduce((sum, byte) => sum + byte, 0)
            .toString(8)
            .padStart(6, '0') + '\0 ',
        148,
        8,
        'ascii',
    );
    return gzipSync(
        Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512), Buffer.alloc(1024)]),
    );
}

interface IArtifactFixture {
    archive: Buffer;
    sha256: string;
    compressedBytes: number;
    unpackedBytes: number;
}

function makeArtifact(content: string, name = 'runtime/index.mjs'): IArtifactFixture {
    const bytes = Buffer.from(content, 'utf8');
    const archive = archiveFile(name, bytes);
    return {
        archive,
        sha256: createHash('sha256').update(archive).digest('hex'),
        compressedBytes: archive.length,
        unpackedBytes: bytes.length,
    };
}

interface IQuotaLedger {
    used: number;
    limit: number;
}

interface ICatalogState {
    archives: Map<string, Buffer>;
    downloads: number;
    failDownloads: boolean;
    quotaStatus: number;
    quotas: Map<string, IQuotaLedger>;
    deltas: Array<{ projectId: string; dimension: string; deltaBytes: number; requestKey: string }>;
}

function startCatalog(): Promise<{ url: string; close: () => Promise<void>; state: ICatalogState }> {
    const state: ICatalogState = {
        archives: new Map(),
        downloads: 0,
        failDownloads: false,
        quotaStatus: 200,
        quotas: new Map(),
        deltas: [],
    };
    const server = createServer((req, res) => {
        if (req.headers['x-neurocenter-internal'] !== TOKEN) {
            res.writeHead(403).end();
            return;
        }
        const artifact = /^\/internal\/mcp-host\/artifact\/([a-f0-9]{64})$/.exec(req.url ?? '');
        if (artifact) {
            const bytes = state.archives.get(artifact[1]);
            if (!bytes || state.failDownloads) {
                res.writeHead(500).end();
                return;
            }
            state.downloads += 1;
            res.writeHead(200, { 'content-type': 'application/gzip' });
            res.end(bytes);
            return;
        }
        const quota = /^\/internal\/projects\/([^/]+)\/quota-usage$/.exec(req.url ?? '');
        if (quota) {
            if (state.quotaStatus !== 200) {
                res.writeHead(state.quotaStatus).end();
                return;
            }
            const projectId = decodeURIComponent(quota[1]);
            const ledger = state.quotas.get(projectId) ?? { used: 0, limit: 0 };
            if (req.method === 'GET') {
                res.writeHead(200, { 'content-type': 'application/json' });
                res.end(
                    JSON.stringify({
                        used: { current: ledger.used, retention: 0, staging: 0 },
                        limits: { current: ledger.limit, retention: 0, staging: 0 },
                    }),
                );
                return;
            }
            if (req.method === 'POST') {
                let raw = '';
                req.on('data', (chunk) => (raw += chunk));
                req.on('end', () => {
                    const body = JSON.parse(raw || '{}') as {
                        dimension?: string;
                        deltaBytes?: number;
                        request_key?: string;
                    };
                    ledger.used = Math.max(0, ledger.used + Number(body.deltaBytes ?? 0));
                    state.quotas.set(projectId, ledger);
                    state.deltas.push({
                        projectId,
                        dimension: String(body.dimension ?? ''),
                        deltaBytes: Number(body.deltaBytes ?? 0),
                        requestKey: String(body.request_key ?? ''),
                    });
                    res.writeHead(200, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ used: ledger.used }));
                });
                return;
            }
            res.writeHead(405).end();
            return;
        }
        res.writeHead(404).end();
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            if (typeof address !== 'object' || !address) throw new Error('Нет адреса тестового каталога.');
            resolve({
                url: `http://127.0.0.1:${address.port}`,
                state,
                close: () =>
                    new Promise<void>((done) => {
                        server.close(() => done());
                        server.closeAllConnections?.();
                    }),
            });
        });
    });
}

function claim(artifact: IArtifactFixture, projectId?: string): IHostedMcpClaim {
    const base: IHostedMcpClaim = {
        artifactSha256: artifact.sha256,
        entrypoint: 'runtime/index.mjs',
        executable: false,
        name: 'QA-хост',
        compressedBytes: artifact.compressedBytes,
        unpackedBytes: artifact.unpackedBytes,
        filesCount: 1,
        exp: Date.now() + 60000,
    };
    if (!projectId) return base;
    return {
        ...base,
        session: {
            deviceId: randomUUID(),
            projectId,
            assetId: randomUUID(),
            version: 1,
            manifest: createHash('sha256').update('fixture').digest('hex'),
        },
    };
}

const metaPath = (cacheDir: string, sha: string): string => path.join(cacheDir, 'artifacts', sha, '.meta');
async function readMeta(cacheDir: string, sha: string): Promise<{ projectId: string; lastAccess: number; bytes: number }> {
    return JSON.parse(await readFile(metaPath(cacheDir, sha), 'utf8')) as {
        projectId: string;
        lastAccess: number;
        bytes: number;
    };
}
async function setLastAccess(cacheDir: string, sha: string, lastAccess: number): Promise<void> {
    const meta = await readMeta(cacheDir, sha);
    // meta лежит с mode 0o400 (read-only): пересоздаём, как это делает touch() в production.
    await rm(metaPath(cacheDir, sha), { force: true });
    await writeFile(metaPath(cacheDir, sha), JSON.stringify({ ...meta, lastAccess }), { mode: 0o400 });
}
const entrypointExists = (cacheDir: string, sha: string): Promise<boolean> =>
    stat(path.join(cacheDir, 'artifacts', sha, 'runtime', 'index.mjs')).then(() => true, () => false);
const metaExists = (cacheDir: string, sha: string): Promise<boolean> => stat(metaPath(cacheDir, sha)).then(
    () => true,
    () => false,
);

let cacheDir: string;
let catalog: Awaited<ReturnType<typeof startCatalog>>;

beforeEach(async () => {
    cacheDir = await mkdtemp(path.join(process.cwd(), '.cache-lru-'));
    catalog = await startCatalog();
    process.env.NEUROCENTER_MCP_HOST_DIR = cacheDir;
});

afterEach(async () => {
    await catalog.close();
    await rm(cacheDir, { recursive: true, force: true });
    delete process.env.NEUROCENTER_MCP_HOST_DIR;
    vi.unstubAllEnvs();
});

describe('artifact cache LRU-квота (AD-D2)', () => {
    it('эвикционирует комплект с самым старым доступом при превышении лимита', async () => {
        const a = makeArtifact('A'.repeat(70)),
            b = makeArtifact('B'.repeat(70));
        catalog.state.archives.set(a.sha256, a.archive);
        catalog.state.archives.set(b.sha256, b.archive);
        catalog.state.quotas.set('p1', { used: 0, limit: 100 });

        await materializeArtifact(claim(a, 'p1'), catalog.url, TOKEN);
        expect(catalog.state.quotas.get('p1')?.used).toBe(70);
        // A становится «старым» по доступу; B строится позже и превышает лимит.
        await setLastAccess(cacheDir, a.sha256, Date.now() - 100000);
        await materializeArtifact(claim(b, 'p1'), catalog.url, TOKEN);

        // used 140 > 100 → эвикция самого старого (A) до лимита; B остаётся.
        expect(await entrypointExists(cacheDir, a.sha256)).toBe(false);
        expect(await entrypointExists(cacheDir, b.sha256)).toBe(true);
        expect(catalog.state.quotas.get('p1')?.used).toBe(70);
        expect(catalog.state.deltas.map((d) => d.deltaBytes)).toEqual([70, 70, -70]);
        expect(catalog.state.deltas.every((d) => d.dimension === 'current')).toBe(true);
        // Новый файл доступен через materialize (кэш-хит без докачки).
        await materializeArtifact(claim(b, 'p1'), catalog.url, TOKEN);
        expect(await entrypointExists(cacheDir, b.sha256)).toBe(true);
    });

    it('materialize обновляет lastAccess и меняет порядок эвикции', async () => {
        const a = makeArtifact('A'.repeat(70)),
            b = makeArtifact('B'.repeat(70)),
            c = makeArtifact('C'.repeat(70));
        for (const item of [a, b, c]) catalog.state.archives.set(item.sha256, item.archive);
        catalog.state.quotas.set('p1', { used: 0, limit: 200 });

        await materializeArtifact(claim(a, 'p1'), catalog.url, TOKEN);
        await materializeArtifact(claim(b, 'p1'), catalog.url, TOKEN);
        // Без touch старше был бы B; touch B делает старше A.
        await setLastAccess(cacheDir, a.sha256, Date.now() - 50000);
        await setLastAccess(cacheDir, b.sha256, Date.now() - 100000);
        await materializeArtifact(claim(b, 'p1'), catalog.url, TOKEN);
        const touched = (await readMeta(cacheDir, b.sha256)).lastAccess;
        expect(touched).toBeGreaterThan(Date.now() - 1000);

        // used 210 > 200 → эвикционируется A (старший после touch), B остаётся.
        await materializeArtifact(claim(c, 'p1'), catalog.url, TOKEN);
        expect(await entrypointExists(cacheDir, a.sha256)).toBe(false);
        expect(await entrypointExists(cacheDir, b.sha256)).toBe(true);
        expect(await entrypointExists(cacheDir, c.sha256)).toBe(true);
        expect(catalog.state.quotas.get('p1')?.used).toBe(140);
    });

    it('limit=0 — безлимит (AD-D4): эвикция не вызывается', async () => {
        const a = makeArtifact('A'.repeat(70)),
            b = makeArtifact('B'.repeat(70));
        for (const item of [a, b]) catalog.state.archives.set(item.sha256, item.archive);
        catalog.state.quotas.set('p1', { used: 0, limit: 0 });

        await materializeArtifact(claim(a, 'p1'), catalog.url, TOKEN);
        await materializeArtifact(claim(b, 'p1'), catalog.url, TOKEN);

        expect(await entrypointExists(cacheDir, a.sha256)).toBe(true);
        expect(await entrypointExists(cacheDir, b.sha256)).toBe(true);
        expect(catalog.state.deltas.map((d) => d.deltaBytes)).toEqual([70, 70]);
        expect(catalog.state.quotas.get('p1')?.used).toBe(140);
    });

    it('эвикция не трогает комплекты чужого проекта', async () => {
        const a = makeArtifact('A'.repeat(70)),
            b = makeArtifact('B'.repeat(70)),
            c = makeArtifact('C'.repeat(70));
        for (const item of [a, b, c]) catalog.state.archives.set(item.sha256, item.archive);
        catalog.state.quotas.set('p1', { used: 0, limit: 100 });
        catalog.state.quotas.set('p2', { used: 0, limit: 0 });

        await materializeArtifact(claim(a, 'p1'), catalog.url, TOKEN);
        await materializeArtifact(claim(b, 'p2'), catalog.url, TOKEN);
        await setLastAccess(cacheDir, a.sha256, Date.now() - 100000);
        await materializeArtifact(claim(c, 'p1'), catalog.url, TOKEN);

        // used(p1) 140 > 100 → уходит только A (p1); B (p2) на месте.
        expect(await entrypointExists(cacheDir, a.sha256)).toBe(false);
        expect(await entrypointExists(cacheDir, b.sha256)).toBe(true);
        expect(await entrypointExists(cacheDir, c.sha256)).toBe(true);
        expect(catalog.state.quotas.get('p1')?.used).toBe(70);
        expect(catalog.state.quotas.get('p2')?.used).toBe(70);
    });

    it('content-addressing: два проекта, один физический файл, дельта каждому построившему', async () => {
        const x = makeArtifact('X'.repeat(70)),
            y = makeArtifact('Y'.repeat(70));
        for (const item of [x, y]) catalog.state.archives.set(item.sha256, item.archive);
        catalog.state.quotas.set('p1', { used: 0, limit: 100 });
        catalog.state.quotas.set('p2', { used: 0, limit: 0 });

        await materializeArtifact(claim(x, 'p1'), catalog.url, TOKEN);
        expect(catalog.state.quotas.get('p1')?.used).toBe(70);
        // p2 берёт тот же sha: кэш-хит, своего билда нет — дельты p2 нет.
        await materializeArtifact(claim(x, 'p2'), catalog.url, TOKEN);
        expect(catalog.state.downloads).toBe(1);
        expect(catalog.state.quotas.get('p2')?.used).toBe(0);
        expect((await readMeta(cacheDir, x.sha256)).projectId).toBe('p1');

        // Эвикция X у p1 (сверх лимита после Y); p2 пересобирает — дельта идёт p2.
        await setLastAccess(cacheDir, x.sha256, Date.now() - 100000);
        await materializeArtifact(claim(y, 'p1'), catalog.url, TOKEN);
        expect(await entrypointExists(cacheDir, x.sha256)).toBe(false);
        await materializeArtifact(claim(x, 'p2'), catalog.url, TOKEN);

        expect(await entrypointExists(cacheDir, x.sha256)).toBe(true);
        expect((await readMeta(cacheDir, x.sha256)).projectId).toBe('p2');
        const xDeltas = catalog.state.deltas.filter((d) => d.requestKey.includes(x.sha256)).map((d) => ({
            projectId: d.projectId,
            deltaBytes: d.deltaBytes,
        }));
        expect(xDeltas).toEqual([
            { projectId: 'p1', deltaBytes: 70 },
            { projectId: 'p1', deltaBytes: -70 },
            { projectId: 'p2', deltaBytes: 70 },
        ]);
    });

    it('персистентность: кэш и мап живут в volume без состояния процесса', async () => {
        const a = makeArtifact('A'.repeat(70));
        catalog.state.archives.set(a.sha256, a.archive);
        catalog.state.quotas.set('p1', { used: 0, limit: 100 });

        await materializeArtifact(claim(a, 'p1'), catalog.url, TOKEN);
        expect(catalog.state.downloads).toBe(1);
        // «Рестарт»: каталог недоступен для докачки — хит кэша обязан пройти по volume.
        catalog.state.failDownloads = true;
        const root = await materializeArtifact(claim(a, 'p1'), catalog.url, TOKEN);
        expect(catalog.state.downloads).toBe(1);
        expect(path.basename(root)).toBe(a.sha256);
        // lastAccess восстановлен из мапа и обновлён touch'ем.
        const meta = await readMeta(cacheDir, a.sha256);
        expect(meta.projectId).toBe('p1');
        expect(meta.lastAccess).toBeGreaterThan(0);
    });

    it('ошибка квотного API не ломает материализацию', async () => {
        const a = makeArtifact('A'.repeat(70));
        catalog.state.archives.set(a.sha256, a.archive);
        catalog.state.quotaStatus = 500;

        await expect(materializeArtifact(claim(a, 'p1'), catalog.url, TOKEN)).resolves.toBeDefined();
        expect(await entrypointExists(cacheDir, a.sha256)).toBe(true);
        expect(catalog.state.deltas).toEqual([]);
    });

    it('global cap: комплекты всех проектов эвиктируются по oldest-access сверх cap', async () => {
        vi.stubEnv('NEUROCENTER_MCP_HOST_CACHE_MAX_BYTES', '150');
        const a = makeArtifact('A'.repeat(70)),
            b = makeArtifact('B'.repeat(70)),
            c = makeArtifact('C'.repeat(70));
        for (const item of [a, b, c]) catalog.state.archives.set(item.sha256, item.archive);
        catalog.state.quotas.set('p1', { used: 0, limit: 0 });
        catalog.state.quotas.set('p2', { used: 0, limit: 0 });

        await materializeArtifact(claim(a, 'p1'), catalog.url, TOKEN);
        await materializeArtifact(claim(b, 'p2'), catalog.url, TOKEN);
        await setLastAccess(cacheDir, a.sha256, Date.now() - 100000);
        // Третий комплект: 210 > 150 → уходит самый старый по всему тому (A, проект p1).
        await materializeArtifact(claim(c, 'p1'), catalog.url, TOKEN);

        expect(await entrypointExists(cacheDir, a.sha256)).toBe(false);
        expect(await entrypointExists(cacheDir, b.sha256)).toBe(true);
        expect(await entrypointExists(cacheDir, c.sha256)).toBe(true);
        // Дебет эвикции засчитан мап-проекту файла.
        expect(catalog.state.quotas.get('p1')?.used).toBe(70);
        expect(catalog.state.quotas.get('p2')?.used).toBe(70);
    });

    it('комплект без проекта (research) не участвует в квоте: нет мапа и дельт', async () => {
        const a = makeArtifact('A'.repeat(70));
        catalog.state.archives.set(a.sha256, a.archive);

        await materializeArtifact(claim(a), catalog.url, TOKEN);
        expect(await entrypointExists(cacheDir, a.sha256)).toBe(true);
        expect(await metaExists(cacheDir, a.sha256)).toBe(false);
        expect(catalog.state.deltas).toEqual([]);
    });
});
