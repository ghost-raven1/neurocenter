/**
 * AD-12 ceiling-identity (pre-гейт T6, без docker): ceiling-константы существуют ровно в одном
 * месте — в pinned asset-контракте (vendor/asset-contract); services/shared и dist/shared
 * моста — re-export/вербальные копии. Расхождение = stale build или локальный переопределитель.
 *
 * Связка цепочки (все три значения обязаны совпадать):
 *   vendor/asset-contract (ARTIFACT_CEILING)
 *   → services/shared/runtime-artifacts.cjs (CEILING, server-verify)
 *   → mcp/neurocenter-asset-sync/dist/shared/runtime-artifacts.cjs (CEILING, bridge-клиент, собрано).
 *
 * Live-сегмент T6 (trust-device-e2e.mjs) проверяет ту же идентичность из РАЗВЁРНУТЫХ образов
 * (docker exec); здесь — исходник кандидата + собранная dist (без docker, T5-static).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../..', import.meta.url));
const sharedDir = path.join(root, 'services', 'shared');
const clientSharedDir = path.join(root, 'mcp', 'neurocenter-asset-sync', 'dist', 'shared');
const requireShared = createRequire(path.join(sharedDir, 'runtime-artifacts.cjs'));
const requireClient = createRequire(path.join(clientSharedDir, 'runtime-artifacts.cjs'));
const requireVendor = createRequire(path.join(root, 'vendor', 'asset-contract', 'package.json'));

test('AD-12 ceiling-identity: клиент dist/shared == services/shared == pinned asset-контракт', async () => {
    // Byte-identity ceiling-файлов facade (вербальные копии сборки моста).
    for (const rel of ['runtime-artifacts.cjs', path.join('runtime', 'limits.cjs')]) {
        const server = await readFile(path.join(sharedDir, rel));
        const client = await readFile(path.join(clientSharedDir, rel));
        assert.equal(
            createHash('sha256').update(server).digest('hex'),
            createHash('sha256').update(client).digest('hex'),
            'byte-identity ' + rel + ': dist/shared моста расходится с services/shared (stale build?)',
        );
    }
    // Значения ceiling: три узла цепочки совпадают (single source — контракт поставки).
    const serverCeiling = requireShared(path.join(sharedDir, 'runtime-artifacts.cjs')).CEILING;
    const clientCeiling = requireClient(path.join(clientSharedDir, 'runtime-artifacts.cjs')).CEILING;
    const contractCeiling = requireVendor('@neurocenter/asset-contract').ARTIFACT_CEILING;
    assert.deepEqual(clientCeiling, serverCeiling, 'ceiling: bridge-клиент == server-verify (facade)');
    assert.deepEqual(
        serverCeiling,
        contractCeiling,
        'ceiling: facade re-export == pinned asset-контракт (AD-12 single source)',
    );
    // Формы: положительные целые, все 4 ключа (compressedBytes/unpackedBytes/filesCount/cacheBytes).
    for (const [key, value] of Object.entries(serverCeiling)) {
        assert.ok(Number.isSafeInteger(value) && value > 0, 'ceiling.' + key + ': положительное целое');
    }
    assert.deepEqual(Object.keys(serverCeiling).sort(), [
        'cacheBytes',
        'compressedBytes',
        'filesCount',
        'unpackedBytes',
    ]);
});
