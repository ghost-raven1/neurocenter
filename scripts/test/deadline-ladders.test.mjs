import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { deadlineLadder } from '../../services/shared/deadline-ladders.mjs';

/**
 * Deadline-лестницы (AD-6, entry 2.9): base + margins, внешний дедлайн всегда
 * строго больше внутреннего. Модули-потребители обязаны воспроизводить
 * frozen-значения (model-chat — json-якорь), а не расползаться.
 */
const sharedRequire = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('Лестница — base + margins, каждый уровень строже следующего', () => {
    assert.deepEqual(deadlineLadder('n', 100, [10, 20]), [100, 110, 130]);
    assert.deepEqual(deadlineLadder('n', 5000, []), [5000]);
    for (const [name, base, margins] of [
        ['a', 1000, [1, 2, 3]],
        ['b', 1, [1000000]],
    ]) {
        const levels = deadlineLadder(name, base, margins);
        assert.equal(levels[0], base);
        for (let i = 1; i < levels.length; i++) assert.ok(levels[i] > levels[i - 1], name + ': уровень ' + i);
    }
});

test('Нулевой margin — «pair equal» (лестница не может стоять на месте)', () => {
    assert.throws(() => deadlineLadder('x', 100, [10, 0, 5]), (error) => error.message === 'pair equal: x 110');
    assert.throws(() => deadlineLadder('x', 100, [0]), (error) => error.message === 'pair equal: x 100');
});

test('Отрицательный и не-integer margin — отдельные ошибки', () => {
    assert.throws(
        () => deadlineLadder('x', 100, [-5]),
        (error) => error.message.includes('margin[0]') && error.message.includes('положительный'),
    );
    assert.throws(
        () => deadlineLadder('x', 100, [1.5]),
        (error) => error.message.includes('margin[0]') && error.message.includes('integer ms'),
    );
});

test('Некорректные name/base/margins отклоняются', () => {
    assert.throws(() => deadlineLadder('', 100, []), /name/);
    for (const base of [0, -100, 10.5, Number.NaN])
        assert.throws(() => deadlineLadder('x', base, []), (error) => error.message.includes('base'));
    assert.throws(() => deadlineLadder('x', 100, '10'), /margins/);
});

test('tool-import: 480/540/550s (base 480s + cleanup 60s + margin 10s)', () => {
    const module = sharedRequire('../../services/shared/tool-import-deadline.cjs');
    assert.deepEqual(
        [
            module.TOOL_IMPORT_TIMEOUT_MS,
            module.TOOL_IMPORT_GATEWAY_TIMEOUT_MS,
            module.TOOL_IMPORT_CLIENT_TIMEOUT_MS,
        ],
        [480000, 540000, 550000],
    );
});

test('model-chat: 900/910/915/920s — формула воспроизводит frozen JSON', () => {
    const module = sharedRequire('../../services/shared/model-chat-deadline.cjs');
    const frozen = JSON.parse(
        fs.readFileSync(path.join(repoRoot, 'services/shared/model-chat-deadline.json'), 'utf8'),
    );
    assert.deepEqual(
        {
            roundTimeoutMs: module.MODEL_CHAT_ROUND_TIMEOUT_MS,
            gatewayTimeoutMs: module.MODEL_CHAT_GATEWAY_TIMEOUT_MS,
            edgeTimeoutMs: module.MODEL_CHAT_EDGE_TIMEOUT_MS,
            clientTimeoutMs: module.MODEL_CHAT_CLIENT_TIMEOUT_MS,
        },
        frozen,
    );
    assert.deepEqual(
        [
            module.MODEL_CHAT_ROUND_TIMEOUT_MS,
            module.MODEL_CHAT_GATEWAY_TIMEOUT_MS,
            module.MODEL_CHAT_EDGE_TIMEOUT_MS,
            module.MODEL_CHAT_CLIENT_TIMEOUT_MS,
        ],
        [900000, 910000, 915000, 920000],
    );
});

test('embedding: upstream 110s падает раньше клиентского таймера 115s', () => {
    const module = sharedRequire('../../services/shared/model-embedding-deadline.cjs');
    assert.equal(module.EMBEDDING_UPSTREAM_TIMEOUT_MS, 110000);
    assert.equal(module.EMBEDDING_CLIENT_TIMEOUT_MS, 115000);
    // Ladder-инвариант: внутренний дедлайн строго меньше внешнего (race 115==115 закрыт).
    assert.ok(module.EMBEDDING_UPSTREAM_TIMEOUT_MS < module.EMBEDDING_CLIENT_TIMEOUT_MS);
});
