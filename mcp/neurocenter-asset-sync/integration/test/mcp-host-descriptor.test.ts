import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { artifactFixture } from '../../../../scripts/test/runtime-artifact-fixture.cjs';
import {
    CEILING,
    normalizeRuntimeArtifacts,
    runtimeDescriptorDigest,
} from '../../../../services/shared/runtime-artifacts.cjs';
import { ensureRuntimeArtifact, selectedRuntimeArtifact } from '../../src/features/runtime-artifacts/cache.js';
import { runtimeArtifactTarget } from '../../src/features/runtime-artifacts/model.js';
import { RuntimeArtifactCapacityError } from '../../src/features/runtime-artifacts/capacity-error.js';
import { requestHostedMcpConnection } from '../../src/features/mcp-host/connect.js';
import { canonicalV4, type IPackage } from '../../src/bridge/package.js';
import { hash, writeState } from '../../src/bridge/state.js';
import { bindProject, setRoot } from '../../src/bridge/workspace.js';

const folders: string[] = [];
const servers: Array<http.Server> = [];

const startHub = (
    descriptorMode: (raw: string) => string | undefined,
): Promise<http.Server & { port: number }> =>
    new Promise((resolve) => {
        const server = http.createServer((req, res) => {
            let body = '';
            req.on('data', (chunk) => {
                body += chunk;
            });
            req.on('end', () => {
                res.writeHead(200, { 'content-type': 'application/json' });
                const descriptorSha256 = descriptorMode(body);
                res.end(
                    JSON.stringify({
                        path: '/api/mcp-host/m/qa-payload.sig',
                        ...(descriptorSha256 !== undefined ? { descriptorSha256 } : {}),
                    }),
                );
            });
        }) as http.Server & { port: number };
        server.listen(0, '127.0.0.1', () => {
            server.port = (server.address() as net.AddressInfo).port;
            resolve(server);
        });
    });

const hostedFixture = async (hubUrl: string) => {
    const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-hosted-descriptor-')));
    folders.push(temporary);
    vi.stubEnv('NEUROCENTER_BRIDGE_HOME', path.join(temporary, 'private'));
    vi.stubEnv('NEUROCENTER_URL', hubUrl);
    const root = path.join(temporary, 'projects', 'descriptor project');
    await fs.mkdir(root, { recursive: true });
    await setRoot(path.dirname(root));
    await bindProject('descriptor-project', path.basename(root));
    await writeState('credentials', { token: '0'.repeat(64), deviceId: randomUUID(), email: 'fixture@example.test' });
    return { temporary, root };
};

const hostedPkg = (descriptor: ReturnType<typeof artifactFixture>['descriptor']): IPackage => {
    const pkg: IPackage = {
        schemaVersion: 5,
        plugin: { id: 'ai-plug-descriptor', name: 'descriptor-mcp', kind: 'mcp', version: 1 },
        config: {
            transport: 'local',
            extra: { runtimeArtifacts: [descriptor], hostedMcp: true },
        },
        files: [],
        manifest: { sha256: '', filesCount: 0 },
    };
    pkg.manifest.sha256 = hash(
        JSON.stringify(
            canonicalV4({ schemaVersion: pkg.schemaVersion, plugin: pkg.plugin, config: pkg.config, files: [] }),
        ),
    );
    return pkg;
};

afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const folder of folders.splice(0)) {
        await fs.rm(folder, { recursive: true, force: true });
    }
});

describe('AD-3: клиентская сверка descriptorSha256', () => {
    it('match: sha256 descriptor-текста совпадает с сертификатом — канал выдан', async () => {
        const hub = await startHub((raw) => {
            const pkg = (JSON.parse(raw) as { pkg: IPackage }).pkg;
            return runtimeDescriptorDigest(normalizeRuntimeArtifacts(pkg.config?.extra?.runtimeArtifacts, CEILING));
        });
        servers.push(hub);
        await hostedFixture(`http://127.0.0.1:${hub.port}`);
        const { descriptor } = artifactFixture(undefined, runtimeArtifactTarget());
        const pkg = hostedPkg(descriptor);
        await expect(requestHostedMcpConnection('descriptor-project', pkg)).resolves.toBe(
            '/api/mcp-host/m/qa-payload.sig',
        );
    });

    it('mismatch: чужой сертификат — отказ без канала', async () => {
        const hub = await startHub(() => 'f'.repeat(64));
        servers.push(hub);
        await hostedFixture(`http://127.0.0.1:${hub.port}`);
        const { descriptor } = artifactFixture(undefined, runtimeArtifactTarget());
        const pkg = hostedPkg(descriptor);
        await expect(requestHostedMcpConnection('descriptor-project', pkg)).rejects.toThrow(/не совпадает/);
    });

    it('self-reference: sha256 из байтов пакета не принимается как сертификат', async () => {
        const { archive, descriptor } = artifactFixture(undefined, runtimeArtifactTarget());
        const selfReferential = createHash('sha256').update(archive).digest('hex');
        expect(selfReferential).not.toBe(
            runtimeDescriptorDigest(normalizeRuntimeArtifacts([descriptor], CEILING)),
        );
        const hub = await startHub(() => selfReferential);
        servers.push(hub);
        await hostedFixture(`http://127.0.0.1:${hub.port}`);
        const pkg = hostedPkg(descriptor);
        await expect(requestHostedMcpConnection('descriptor-project', pkg)).rejects.toThrow(/не совпадает/);
    });
});

describe('AD-2: limits — обязательное поле, min(descriptor.limits, ceiling), env-путь удалён', () => {
    it('fail-closed: descriptor без limits не устанавливается', async () => {
        const { descriptor } = artifactFixture(undefined, runtimeArtifactTarget());
        const bare = { ...descriptor } as Record<string, unknown>;
        delete bare.limits;
        const pkg = hostedPkg(bare as never);
        expect(() => selectedRuntimeArtifact(pkg)).toThrow(/limits/);
        await expect(
            ensureRuntimeArtifact(pkg, {
                cacheRoot: path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'nc-descriptor-nolimits-')), 'cache'),
                download: async () => {
                    throw new Error('Загрузка не должна стартовать.');
                },
            }),
        ).rejects.toThrow(/limits/);
    });

    it('fail-closed: limits выше ceiling — invalid descriptor', async () => {
        const { descriptor } = artifactFixture(undefined, runtimeArtifactTarget());
        const over = {
            ...descriptor,
            limits: { ...descriptor.limits, compressedBytes: CEILING.compressedBytes + 1 },
        };
        const pkg = hostedPkg(over);
        expect(() => selectedRuntimeArtifact(pkg)).toThrow();
    });

    it('min(descriptor.limits, ceiling): кэш-бюджет берётся из limits, а не из ceiling', async () => {
        const { archive, descriptor } = artifactFixture(undefined, runtimeArtifactTarget());
        const tight = { ...descriptor, limits: { ...descriptor.limits, cacheBytes: 1024 * 1024 } };
        const pkg = hostedPkg(tight);
        const cacheRoot = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'nc-descriptor-budget-')), 'cache');
        await fs.mkdir(cacheRoot, { recursive: true, mode: 0o700 });
        const filler = await fs.open(path.join(cacheRoot, 'qa-sparse-prior'), 'wx', 0o600);
        try {
            await filler.truncate(2 * 1024 * 1024);
        } finally {
            await filler.close();
        }
        let downloadCalled = false;
        const error = await ensureRuntimeArtifact(pkg, {
            cacheRoot,
            download: async () => {
                downloadCalled = true;
                return Readable.from([archive]);
            },
        }).catch((value) => value);
        expect(downloadCalled).toBe(false);
        expect(error).toBeInstanceOf(RuntimeArtifactCapacityError);
        expect((error as RuntimeArtifactCapacityError).code).toBe('runtime-cache-full');
        // Тот же объём кэша допустим, когда limits несёт большой бюджет: min не сужает потолок.
        const loose = { ...descriptor, limits: { ...descriptor.limits, cacheBytes: CEILING.cacheBytes } };
        const looseRoot = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'nc-descriptor-loose-')), 'cache');
        await fs.mkdir(looseRoot, { recursive: true, mode: 0o700 });
        const looseFiller = await fs.open(path.join(looseRoot, 'qa-sparse-prior'), 'wx', 0o600);
        try {
            await looseFiller.truncate(2 * 1024 * 1024);
        } finally {
            await looseFiller.close();
        }
        await expect(
            ensureRuntimeArtifact(hostedPkg(loose), {
                cacheRoot: looseRoot,
                download: async () => Readable.from([archive]),
            }),
        ).resolves.not.toBeUndefined();
    });

    it('env-gone: NEUROCENTER_RUNTIME_MAX_* не сужает клиент (env-путь удалён)', async () => {
        // Некомпримируемый контент: объявленный размер гарантированно больше env-лимита 100.
        const content = randomBytes(300).toString('latin1');
        const { archive, descriptor } = artifactFixture([{ path: 'runtime/server.mjs', content }], runtimeArtifactTarget());
        expect(descriptor.compressedBytes).toBeGreaterThan(100);
        vi.stubEnv('NEUROCENTER_RUNTIME_MAX_COMPRESSED_BYTES', '100');
        vi.stubEnv('NEUROCENTER_RUNTIME_CACHE_BYTES', '100');
        const pkg = hostedPkg(descriptor);
        const cacheRoot = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'nc-descriptor-env-')), 'cache');
        await expect(
            ensureRuntimeArtifact(pkg, {
                cacheRoot,
                download: async () => Readable.from([archive]),
            }),
        ).resolves.not.toBeUndefined();
    });
});
