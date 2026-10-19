import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {mkdtemp,mkdir,readFile,readdir,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {writeReceipt} from '../models/readiness.mjs';

async function fixture(action) {
    const root = await mkdtemp(path.join(tmpdir(), 'nc-model-receipt-write-'));
    try {await action({root, receipt: path.join(root, 'readiness.json')});}
    finally {await rm(root, {recursive: true, force: true});}
}

test('Квитанция заменяется целиком с закрытыми правами и без временных файлов', async () => fixture(async config => {
    await writeReceipt(config, {model: 'first'});
    await writeReceipt(config, {model: 'second', checkedAt: new Date().toISOString()});
    assert.equal(JSON.parse(await readFile(config.receipt, 'utf8')).model, 'second');
    assert.deepEqual(await readdir(config.root), ['readiness.json']);
    if (process.platform !== 'win32') assert.equal((await stat(config.receipt)).mode & 0o777, 0o600);
}));

test('Атомарная замена ссылки не изменяет внешний файл', async () => fixture(async config => {
    const outside = path.join(config.root, 'outside.json');
    await writeFile(outside, 'private fixture'); await symlink(outside, config.receipt);
    await writeReceipt(config, {model: 'own'});
    assert.equal(await readFile(outside, 'utf8'), 'private fixture');
    assert.deepEqual(JSON.parse(await readFile(config.receipt, 'utf8')), {model: 'own'});
}));

test('Неудачная публикация квитанции очищает временный файл и сохраняет целевой каталог', async () => fixture(async config => {
    await mkdir(config.receipt);
    await assert.rejects(writeReceipt(config, {model: 'own'}));
    assert.ok((await stat(config.receipt)).isDirectory());
    assert.deepEqual(await readdir(config.root), ['readiness.json']);
}));

test('Ошибка rename сохраняет прежнюю квитанцию и очищает собственный временный файл', async () => fixture(async config => {
    const previous = JSON.stringify({model: 'previous'});
    await writeFile(config.receipt, previous);
    const original = fs.promises.rename;
    fs.promises.rename = async (source, target) => {
        if (target === config.receipt) throw Object.assign(new Error('Собственный отказ rename.'), {code: 'EIO'});
        return original(source, target);
    };
    syncBuiltinESMExports();
    try {await assert.rejects(writeReceipt(config, {model: 'next'}), {code: 'EIO'});}
    finally {fs.promises.rename = original; syncBuiltinESMExports();}
    assert.equal(await readFile(config.receipt, 'utf8'), previous);
    assert.deepEqual(await readdir(config.root), ['readiness.json']);
}));
