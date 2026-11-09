import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { artifactFixture } from '../../../../scripts/test/runtime-artifact-fixture.cjs';
import { hash } from '../../src/bridge/state.js';
import { canonicalV4, type IPackage } from '../../src/bridge/package.js';
import { ensureRuntimeArtifact } from '../../src/features/runtime-artifacts/cache.js';
import {
    CONTRACT_VERSION,
    normalizeRuntimeArtifacts,
    runtimeArtifactTarget,
} from '../../src/features/runtime-artifacts/model.js';

/**
 * AD-13 (entry 2.11): сверка contractVersion артефакта при установке (client-сторона).
 * Offline-канал: версия несётся в дескрипторе артефакта (домен offline-manifest —
 * descriptor-блок верифицированного комплекта); сверка — до сети и до записи в кэш.
 */
const temporary: Array<string> = [];
afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
async function isolatedCacheRoot(): Promise<string> {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nc-runtime-contract-')));
    temporary.push(root);
    return path.join(root, 'runtime-artifacts');
}
function pkgWith(descriptor: Record<string, unknown>): IPackage {
    const pkg: IPackage = {
        schemaVersion: 5,
        plugin: { id: 'qa-contract', name: 'QA contract', kind: 'mcp', version: 1 },
        config: { extra: { runtimeArtifacts: [descriptor] } },
        files: [],
        manifest: { sha256: '', filesCount: 0 },
    };
    pkg.manifest.sha256 = hash(
        JSON.stringify(canonicalV4({ schemaVersion: pkg.schemaVersion, plugin: pkg.plugin, config: pkg.config, files: [] })),
    );
    return pkg;
}

describe('Runtime artifact contract version (AD-13)', () => {
    it('descriptor несёт опциональный strict semver contractVersion; не-semver отклоняется нормализацией', () => {
        const { descriptor } = artifactFixture(undefined, runtimeArtifactTarget());
        expect(normalizeRuntimeArtifacts([{ ...descriptor, contractVersion: '1.2.2' }])).toHaveLength(1);
        expect(normalizeRuntimeArtifacts([{ ...descriptor, contractVersion: '99.0.0' }])).toHaveLength(1);
        expect(() => normalizeRuntimeArtifacts([{ ...descriptor, contractVersion: '1.2' }])).toThrow();
        expect(() => normalizeRuntimeArtifacts([{ ...descriptor, contractVersion: '1.2.3-rc.1' }])).toThrow();
        // Версия самого моста — строгий semver (источник capability maxContractVersion).
        expect(CONTRACT_VERSION).toMatch(/^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/);
    });

    it('contractVersion новее версии моста — actionable-отказ до сети, без записи в кэш', async () => {
        const root = await isolatedCacheRoot();
        const { archive, descriptor } = artifactFixture(undefined, runtimeArtifactTarget());
        const pkg = pkgWith({ ...descriptor, contractVersion: '99.0.0' });
        const download = vi.fn(async () => Readable.from([archive]));
        await expect(ensureRuntimeArtifact(pkg, { download, cacheRoot: root })).rejects.toThrow(
            /контракт площадки 99\.0\.0/,
        );
        expect(download).not.toHaveBeenCalled();
        await expect(fs.stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('contractVersion, равная или ниже версии моста, — установка проходит (absent — legacy-дескриптор)', async () => {
        for (const contractVersion of ['1.0.0', undefined]) {
            const root = await isolatedCacheRoot();
            const { archive, descriptor } = artifactFixture(undefined, runtimeArtifactTarget());
            const pkg = pkgWith(contractVersion === undefined ? descriptor : { ...descriptor, contractVersion });
            const download = vi.fn(async () => Readable.from([archive]));
            const resolution = await ensureRuntimeArtifact(pkg, { download, cacheRoot: root });
            expect(resolution?.entrypoint).toBeTruthy();
            expect(download).toHaveBeenCalledOnce();
        }
    });

    it('кэш хранит descriptor с contractVersion в описи, hash описи от этого не зависит', async () => {
        const root = await isolatedCacheRoot();
        const { archive, descriptor } = artifactFixture(undefined, runtimeArtifactTarget());
        const pkg = pkgWith({ ...descriptor, contractVersion: '1.2.2' });
        const download = vi.fn(async () => Readable.from([archive]));
        await ensureRuntimeArtifact(pkg, { download, cacheRoot: root });
        const index = JSON.parse(
            await fs.readFile(path.join(root, descriptor.sha256, '.neurocenter-runtime-index.json'), 'utf8'),
        );
        expect(index.artifact.contractVersion).toBe('1.2.2');
        // Повторное разрешение из кэша проходит с тем же descriptor.
        const again = await ensureRuntimeArtifact(pkg, {
            download: vi.fn(async () => Readable.from([archive])),
            cacheRoot: root,
        });
        expect(again?.sha256).toBe(descriptor.sha256);
    });
});
