import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const limitsPath = path.join(here, '../runtime/limits.cjs');
const facadePath = path.join(here, '../runtime-artifacts.cjs');
const ENV_NAMES = [
    'NEUROCENTER_RUNTIME_MAX_COMPRESSED_BYTES',
    'NEUROCENTER_RUNTIME_MAX_UNPACKED_BYTES',
    'NEUROCENTER_RUNTIME_MAX_FILES',
    'NEUROCENTER_RUNTIME_CACHE_BYTES',
];
const DEFAULTS = {
    compressedBytes: 256 * 1024 ** 2,
    unpackedBytes: 1024 ** 3,
    filesCount: 20000,
    cacheBytes: 2 * 1024 ** 3,
};

/** Изолированный процесс: импорты и env не пересекаются с тестовым раннером. */
function runChild(script: string): void {
    const result = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 });
    if (!result.trim().endsWith('OK')) throw new Error('Неожиданный вывод: ' + result);
}

const SET_ENV = ENV_NAMES.map((name) => `process.env.${name} = '123';`).join('\n');
const CLEAR_ENV = ENV_NAMES.map((name) => `delete process.env.${name};`).join('\n');
const DEFAULTS_JSON = JSON.stringify(DEFAULTS);

test('Импорт limits.cjs не фиксирует окружение: снимок после импорта пустого env даёт дефолты', () => {
    runChild(`
        const assert = require('node:assert/strict');
        ${SET_ENV}
        const { getLimits } = require(${JSON.stringify(limitsPath)});
        ${CLEAR_ENV}
        // Если бы окружение прочитали при импорте, здесь остались бы зафиксированные '123'.
        assert.deepEqual(getLimits(), ${DEFAULTS_JSON});
        console.log('OK');
    `);
});

test('getLimits() читает окружение на каждый вызов и возвращает свежие замороженные значения', () => {
    runChild(`
        const assert = require('node:assert/strict');
        const { getLimits, LIMIT_DEFAULTS } = require(${JSON.stringify(limitsPath)});
        const fresh = () => getLimits();
        assert.deepEqual(fresh(), ${DEFAULTS_JSON});
        assert.deepEqual(LIMIT_DEFAULTS, ${DEFAULTS_JSON});
        assert.ok(Object.isFrozen(fresh()));
        assert.ok(Object.isFrozen(LIMIT_DEFAULTS));
        process.env.NEUROCENTER_RUNTIME_MAX_FILES = '5';
        assert.equal(fresh().filesCount, 5);
        assert.equal(fresh().filesCount, 5);
        delete process.env.NEUROCENTER_RUNTIME_MAX_FILES;
        assert.equal(fresh().filesCount, 20000);
        process.env.NEUROCENTER_RUNTIME_MAX_FILES = '7';
        assert.equal(fresh().filesCount, 7);
        process.env.NEUROCENTER_RUNTIME_MAX_COMPRESSED_BYTES = '1024';
        process.env.NEUROCENTER_RUNTIME_MAX_UNPACKED_BYTES = '2048';
        process.env.NEUROCENTER_RUNTIME_CACHE_BYTES = '4096';
        assert.deepEqual(fresh(), { compressedBytes: 1024, unpackedBytes: 2048, filesCount: 7, cacheBytes: 4096 });
        console.log('OK');
    `);
});

test('Некорректные значения отклоняются на вызов getLimits() теми же правилами', () => {
    runChild(`
        const assert = require('node:assert/strict');
        const { getLimits } = require(${JSON.stringify(limitsPath)});
        for (const name of ${JSON.stringify(ENV_NAMES)}) {
            for (const raw of ['0', '-1', 'abc', '1.5', ' 5', '5 ']) {
                process.env[name] = raw;
                assert.throws(() => getLimits(), new RegExp('Лимит ' + name + ' должен быть положительным целым числом\\.'));
            }
            process.env[name] = '99999999999999999999';
            assert.throws(() => getLimits(), new RegExp('Лимит ' + name + ' превышает допустимое значение\\.'));
            delete process.env[name];
        }
        for (const name of ${JSON.stringify(ENV_NAMES)}) {
            process.env[name] = '';
        }
        assert.deepEqual(getLimits(), ${DEFAULTS_JSON});
        console.log('OK');
    `);
});

test('Фасадный LIMITS ленивый: импорт не фиксирует env, каждый доступ — свежий снимок', () => {
    runChild(`
        const assert = require('node:assert/strict');
        ${SET_ENV}
        const facade = require(${JSON.stringify(facadePath)});
        ${CLEAR_ENV}
        // Окружение зафиксировали до импорта и убрали после: фасад обязан вернуть дефолты.
        assert.equal(facade.LIMITS.filesCount, 20000);
        assert.deepEqual(facade.LIMITS, ${DEFAULTS_JSON});
        process.env.NEUROCENTER_RUNTIME_MAX_FILES = '9';
        assert.equal(facade.LIMITS.filesCount, 9);
        assert.equal(facade.LIMITS.filesCount, 9);
        delete process.env.NEUROCENTER_RUNTIME_MAX_FILES;
        assert.equal(facade.LIMITS.filesCount, 20000);
        console.log('OK');
    `);
});

test('Поверхность фасада стабильна: лимитные ключи — own+enumerable', () => {
    runChild(`
        const assert = require('node:assert/strict');
        const facade = require(${JSON.stringify(facadePath)});
        assert.deepEqual(Object.keys(facade).sort(), [
            'CEILING',
            'LIMITS',
            'LIMIT_DEFAULTS',
            'TARGETS',
            'inspectRuntimeArchive',
            'normalizeRuntimeArtifacts',
            'portablePath',
            'runtimeDescriptorDigest',
            'validateRuntimeArtifactEntrypoints',
        ]);
        assert.deepEqual(Object.keys(facade.LIMITS).sort(), ['cacheBytes', 'compressedBytes', 'filesCount', 'unpackedBytes']);
        for (const key of Object.keys(facade.LIMITS)) {
            assert.ok(Object.prototype.hasOwnProperty.call(facade.LIMITS, key));
        }
        console.log('OK');
    `);
});
