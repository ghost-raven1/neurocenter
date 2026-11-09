const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const dist = process.env.GATEWAY_TEST_DIST || path.resolve('services/api-gateway/dist');

/** USTAR-одиночник: формат, который принимает shared/runtime/archive.cjs (как в production-runtime-artifact.fixture.mjs). */
function archiveFile(name, bytes) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    const octal = (value, start, length) =>
        header.write(value.toString(8).padStart(length - 1, '0') + '\0', start, length, 'ascii');
    octal(0o644, 100, 8);
    octal(0, 108, 8);
    octal(0, 116, 8);
    octal(bytes.length, 124, 12);
    octal(0, 136, 12);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write('ustar\0', 257, 6, 'ascii');
    header.write('00', 263, 2, 'ascii');
    header.write(
        header
            .reduce((sum, byte) => sum + byte, 0)
            .toString(8)
            .padStart(6, '0') + '\0 ',
        148,
        8,
        'ascii',
    );
    return gzipSync(Buffer.concat([header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512), Buffer.alloc(1024)]));
}

function runGatewayChild(source) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--unhandled-rejections=strict', '-e', source], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '',
            error = '';
        child.stdout.on('data', (chunk) => (output += chunk));
        child.stderr.on('data', (chunk) => (error += chunk));
        const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
        child.on('error', reject);
        child.on('exit', (code, signal) => {
            clearTimeout(timer);
            resolve({ code, signal, output, error });
        });
    });
}

for (const failure of ['ENOSPC', 'EACCES'])
    test(
        'Gateway artifact cache survives ' +
            failure +
            ' under backpressure without unhandled rejection or leaked stage',
        { timeout: 15000 },
        async (t) => {
            const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nc-host-cache-fault-'))),
                bytes = Buffer.alloc(256 * 1024, 65),
                sha = createHash('sha256').update(bytes).digest('hex');
            const upstream = createServer((req, res) => {
                if (req.headers['x-neurocenter-internal'] !== 'qa-only') {
                    res.writeHead(403).end();
                    return;
                }
                res.setHeader('content-type', 'application/gzip');
                res.end(bytes);
            });
            await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
            t.after(async () => {
                await new Promise((resolve) => upstream.close(resolve));
                await fs.rm(directory, { recursive: true, force: true });
            });
            const modulePath = path.join(dist, 'features/mcp-host/artifact-cache.js'),
                base = 'http://127.0.0.1:' + upstream.address().port;
            // A separate strict process proves the Gateway code survives; no actual disk exhaustion or user path is involved.
            const source = `const assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),path=require('node:path'),{Writable}=require('node:stream');
 process.env.NEUROCENTER_MCP_HOST_DIR=${JSON.stringify(directory)};
 const original=fs.createWriteStream;let faulted=false;
 fs.createWriteStream=function(file,options){if(path.basename(file)==='artifact.tar.gz'){faulted=true;return new Writable({highWaterMark:1,write(chunk,encoding,callback){setImmediate(()=>callback(Object.assign(new Error('Synthetic ${failure}'),{code:'${failure}'})));}});}return original.call(this,file,options);};
 const {materializeArtifact}=require(${JSON.stringify(modulePath)});
 (async()=>{await assert.rejects(materializeArtifact({artifactSha256:${JSON.stringify(sha)},entrypoint:'entrypoint.mjs',executable:false,name:'QA',compressedBytes:${bytes.length},unpackedBytes:1,filesCount:1,exp:Date.now()+60000},${JSON.stringify(base)},'qa-only'),/Комплект хоста недоступен/);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(faulted,true);assert.deepEqual(await fsp.readdir(path.join(process.env.NEUROCENTER_MCP_HOST_DIR,'building')),[]);await assert.rejects(fsp.stat(path.join(process.env.NEUROCENTER_MCP_HOST_DIR,'artifacts',${JSON.stringify(sha)},'.ready')),{code:'ENOENT'});console.log(JSON.stringify({alive:true,faulted,stageClean:true,readyPublished:false}));})().catch(error=>{console.error(error);process.exitCode=1;});`;
            const child = spawn(process.execPath, ['--unhandled-rejections=strict', '-e', source], {
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let output = '',
                error = '';
            child.stdout.on('data', (chunk) => (output += chunk));
            child.stderr.on('data', (chunk) => (error += chunk));
            const timer = setTimeout(() => child.kill('SIGKILL'), 7000);
            const exit = await new Promise((resolve, reject) => {
                child.on('error', reject);
                child.on('exit', (code, signal) => resolve({ code, signal }));
            });
            clearTimeout(timer);
            assert.equal(exit.signal, null, 'Artifact writer hung: ' + error);
            assert.equal(exit.code, 0, 'Gateway process failed: ' + error);
            assert.deepEqual(JSON.parse(output), {
                alive: true,
                faulted: true,
                stageClean: true,
                readyPublished: false,
            });
        },
    );

test('Gateway artifact cache персистентен между рестартами: volume + sidecar-мап (AD-D2)', { timeout: 40000 }, async (t) => {
    const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'nc-host-cache-restart-'))),
        source = Buffer.from('// persisted fixture\n'),
        archive = archiveFile('runtime/index.mjs', source),
        sha = createHash('sha256').update(archive).digest('hex');
    const state = { downloads: 0, fail: false, deltas: [] };
    const upstream = createServer((req, res) => {
        if (req.headers['x-neurocenter-internal'] !== 'qa-only') {
            res.writeHead(403).end();
            return;
        }
        if (req.url === '/internal/mcp-host/artifact/' + sha) {
            if (state.fail) {
                res.writeHead(500).end();
                return;
            }
            state.downloads += 1;
            res.setHeader('content-type', 'application/gzip');
            res.end(archive);
            return;
        }
        if (req.url === '/internal/projects/p1/quota-usage' && req.method === 'GET') {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ used: { current: 0, retention: 0, staging: 0 }, limits: { current: 0, retention: 0, staging: 0 } }));
            return;
        }
        if (req.url === '/internal/projects/p1/quota-usage' && req.method === 'POST') {
            let raw = '';
            req.on('data', (chunk) => (raw += chunk));
            req.on('end', () => {
                state.deltas.push(JSON.parse(raw || '{}').deltaBytes);
                res.setHeader('content-type', 'application/json');
                res.end(JSON.stringify({ used: 0 }));
            });
            return;
        }
        res.writeHead(404).end();
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    t.after(async () => {
        await new Promise((resolve) => upstream.close(resolve));
        await fs.rm(directory, { recursive: true, force: true });
    });
    const modulePath = path.join(dist, 'features/mcp-host/artifact-cache.js'),
        base = 'http://127.0.0.1:' + upstream.address().port,
        claim = {
            artifactSha256: sha,
            entrypoint: 'runtime/index.mjs',
            executable: false,
            name: 'QA',
            compressedBytes: archive.length,
            unpackedBytes: source.length,
            filesCount: 1,
            exp: Date.now() + 60000,
            session: {
                deviceId: 'device-1',
                projectId: 'p1',
                assetId: 'asset-1',
                version: 1,
                manifest: createHash('sha256').update('p1').digest('hex'),
            },
        },
        childSource = `process.env.NEUROCENTER_MCP_HOST_DIR=${JSON.stringify(directory)};
const {materializeArtifact}=require(${JSON.stringify(modulePath)});
(async()=>{const root=await materializeArtifact(${JSON.stringify(claim)},${JSON.stringify(base)},'qa-only');console.log(JSON.stringify({hit:root.endsWith(${JSON.stringify(sha)})}));})().catch(error=>{console.error(error.message);process.exitCode=1;});`;
    // Первый «процесс gateway»: сборка комплекта с докачкой и записью sidecar-мапа.
    const first = await runGatewayChild(childSource);
    assert.equal(first.signal, null, 'Первый процесс завис: ' + first.error);
    assert.equal(first.code, 0, 'Первый процесс: ' + first.error);
    assert.deepEqual(JSON.parse(first.output), { hit: true });
    assert.equal(state.downloads, 1);
    assert.deepEqual(state.deltas, [source.length]);
    const meta = JSON.parse(await fs.readFile(path.join(directory, 'artifacts', sha, '.meta'), 'utf8'));
    assert.equal(meta.projectId, 'p1');
    // «Рестарт»: докаталог недоступен, а кэш-хит обязан пройти по данным volume и мапа.
    state.fail = true;
    const second = await runGatewayChild(childSource);
    assert.equal(second.signal, null, 'Второй процесс завис: ' + second.error);
    assert.equal(second.code, 0, 'Второй процесс: ' + second.error);
    assert.deepEqual(JSON.parse(second.output), { hit: true });
    assert.equal(state.downloads, 1, 'После рестарта произошёл недокачка');
});
