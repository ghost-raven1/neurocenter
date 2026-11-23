import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assertServiceVolumes } = require('../volume-ownership.cjs') as typeof import('../volume-ownership.cjs');

/** AD-OP-6 (OQ-2): helper действует только в production; dev-стенд с host-bind-mount'ами вне проверки. */
const withProduction = (run: () => void): void => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
        run();
    } finally {
        if (previous === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previous;
    }
};

test('production: writable-корень во владении service-user проходит проверку', async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'nc volume ownership '));
    try {
        withProduction(() => assertServiceVolumes('test-svc', [directory]));
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('production: отсутствующий корень — явная ошибка с именем сервиса и действием', async () => {
    const missing = path.join(tmpdir(), 'nc-volume-ownership-missing-' + process.pid);
    withProduction(() =>
        assert.throws(
            () => assertServiceVolumes('test-svc', [missing]),
            (error: Error) =>
                error.message.includes('[test-svc]') &&
                error.message.includes(missing) &&
                error.message.includes('backup') &&
                error.message.includes('chown uid=1000'),
        ),
    );
});

test('production: файл вместо каталога отклоняется', async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'nc volume ownership '));
    const file = path.join(directory, 'not-a-dir');
    await fs.writeFile(file, 'x');
    try {
        withProduction(() => assert.throws(() => assertServiceVolumes('test-svc', [file]), /не является каталогом/));
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('production: недостижимый для записи корень отклоняется (не root)', async () => {
    if (process.getuid() === 0) return; // root обходит DAC-проверку — ветка покрывается live-гейтом
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'nc volume ownership '));
    try {
        await fs.chmod(directory, 0o500);
        withProduction(() =>
            assert.throws(() => assertServiceVolumes('test-svc', [directory]), /недоступен для записи/),
        );
    } finally {
        await fs.chmod(directory, 0o700);
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('production: все проблемы агрегируются в одну ошибку', async () => {
    const directory = await fs.mkdtemp(path.join(tmpdir(), 'nc volume ownership '));
    const file = path.join(directory, 'not-a-dir');
    await fs.writeFile(file, 'x');
    const missing = path.join(directory, 'absent');
    try {
        withProduction(() =>
            assert.throws(
                () => assertServiceVolumes('test-svc', [file, missing]),
                (error: Error) => error.message.includes('не является каталогом') && error.message.includes(missing),
            ),
        );
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});

test('non-production: проверка не действует (dev-стенд с host-bind-mount под другим uid)', async () => {
    const missing = path.join(tmpdir(), 'nc-volume-ownership-dev-' + process.pid);
    assertServiceVolumes('test-svc', [missing, undefined, '']);
});
