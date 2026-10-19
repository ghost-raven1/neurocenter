import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {prepareBridgeInstallers} from '../prepare-bridge-installers.mjs';
import {opencodeVersion} from '../opencode-platforms.mjs';

async function fixture(t) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge installer version '));
    t.after(() => fs.rm(directory, {recursive: true, force: true}));
    for (const relative of ['scripts', 'bridge-dist', 'mcp/neurocenter-asset-sync']) {
        await fs.mkdir(path.join(directory, relative), {recursive: true});
    }
    const version = '9.8.7', target = 'darwin-arm64', file = `neurocenter-asset-sync-${target}-${version}.tgz`;
    const release = {schemaVersion: 1, version, buildId: 'a'.repeat(64), release: 'bridge-v' + version, artifacts: [{file,
        url: `https://github.com/ghost-raven1/neurocenter/releases/download/bridge-v${version}/${file}`,
        metadata: {version, target, nodeVersion: '24.22.0', buildId: 'a'.repeat(64), ragSupported: true,
            probeEngine: {version: opencodeVersion, sha256: 'b'.repeat(64), file: 'bin/opencode-probe'}, sha256: 'c'.repeat(64), bytes: 1}}]};
    await fs.writeFile(path.join(directory, 'scripts/bridge-runtime-release.json'), JSON.stringify(release));
    await fs.writeFile(path.join(directory, 'mcp/neurocenter-asset-sync/package.json'), JSON.stringify({version}));
    const bash = path.join(directory, 'bridge-dist/install.sh'), powershell = path.join(directory, 'bridge-dist/install.ps1');
    await fs.writeFile(bash, "#!/bin/bash\nVERSION='9.8.6'\necho 'не менять'\n", {mode: 0o755});
    await fs.writeFile(powershell, "$Version = '9.8.6'\nWrite-Output 'не менять'\n");
    return {directory, bash, powershell, prepare: options => prepareBridgeInstallers({directory, ...options})};
}

test('Генерация согласует обе версии с package, сохраняя текст и права установщиков', async t => {
    const f = await fixture(t), mode = (await fs.stat(f.bash)).mode;
    assert.deepEqual(await f.prepare(), {version: '9.8.7', changed: ['install.sh', 'install.ps1']});
    assert.equal(await fs.readFile(f.bash, 'utf8'), "#!/bin/bash\nVERSION='9.8.7'\necho 'не менять'\n");
    assert.equal(await fs.readFile(f.powershell, 'utf8'), "$Version = '9.8.7'\nWrite-Output 'не менять'\n");
    assert.equal((await fs.stat(f.bash)).mode, mode);
    const inode = (await fs.stat(f.bash)).ino;
    assert.deepEqual(await f.prepare(), {version: '9.8.7', changed: []});
    assert.equal((await fs.stat(f.bash)).ino, inode);
    await f.prepare({verifyOnly: true});
});

test('Проверка обнаруживает отставшую версию без изменения файлов', async t => {
    const f = await fixture(t), before = await fs.readFile(f.bash);
    await assert.rejects(f.prepare({verifyOnly: true}), /отстаёт/);
    assert.deepEqual(await fs.readFile(f.bash), before);
});

test('Несогласованные package и release отклоняются до изменения первого установщика', async t => {
    const f = await fixture(t), before = await fs.readFile(f.bash);
    await fs.writeFile(path.join(f.directory, 'mcp/neurocenter-asset-sync/package.json'), '{"version":"9.8.8"}');
    await assert.rejects(f.prepare(), /не согласована/);
    assert.deepEqual(await fs.readFile(f.bash), before);
});

for (const kind of ['две строки версии', 'символическая ссылка', 'жёсткая ссылка']) {
    test(`Небезопасный второй шаблон не изменяет первый: ${kind}`, async t => {
        const f = await fixture(t), before = await fs.readFile(f.bash);
        if (kind === 'две строки версии') { await fs.appendFile(f.powershell, "$Version = '9.8.5'\n"); }
        else {
            const other = path.join(f.directory, 'не менять.txt');
            await fs.rename(f.powershell, other);
            if (kind === 'символическая ссылка') { await fs.symlink(other, f.powershell); }
            else { await fs.link(other, f.powershell); }
        }
        await assert.rejects(f.prepare(), /одна строка|без ссылок/);
        assert.deepEqual(await fs.readFile(f.bash), before);
    });
}

test('Отказ второго rename возвращает первый установщик к исходным байтам', async t => {
    const f = await fixture(t), before = await Promise.all([f.bash, f.powershell].map(file => fs.readFile(file)));
    const rename = fs.rename;
    fs.rename = async (source, destination) => {
        if (destination === f.powershell) { throw Object.assign(new Error('Временный отказ записи второго шаблона'), {code: 'EPERM'}); }
        return rename(source, destination);
    };
    try { await assert.rejects(f.prepare(), {code: 'EPERM'}); } finally { fs.rename = rename; }
    assert.deepEqual(await Promise.all([f.bash, f.powershell].map(file => fs.readFile(file))), before);
    assert.deepEqual((await fs.readdir(path.dirname(f.bash))).sort(), ['install.ps1', 'install.sh']);
});

test('Правка второго шаблона после первого rename сохраняется, первый откатывается', async t => {
    const f = await fixture(t), bash = await fs.readFile(f.bash), operator = "$Version = '9.8.6'\n# Правка оператора\n";
    const rename = fs.rename;
    let changed = false;
    fs.rename = async (source, destination) => {
        await rename(source, destination);
        if (destination === f.bash && !changed) { changed = true; await fs.writeFile(f.powershell, operator); }
    };
    try { await assert.rejects(f.prepare(), /изменился во время/); } finally { fs.rename = rename; }
    assert.deepEqual(await fs.readFile(f.bash), bash);
    assert.equal(await fs.readFile(f.powershell, 'utf8'), operator);
});

test('Откат не затирает новую правку опубликованного файла и сохраняет исходный backup', async t => {
    const f = await fixture(t), before = await fs.readFile(f.bash), operator = "#!/bin/bash\nVERSION='9.8.7'\n# Новая правка оператора\n";
    const rename = fs.rename;
    fs.rename = async (source, destination) => {
        if (destination === f.powershell) { await fs.writeFile(f.bash, operator); throw Object.assign(new Error('Отказ второго rename'), {code: 'EPERM'}); }
        return rename(source, destination);
    };
    try { await assert.rejects(f.prepare(), /Резервные копии/); } finally { fs.rename = rename; }
    assert.equal(await fs.readFile(f.bash, 'utf8'), operator);
    const backups = (await fs.readdir(path.dirname(f.bash))).filter(file => file.endsWith('.previous'));
    assert.equal(backups.length, 1);
    assert.deepEqual(await fs.readFile(path.join(path.dirname(f.bash), backups[0])), before);
});

test('Строгий umask сохраняет исходные права при публикации и откате', async t => {
    const f = await fixture(t), files = [f.bash, f.powershell];
    const modes = await Promise.all(files.map(async file => (await fs.stat(file)).mode));
    const previousUmask = process.umask(0o077), rename = fs.rename;
    try {
        await f.prepare();
        assert.deepEqual(await Promise.all(files.map(async file => (await fs.stat(file)).mode)), modes);
        await fs.writeFile(f.bash, "VERSION='9.8.6'\n");
        await fs.writeFile(f.powershell, "$Version = '9.8.6'\n");
        fs.rename = async (source, destination) => {
            if (destination === f.powershell) { throw Object.assign(new Error('Отказ второго rename'), {code: 'EPERM'}); }
            return rename(source, destination);
        };
        await assert.rejects(f.prepare(), {code: 'EPERM'});
        assert.deepEqual(await Promise.all(files.map(async file => (await fs.stat(file)).mode)), modes);
    } finally { process.umask(previousUmask); fs.rename = rename; }
});
