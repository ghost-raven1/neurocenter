import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { ARTIFACT_CEILING, CONTRACT_VERSION } from '@neurocenter/asset-contract';

/**
 * AD-12 (entry 2.2): ceiling-константы — единый источник в pinned asset-контракте.
 * «Один модуль, один набор байтов»: server-verify (gateway → shared) и bridge-клиент
 * (model.ts → shared) резолвят один и тот же shared-модуль и видят идентичный CEILING,
 * идентичный контрактной константе. LIMIT_DEFAULTS — дефолтная политика (AD-1), не ceiling:
 * invariant ceiling > default в каждой секции, окружение политики ceiling не влияет.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const serverRequire = createRequire(path.join(ROOT, 'services/api-gateway/src/features/mcp-host/ticket.ts'));
const bridgeRequire = createRequire(path.join(ROOT, 'mcp/neurocenter-asset-sync/src/features/runtime-artifacts/model.ts'));
const serverFacade = serverRequire('../../../../shared/runtime-artifacts.cjs');
const bridgeFacade = bridgeRequire('../../../../../services/shared/runtime-artifacts.cjs');

test('Identity: server-verify и bridge-клиент видят один и тот же CEILING (один модуль, один набор байтов)', () => {
    assert.equal(serverFacade.CEILING, bridgeFacade.CEILING);
    assert.equal(serverFacade.CEILING, ARTIFACT_CEILING);
    assert.equal(Object.isFrozen(serverFacade.CEILING), true);
    assert.deepEqual(Object.keys(serverFacade.CEILING).sort(), ['cacheBytes', 'compressedBytes', 'filesCount', 'unpackedBytes']);
});

test('Единый источник: interim ceiling (AD-1) зафиксирован контрактом, shared не дублирует литералы', () => {
    assert.equal(CONTRACT_VERSION, '1.3.0');
    assert.deepEqual(ARTIFACT_CEILING, {
        compressedBytes: 1024 ** 3,
        unpackedBytes: 4 * 1024 ** 3,
        filesCount: 100000,
        cacheBytes: 8 * 1024 ** 3,
    });
});

test('Drift: ceiling > default-политика в каждой секции (иначе фэйл)', () => {
    for (const key of Object.keys(ARTIFACT_CEILING)) {
        assert.ok(
            serverFacade.CEILING[key] > serverFacade.LIMIT_DEFAULTS[key],
            `ceiling.${key} обязан превышать LIMIT_DEFAULTS.${key}`,
        );
    }
});

test('ENV_POLICY: NEUROCENTER_RUNTIME_MAX_* — политика, на ceiling не влияет (изолированный процесс)', () => {
    const script = `
        const assert = require('node:assert/strict');
        const facade = require(${JSON.stringify(path.join(ROOT, 'services/shared/runtime-artifacts.cjs'))});
        process.env.NEUROCENTER_RUNTIME_MAX_COMPRESSED_BYTES = '1024';
        process.env.NEUROCENTER_RUNTIME_MAX_UNPACKED_BYTES = '2048';
        process.env.NEUROCENTER_RUNTIME_MAX_FILES = '7';
        process.env.NEUROCENTER_RUNTIME_CACHE_BYTES = '4096';
        // Политика подхватывает окружение, ceiling — нет: раздельные объекты, разные значения.
        assert.equal(facade.LIMITS.filesCount, 7);
        assert.notEqual(facade.CEILING, facade.LIMITS);
        assert.deepEqual(facade.CEILING, ${JSON.stringify(ARTIFACT_CEILING)});
        console.log('OK');
    `;
    const result = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 });
    assert.equal(result.trim(), 'OK');
});
