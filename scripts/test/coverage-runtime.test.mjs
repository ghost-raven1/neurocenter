import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn, spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

/** Exercise the shipped wrappers with a private collector, never the product test suites. */
async function fixture(t, body) {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neurocenter runtime cli ')));
    t.after(() => fs.rm(directory, {recursive: true, force: true}));
    for (const relative of ['scripts/coverage/cli.mjs', 'scripts/workspace/isolated-build-cli.mjs',
        'scripts/workspace/node24-cli.mjs', 'scripts/workspace/node-runtime.mjs']) {
        await fs.mkdir(path.dirname(path.join(directory, relative)), {recursive: true});
        await fs.copyFile(path.join(root, relative), path.join(directory, relative));
    }
    for (const entry of ['scripts/coverage/run.mjs', 'scripts/workspace/isolated-build.mjs']) await fs.writeFile(path.join(directory, entry), body ||
        `console.log(JSON.stringify({version:process.versions.node,args:process.argv.slice(2),cwd:process.cwd(),node:process.env.NODE_BIN})); process.exitCode=Number(process.env.FIXTURE_EXIT||0);`);
    const env = {PATH: path.dirname(process.execPath), NODE_BIN: process.execPath};
    return {directory, env, run: (entry, args = [], override = {}, node = process.execPath) => spawnSync(node,
        [path.join(directory, entry), ...args], {cwd: directory, env: {...env, ...override}, encoding: 'utf8', timeout: 10000})};
}

for (const entry of ['scripts/coverage/cli.mjs', 'scripts/workspace/isolated-build-cli.mjs']) test(entry+' preserves scope arguments and failure status', async t => {
    const f = await fixture(t), args = ['--package', 'frontend', '--test-file', 'test/a space.test.ts', '--output', 'report path'];
    const result = f.run(entry, args, {FIXTURE_EXIT: '7'});
    assert.equal(result.error, undefined); assert.equal(result.status, 7, result.stderr);
    const value = JSON.parse(result.stdout);
    assert.match(value.version, /^24\./); assert.deepEqual(value.args, args); assert.equal(value.cwd, f.directory);
    assert.equal(value.node, process.execPath);
    await assert.rejects(fs.access(path.join(f.directory, '.run')), {code: 'ENOENT'});
});

test('an invalid explicit NODE_BIN fails without importing the collector or creating reports', async t => {
    const f = await fixture(t), result = f.run('scripts/coverage/cli.mjs', ['--help'], {NODE_BIN: path.join(f.directory, 'missing node')});
    assert.equal(result.status, 1); assert.match(result.stderr, /NODE_BIN/); assert.equal(result.stdout, '');
    await assert.rejects(fs.access(path.join(f.directory, '.run')), {code: 'ENOENT'});
});

test('the selected Node24 preserves an entrypoint guard instead of silently skipping the build', async t => {
    const f = await fixture(t, `import {pathToFileURL} from 'node:url';
        if(pathToFileURL(process.argv[1]).href===import.meta.url)console.log('ENTRYPOINT_EXECUTED');else process.exitCode=91;`);
    const result = f.run('scripts/workspace/isolated-build-cli.mjs', ['--help']);
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout.trim(), 'ENTRYPOINT_EXECUTED');
});

/** An actual older runtime is needed to prove re-exec, rather than mocking process.version. */
async function olderRuntime(t) {
    const versions = path.join(os.homedir(), '.nvm/versions/node');
    let candidates;
    try { candidates = (await fs.readdir(versions)).filter(name => /^v20\./.test(name)).sort().map(name => path.join(versions, name, 'bin/node')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; candidates = []; }
    const found = candidates.find(node => {
        const result = spawnSync(node, ['-p', 'process.versions.node'], {env: {PATH: '/usr/bin:/bin'}, encoding: 'utf8', timeout: 3000});
        return result.status === 0 && /^20\./.test(result.stdout);
    });
    if (!found) t.skip('No installed Node20; same-runtime and admission checks remain available.');
    return found;
}

test('an actual Node20 launcher runs the collector using the selected Node24 without installs', async t => {
    const old = await olderRuntime(t); if (!old) return;
    const f = await fixture(t), result = f.run('scripts/coverage/cli.mjs', ['--package', 'api-gateway'], {}, old);
    assert.equal(result.error, undefined); assert.equal(result.status, 0, result.stderr);
    const value = JSON.parse(result.stdout); assert.match(value.version, /^24\./);
    assert.deepEqual(value.args, ['--package', 'api-gateway']); assert.equal(value.node, process.execPath);
    assert.deepEqual((await fs.readdir(f.directory)).sort(), ['scripts']);
});

for (const useOlder of [false, true]) test((useOlder?'Node20 re-exec':'Node24')+' cancellation stops its own descendant and leaves an unrelated process alive', async t => {
    if (process.platform === 'win32') { t.skip('POSIX process-group evidence.'); return; }
    const old = useOlder ? await olderRuntime(t) : process.execPath; if (!old) return;
    const f = await fixture(t, `import {spawn} from 'node:child_process';
        const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},50)"],{stdio:'ignore'});
        process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),100));process.stdout.write(JSON.stringify({pid:process.pid,child:child.pid})+'\\n');setInterval(()=>{},50);`);
    const outsider = spawn(process.execPath, ['-e', 'setInterval(()=>{},50)'], {stdio: 'ignore', detached: true});
    const processUnderTest = spawn(old, [path.join(f.directory, 'scripts/coverage/cli.mjs')], {cwd: f.directory, env: f.env, stdio: ['ignore','pipe','pipe'], detached: true});
    let value, output = '', errors = '';
    processUnderTest.stdout.on('data', bytes => { output += bytes; if (output.includes('\n')) value = JSON.parse(output.trim()); });
    processUnderTest.stderr.on('data', bytes => { errors += bytes; });
    const ended = new Promise(resolve => processUnderTest.once('close', (code, signal) => resolve({code, signal})));
    t.after(async () => {
        for (const pid of [processUnderTest.pid, value?.pid, outsider.pid]) if (pid) try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
        await ended;
    });
    for (let attempt = 0; attempt < 200 && !value; attempt++) await delay(25);
    assert.ok(value, errors || 'Collector did not start'); assert.ok(alive(value.pid)); assert.ok(alive(value.child));
    processUnderTest.kill('SIGTERM');
    const result = await Promise.race([ended, delay(5000).then(() => null)]);
    assert.ok(result, 'Launcher failed to reap its child'); assert.deepEqual(result, {code: 143, signal: null});
    for (let attempt = 0; attempt < 100 && (alive(value.pid) || alive(value.child)); attempt++) await delay(25);
    assert.equal(alive(value.pid), false); assert.equal(alive(value.child), false);
    assert.equal(alive(outsider.pid), true);
});

test('an entrypoint terminated by its own signal leaves no descendant running', async t => {
    if (process.platform === 'win32') { t.skip('POSIX process-group evidence.'); return; }
    const f = await fixture(t, `import {spawn} from 'node:child_process';
        const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},50)"],{stdio:'ignore'});
        console.log(JSON.stringify({child:child.pid}));setTimeout(()=>process.kill(process.pid,'SIGTERM'),150);`);
    const result = f.run('scripts/coverage/cli.mjs');
    assert.equal(result.status, 143, result.stderr);
    const {child} = JSON.parse(result.stdout);
    for (let attempt = 0; attempt < 100 && alive(child); attempt++) await delay(25);
    assert.equal(alive(child), false);
});

test('an unresponsive entrypoint is forcibly stopped after the configured grace', async t => {
    if (process.platform === 'win32') { t.skip('POSIX process-group evidence.'); return; }
    const f = await fixture(t, `process.on('SIGTERM',()=>{});console.log('READY');setInterval(()=>{},50);`);
    await fs.writeFile(path.join(f.directory, 'scripts/coverage/cli.mjs'), `import {fileURLToPath} from 'node:url';
        import {launchNode24} from '../workspace/node24-cli.mjs';
        await launchNode24(fileURLToPath(new URL('./run.mjs',import.meta.url)),[],{killGraceMs:100});`);
    const child = spawn(process.execPath, [path.join(f.directory, 'scripts/coverage/cli.mjs')], {env: f.env, stdio: ['ignore','pipe','pipe'], detached: true});
    let ready = false; child.stdout.on('data', bytes => { ready ||= bytes.toString().includes('READY'); });
    const ended = new Promise(resolve => child.once('close', code => resolve(code)));
    t.after(async () => { try { process.kill(-child.pid,'SIGKILL'); } catch(error) { if(error.code!=='ESRCH')throw error; } await ended; });
    for (let attempt = 0; attempt < 200 && !ready; attempt++) await delay(25);
    assert.equal(ready, true); child.kill('SIGTERM');
    assert.equal(await Promise.race([ended,delay(3000).then(()=>null)]),143);
});
