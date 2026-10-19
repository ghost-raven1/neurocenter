import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { prepareOpenCodeRag } from '../opencode-rag.mjs';
import { prepareOpenCodeSnip } from '../opencode-snip.mjs';
import { assertRegularTree, installDependencies, download } from '../upstream.mjs';

test('Несовместимая платформа отклоняется до скачивания и создания комплекта', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-recipe-'));
    try {
        const directory = path.join(root, 'absent');
        await assert.rejects(prepareOpenCodeRag({ target: 'darwin-x64', directory }), /Intel Mac/);
        await assert.rejects(prepareOpenCodeRag({ target: 'linux-mips', directory }), /Неизвестная платформа/);
        await assert.rejects(prepareOpenCodeSnip({ target: 'linux-mips', directory }), /Неизвестная платформа/);
        assert.equal(await fs.stat(directory).then(() => true).catch(() => false), false);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Поставка отклоняет символьные ссылки, включая ссылки на файл внутри комплекта', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-recipe-'));
    try {
        await fs.writeFile(path.join(root, 'real'), 'bytes');
        await fs.symlink(path.join(root, 'real'), path.join(root, 'alias'));
        await assert.rejects(assertRegularTree(root), /ссылку или специальный файл/);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('Закреплённый lock использует ci без lifecycle и отдельный HOME', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-recipe-'));
    const previous = process.env.NPM_CLI_JS;
    try {
        const cli = path.join(root, 'npm-cli.js');
        const directory = path.join(root, 'package');
        await fs.mkdir(directory);
        await fs.writeFile(path.join(directory, 'package-lock.json'), '{}');
        await fs.writeFile(cli, `const fs=require('node:fs');const path=require('node:path');const args=process.argv.slice(2);const directory=args[args.indexOf('--prefix')+1];fs.writeFileSync(path.join(directory,'invocation.json'),JSON.stringify({args,home:process.env.HOME,userconfig:args[args.indexOf('--userconfig')+1]}));`);
        process.env.NPM_CLI_JS = cli;
        await installDependencies(directory, { example: '1.0.0' }, 'linux-arm64-musl');
        const invocation = JSON.parse(await fs.readFile(path.join(directory, 'invocation.json')));
        assert.equal(invocation.args[0], 'ci');
        assert.ok(invocation.args.includes('--ignore-scripts'));
        assert.ok(invocation.args.includes('--no-bin-links'));
        assert.ok(invocation.args.includes('arm64'));
        assert.ok(invocation.args.includes('musl'));
        assert.notEqual(invocation.home, os.homedir());
        assert.ok(invocation.userconfig.startsWith(invocation.home + path.sep));
        assert.equal(await fs.stat(invocation.home).then(() => true).catch(() => false), false);
        assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'package.json'))).name, 'neurocenter-prepared-runtime');
    } finally {
        if (previous === undefined) delete process.env.NPM_CLI_JS; else process.env.NPM_CLI_JS = previous;
        await fs.rm(root, { recursive: true, force: true });
    }
});

test('Повреждённый кэш скачивается заново, неверная SHA не публикуется', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter-recipe-'));
    let cached;
    try {
        const source = path.join(root, 'source');
        const contents = 'verified-' + randomUUID();
        await fs.writeFile(source, contents);
        const sha = createHash('sha256').update(contents).digest('hex');
        cached = await download(pathToFileURL(source).href, sha);
        await fs.writeFile(cached, 'corrupted');
        assert.equal(await download(pathToFileURL(source).href, sha), cached);
        assert.equal(await fs.readFile(cached, 'utf8'), contents);
        await assert.rejects(download(pathToFileURL(source).href, '0'.repeat(64)), /SHA256/);
    } finally {
        if (cached) await fs.rm(cached, { force: true });
        await fs.rm(root, { recursive: true, force: true });
    }
});
