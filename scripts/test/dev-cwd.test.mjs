import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));

/** Настоящий CLI запускается в отдельной копии; сеть и пользовательские сервисы недоступны. */
async function fixture(t) {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter cwd ')));
    t.after(() => fs.rm(directory, {recursive: true, force: true}));
    const checkout = path.join(directory, 'проект с пробелами');
    const caller = path.join(directory, 'каталог вызова');
    await fs.mkdir(path.join(checkout, 'scripts/workspace'), {recursive: true});
    await fs.mkdir(path.join(caller, 'runtime'), {recursive: true});
    for (const file of ['dev.sh', 'dev.mjs', 'workspace/node-runtime.mjs', 'workspace/model-credentials.mjs', 'workspace/model-credential-store.mjs', 'workspace/dev-model-credentials.mjs', 'workspace/dev-snapshots.mjs', 'workspace/compose.mjs',
        'workspace/compose.lock.json', 'workspace/dev-output.mjs', 'workspace/dev-processes.mjs']) {
        await fs.copyFile(path.join(root, 'scripts', file), path.join(checkout, 'scripts', file));
    }
    await fs.mkdir(path.join(checkout,'scripts/assets'),{recursive:true});
    await fs.copyFile(path.join(root,'scripts/release-request.mjs'),path.join(checkout,'scripts/release-request.mjs'));
    await fs.copyFile(path.join(root,'scripts/assets/startup.mjs'),path.join(checkout,'scripts/assets/startup.mjs'));
    for(const directory of ['models','embedding','vision','snapshots'])await fs.cp(path.join(root,'scripts',directory),path.join(checkout,'scripts',directory),{recursive:true});
    await fs.symlink(process.execPath, path.join(caller, 'runtime/node'));
    const record = path.join(directory, 'calls.jsonl');
    const hook = path.join(directory, 'isolated-startup.mjs');
    await fs.writeFile(hook, `import {appendFileSync} from 'node:fs';
        import http from 'node:http'; import https from 'node:https'; import net from 'node:net';
        import {syncBuiltinESMExports} from 'node:module';
        const record=value=>appendFileSync(process.env.DEV_CWD_RECORD,JSON.stringify(value)+'\\n');
        record({kind:'startup',cwd:process.cwd()});
        const deny=()=>{throw Error('REAL_NETWORK_FORBIDDEN');};
        globalThis.fetch=async input=>{const url=new URL(input);
            if(url.hostname!=='127.0.0.1'||!['22222','4100','4200','4300','4400','4000','5173'].includes(url.port))return deny();
            record({kind:'health',port:url.port});
            return url.port==='5173'
                ? new Response('body { color: #24344a; }',{headers:{'Content-Type':'text/css'}})
                : new Response('{"ok":true}',{status:200});};
        http.request=http.get=https.request=https.get=net.connect=net.createConnection=deny;syncBuiltinESMExports();`);
    const env = {PATH: [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter),
        NODE_BIN: process.execPath, NO_COLOR: '1', TERM: 'dumb', DEV_CWD_RECORD: record,
        NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`};
    async function run({removed = false, renamed = false, overrides = {}, args = ['--help']} = {}) {
        if(args[0]==='status'){await fs.mkdir(path.join(checkout,'.run/project-snapshots/secrets'),{recursive:true});await fs.writeFile(path.join(checkout,'.run/project-snapshots/secrets/verifier-token'),'a'.repeat(64)+'\n',{mode:0o600});}
        const script = path.join(checkout, 'scripts/dev.sh');
        const setup = removed ? 'cd "$1" && rmdir "$1" && exec /bin/bash "$2" "${@:3}"'
            : renamed ? 'cd "$1" && mv "$1" "$1 переименован" && exec /bin/bash "$2" "${@:3}"'
                : 'exec /bin/bash "$2" "${@:3}"';
        const result = spawnSync('/bin/bash', ['-c', setup, 'isolated-cwd', caller, script, ...args], {
            cwd: caller, env: {...env, ...overrides}, encoding: 'utf8', timeout: 10000,
        });
        assert.equal(result.error, undefined);
        const events = await fs.readFile(record, 'utf8').then(value => value.trim().split('\n').filter(Boolean).map(JSON.parse),
            error => {if (error.code === 'ENOENT') return []; throw error;});
        return {...result, events};
    }
    return {checkout, caller, run};
}

for (const action of ['--help', 'status']) {
    test(`CLI ${action} запускает Node из проекта после удаления каталога вызова`, async t => {
        const f = await fixture(t);
        // Удаление только собственного пустого каталога, пока дочерний shell остаётся внутри.
        await fs.rm(path.join(f.caller, 'runtime'), {recursive: true});
        const result = await f.run({removed: true, args: [action]});
        assert.equal(result.status, 0, result.stderr);
        assert.doesNotMatch(result.stderr, /uv_cwd|process\.cwd|REAL_NETWORK_FORBIDDEN/);
        assert.ok(result.events.filter(event => event.kind === 'startup').every(event => event.cwd === f.checkout));
        if (action === 'status') assert.equal(result.events.filter(event => event.kind === 'health').length, 8);
        else assert.match(result.stdout, /Использование: scripts\/dev\.sh/);
        await assert.rejects(fs.access(path.join(f.checkout, action==='status'?'.run/processes.json':'.run')), {code: 'ENOENT'});
    });
}

test('CLI восстанавливает корень проекта после переименования каталога вызова', async t => {
    const f = await fixture(t), result = await f.run({renamed: true});
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.events.some(event => event.kind === 'startup'));
    assert.ok(result.events.filter(event => event.kind === 'startup').every(event => event.cwd === f.checkout));
});

test('CLI сохраняет выбранный Node через относительный NODE_BIN из другого каталога', async t => {
    const f = await fixture(t), result = await f.run({args: ['status'], overrides: {NODE_BIN: './runtime/node'}});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.events.filter(event => event.kind === 'health').length, 8);
    assert.ok(result.events.filter(event => event.kind === 'startup').every(event => event.cwd === f.checkout));
});

test('CLI находит Node в относительном PATH из другого каталога', async t => {
    const f = await fixture(t), result = await f.run({args: ['status'], overrides: {NODE_BIN: '', PATH: 'runtime:/usr/bin:/bin'}});
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.events.filter(event => event.kind === 'health').length, 8);
    assert.ok(result.events.filter(event => event.kind === 'startup').every(event => event.cwd === f.checkout));
});

test('CLI объясняет отсутствие выбранного Node и возвращает код 127', async t => {
    const f = await fixture(t), result = await f.run({overrides: {NODE_BIN: path.join(f.caller, 'missing-node')}});
    assert.equal(result.status, 127);
    assert.match(result.stderr, /не найден Node.js/);
    assert.deepEqual(result.events, []);
});
