import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import projectContext from '../plugins/project-context.mjs';

const directories = [];
afterEach(async () => { for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true }); });

async function transform(content) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'project-context-'));
    directories.push(directory);
    if (content !== undefined) await fs.writeFile(path.join(directory, 'package.json'), content);
    const hooks = await projectContext({ directory });
    const output = { system: ['Исходный контекст'] };
    await hooks['experimental.chat.system.transform']({}, output);
    return output.system;
}

test('Контекст проекта пропускает null и другие корневые значения, не являющиеся объектом', async () => {
    for (const data of [null, [], ['test'], 'строка', 42, false]) {
        assert.deepEqual(await transform(JSON.stringify(data)), ['Исходный контекст']);
    }
});

test('Контекст проекта не принимает строку, массив и скаляр в поле scripts', async () => {
    for (const scripts of [undefined, null, 'test', ['test'], 42, true]) {
        const output = await transform(JSON.stringify({ scripts, packageManager: 'pnpm@10.18.3' }));
        assert.equal(output.length, 2);
        assert.match(output[1], /pnpm@10\.18\.3; доступные scripts — нет\./);
    }
});

test('Контекст проекта сохраняет допустимые scripts и не включает команды или недопустимые имена', async () => {
    const output = await transform(JSON.stringify({ scripts: { test: 'DO_NOT_EXECUTE', 'lint:all': 'DO_NOT_EXECUTE', 'bad\nname': 'DO_NOT_EXECUTE' }, packageManager: 'pnpm@10.18.3' }));
    assert.equal(output[0], 'Исходный контекст');
    assert.match(output[1], /pnpm@10\.18\.3; доступные scripts — test, lint:all\./);
    assert.doesNotMatch(output[1], /DO_NOT_EXECUTE|bad/);
});

test('Контекст проекта по-прежнему пропускает отсутствующий, повреждённый и слишком большой package.json', async () => {
    for (const content of [undefined, '{', JSON.stringify({ description: 'x'.repeat(32769) })]) {
        assert.deepEqual(await transform(content), ['Исходный контекст']);
    }
});
