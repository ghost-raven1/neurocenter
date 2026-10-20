import { createHash, randomUUID } from 'node:crypto';
import { lookup as systemLookup } from 'node:dns/promises';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import runtime from '../../services/shared/runtime-artifacts.cjs';
import runtimeSource from '../../services/shared/tool-runtime-source.cjs';

const within = (parent, child) => { const relative = path.relative(parent, child); return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
const inflight = new Map();

async function publicResponse(url, { lookup = systemLookup, request = httpsRequest } = {}, redirects = 0) {
    // Повторная валидация применяется и к URL каждого redirect.
    runtimeSource.validateRuntimeSource({ type: 'runtime', adapter: 'native', assets: { 'darwin-arm64': { app: { url: url.href, sha256: '0'.repeat(64), format: 'file', entrypoint: 'program' } } } });
    const addresses = await lookup(url.hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(item => !runtimeSource.isPublicRuntimeAddress(item.address))) { throw new Error('Asset разрешается в локальную или непубличную сеть.'); }
    const response = await new Promise((resolve, reject) => {
        const connection = request(url, { signal: AbortSignal.timeout(180_000), headers: { Accept: 'application/octet-stream' },
            lookup(_hostname, options, callback) { options.all ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family); } }, resolve);
        connection.once('error', reject);
        connection.setTimeout(30_000, () => connection.destroy(new Error('Истекло время загрузки asset.')));
        connection.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        response.resume();
        if (redirects >= 3 || typeof response.headers.location !== 'string') { throw new Error('Слишком много перенаправлений asset.'); }
        return publicResponse(new URL(response.headers.location, url), { lookup, request }, redirects + 1);
    }
    if (response.statusCode !== 200) { response.resume(); throw new Error('Не удалось скачать закреплённый runtime asset.'); }
    return response;
}

async function archiveHash(filename) {
    const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const before = await file.stat();
        if (!before.isFile() || before.nlink !== 1 || !before.size || before.size > runtime.LIMITS.compressedBytes) { throw new Error('Некорректный runtime asset в кэше.'); }
        const hash = createHash('sha256'); let size = 0;
        for await (const chunk of file.createReadStream({ autoClose: false })) { size += chunk.length; if (size > runtime.LIMITS.compressedBytes) { throw new Error('Runtime asset превышает 256 МиБ.'); } hash.update(chunk); }
        const after = await file.stat();
        if (before.ino !== after.ino || before.size !== size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || after.nlink !== 1) { throw new Error('Runtime asset изменился во время проверки.'); }
        return { sha256: hash.digest('hex'), compressedBytes: size };
    } finally { await file.close(); }
}

/** Загрузка ограничена размером, SHA и публичным DNS; credentials из окружения не используются. */
export async function downloadRuntimeAsset(asset, cacheDirectory, transport) {
    asset = runtimeSource.validateRuntimeSource({ type: 'runtime', adapter: 'native', assets: { 'darwin-arm64': { app: asset } } }).assets['darwin-arm64'].app;
    if (!asset.url) { throw new Error('Загрузка требует remote asset.'); }
    const filename = path.join(cacheDirectory, asset.sha256), metadataPath = filename + '.json';
    if (inflight.has(filename)) { return inflight.get(filename); }
    const task = (async () => {
        await fs.mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
        const folder = await fs.lstat(cacheDirectory);
        if (!folder.isDirectory() || folder.isSymbolicLink()) { throw new Error('Кэш runtime должен быть обычной папкой.'); }
        try {
            const metadata = await fs.lstat(metadataPath);
            if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 8192) { throw new Error('Повреждена запись кэша runtime.'); }
            const saved = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
            const actual = await archiveHash(filename);
            if (saved.schemaVersion !== 1 || saved.sha256 !== asset.sha256 || actual.sha256 !== asset.sha256 || saved.compressedBytes !== actual.compressedBytes) { throw new Error('Не совпала SHA-256 runtime asset в кэше.'); }
            return { filename, ...actual };
        } catch (error) { if (error.code !== 'ENOENT') { throw error; } }
        const response = await publicResponse(new URL(asset.url), transport);
        const declared = response.headers['content-length'];
        if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > runtime.LIMITS.compressedBytes)) { response.destroy(); throw new Error('Runtime asset превышает 256 МиБ.'); }
        const temporary = filename + '.' + randomUUID() + '.partial';
        try {
            const hash = createHash('sha256'); let bytes = 0;
            await pipeline(response, new Transform({ transform(chunk, _encoding, done) {
                bytes += chunk.length;
                if (bytes > runtime.LIMITS.compressedBytes) { done(new Error('Runtime asset превышает 256 МиБ.')); return; }
                hash.update(chunk); done(null, chunk);
            } }), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
            if (!bytes || declared !== undefined && Number(declared) !== bytes) { throw new Error('Загрузка runtime asset оборвалась.'); }
            if (hash.digest('hex') !== asset.sha256) { throw new Error('Не совпала SHA-256 runtime asset.'); }
            await fs.chmod(temporary, 0o400); await fs.rename(temporary, filename);
            await fs.writeFile(metadataPath, JSON.stringify({ schemaVersion: 1, url: asset.url, sha256: asset.sha256, compressedBytes: bytes }), { flag: 'wx', mode: 0o400 });
            return { filename, sha256: asset.sha256, compressedBytes: bytes };
        } finally { await fs.rm(temporary, { force: true }); }
    })();
    inflight.set(filename, task);
    try { return await task; } finally { inflight.delete(filename); }
}

async function localFiles(asset, recipeDirectory, output) {
    const directory = path.resolve(recipeDirectory, asset.directory);
    if (!within(recipeDirectory, directory)) { throw new Error('App выходит за папку рецепта.'); }
    if (output && (within(directory, output) || within(output, directory))) { throw new Error('Папки app и output не должны пересекаться.'); }
    let current = recipeDirectory;
    for (const part of path.relative(recipeDirectory, directory).split(path.sep).filter(Boolean)) {
        current = path.join(current, part); const info = await fs.lstat(current);
        if (!info.isDirectory() || info.isSymbolicLink()) { throw new Error('Папка app не должна содержать ссылки.'); }
    }
    const files = []; let bytes = 0;
    async function read(prefix = '') {
        for (const item of await fs.readdir(path.join(directory, prefix), { withFileTypes: true })) {
            if (item.name.toLowerCase() === '.git' || item.name.toLowerCase() === '.npmrc' || /^\.env(?:\.|$)/i.test(item.name)) { continue; }
            const relative = prefix ? prefix + '/' + item.name : item.name, filename = path.join(directory, relative);
            if (!runtime.portablePath(relative)) { throw new Error('Непереносимый путь app.'); }
            const info = await fs.lstat(filename);
            if (info.isDirectory()) { await read(relative); continue; }
            if (!info.isFile() || info.nlink !== 1) { throw new Error('В app запрещены ссылки и специальные файлы.'); }
            bytes += info.size;
            if (files.length >= runtime.LIMITS.filesCount || bytes > runtime.LIMITS.unpackedBytes || info.size > runtime.LIMITS.compressedBytes) { throw new Error('App превышает лимиты поставки.'); }
            files.push({ relative, filename, size: info.size, ino: info.ino, mtimeMs: info.mtimeMs });
        }
    }
    await read();
    if (!files.some(file => file.relative === asset.entrypoint && file.size)) { throw new Error('Точка входа app отсутствует или пуста.'); }
    return files;
}

/** Dry-run проверяет локальное готовое приложение без сети и запуска программ. */
export async function inspectRuntimeSource(input, { recipeDirectory, output }) {
    const source = runtimeSource.validateRuntimeSource(input);
    for (const { app } of Object.values(source.assets)) { if (app.directory !== undefined) { await localFiles(app, recipeDirectory, output); } }
}

function launcher(adapter, appEntry, runtimeEntry) {
    return `import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const base=path.dirname(fileURLToPath(import.meta.url)),adapter=${JSON.stringify(adapter)},app=path.join(base,${JSON.stringify(appEntry)}),command=path.join(base,${JSON.stringify(runtimeEntry)});
const temporary=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-runtime-'));
const env={...process.env,TMPDIR:temporary,TMP:temporary,TEMP:temporary};
for(const key of Object.keys(env))if(/^(?:JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|CLASSPATH|DOTNET_ADDITIONAL_DEPS|DOTNET_STARTUP_HOOKS|DOTNET_SHARED_STORE|DOTNET_ROOT(?:_.*)?|DOTNET_ROLL_FORWARD(?:_.*)?|DOTNET_HOST_PATH)$/i.test(key))delete env[key];
if(adapter==='python'){delete env.PYTHONHOME;delete env.PYTHONPATH;env.PYTHONDONTWRITEBYTECODE='1';env.PYTHONNOUSERSITE='1';}
if(adapter==='java'){const bin=path.dirname(command);env.JAVA_HOME=path.basename(bin)==='bin'?path.dirname(bin):bin;}
if(adapter==='dotnet'){env.DOTNET_ROOT=path.dirname(command);env.DOTNET_CLI_HOME=temporary;env.DOTNET_BUNDLE_EXTRACT_BASE_DIR=temporary;env.DOTNET_MULTILEVEL_LOOKUP='0';env.DOTNET_SKIP_FIRST_TIME_EXPERIENCE='1';env.DOTNET_NOLOGO='1';}
const args=adapter==='java'?['-Dfile.encoding=UTF-8','-Dstdout.encoding=UTF-8','-Dstderr.encoding=UTF-8','-Djava.io.tmpdir='+temporary,'-jar',app,...process.argv.slice(2)]:adapter==='python'?['-B','-E','-s',app,...process.argv.slice(2)]:[app,...process.argv.slice(2)];
const child=spawn(command,args,{cwd:process.cwd(),env,shell:false,detached:false,stdio:'inherit'});
const signals=['SIGINT','SIGTERM','SIGHUP'];let finished=false,killTimer;
const handlers=new Map(signals.map(signal=>[signal,()=>{if(finished)return;child.kill(signal);killTimer??=setTimeout(()=>child.kill('SIGKILL'),2000);killTimer.unref();}]))
for(const [signal,handler]of handlers)process.on(signal,handler);
async function finish(code,signal){if(finished)return;finished=true;clearTimeout(killTimer);for(const [name,handler]of handlers)process.off(name,handler);await fs.rm(temporary,{recursive:true,force:true});if(signal){process.kill(process.pid,signal);}else process.exitCode=code??1;}
child.once('error',async()=>{console.error('Не удалось запустить автономный runtime.');await finish(1);});
child.once('exit',(code,signal)=>{void finish(code,signal);});
`;
}

async function prepareAsset(asset, prefix, context, { extractRelease, downloadAsset }) {
    const destination = path.join(context.directory, prefix);
    await fs.mkdir(destination);
    if (asset.directory !== undefined) {
        for (const file of await localFiles(asset, context.recipeDirectory)) {
            const output = path.join(destination, file.relative); await fs.mkdir(path.dirname(output), { recursive: true });
            await fs.copyFile(file.filename, output, constants.COPYFILE_EXCL);
            const after = await fs.lstat(file.filename);
            if (!after.isFile() || after.nlink !== 1 || after.size !== file.size || after.ino !== file.ino || after.mtimeMs !== file.mtimeMs) { throw new Error('App изменилось во время подготовки.'); }
        }
        return { source: 'local', files: true };
    }
    const downloaded = downloadAsset ? await downloadAsset(asset, context)
        : await downloadRuntimeAsset(asset, path.join(context.cacheDirectory ?? path.join(path.dirname(context.directory), '.source-cache'), 'runtime'));
    const verified = await archiveHash(downloaded.filename);
    if (verified.sha256 !== asset.sha256) { throw new Error('Не совпала SHA-256 подготовленного asset.'); }
    if (asset.format === 'file') {
        const output = path.join(destination, asset.entrypoint); await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.copyFile(downloaded.filename, output, constants.COPYFILE_EXCL);
    } else { await extractRelease(downloaded.filename, asset, destination); }
    return { url: asset.url, ...verified };
}

/** Все runtime получают тот же проверяемый архив и устанавливаются без системного SDK. */
export async function prepareRuntimeSource(recipe, context, helpers) {
    if (recipe.kind !== 'mcp') { throw new Error('Автономные runtime поддерживают только MCP.'); }
    const source = runtimeSource.validateRuntimeSource(recipe.source), bundle = source.assets[context.target];
    if (!bundle) { throw new Error('Для платформы отсутствует автономная поставка.'); }
    const app = await prepareAsset(bundle.app, 'app', context, helpers);
    const appEntry = 'app/' + bundle.app.entrypoint;
    let entrypoint = appEntry;
    const executables = (bundle.app.executables ?? []).map(file => 'app/' + file);
    let preparedRuntime;
    if (bundle.runtime) {
        preparedRuntime = await prepareAsset(bundle.runtime, 'runtime', context, helpers);
        const runtimeEntry = 'runtime/' + bundle.runtime.entrypoint;
        executables.push(runtimeEntry, ...(bundle.runtime.executables ?? []).map(file => 'runtime/' + file));
        entrypoint = 'entrypoint.mjs';
        await fs.writeFile(path.join(context.directory, entrypoint), launcher(source.adapter, appEntry, runtimeEntry), { flag: 'wx' });
    } else { executables.push(appEntry); }
    for (const filename of new Set([appEntry, ...(bundle.runtime ? ['runtime/' + bundle.runtime.entrypoint] : []), ...executables])) {
        const info = await fs.lstat(path.join(context.directory, filename));
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !info.size) { throw new Error('Точка входа или executable asset отсутствует, пуста или заменена ссылкой.'); }
    }
    for (const filename of new Set(executables)) { await fs.chmod(path.join(context.directory, filename), 0o755); }
    return { entrypoint, executables: [...new Set(executables)], upstream: { adapter: source.adapter, app, ...(preparedRuntime ? { runtime: preparedRuntime } : {}) } };
}

/** Metadata inspection may establish a missing upstream SHA, but never executes downloaded bytes. */
export async function downloadRuntimeCandidate(asset, cacheDirectory, transport) {
    if (asset.sha256) return downloadRuntimeAsset({ url: asset.url, sha256: asset.sha256, format: asset.format, entrypoint: 'candidate' }, cacheDirectory, transport);
    const url = new URL(asset.url);
    const response = await publicResponse(url, transport);
    const declared = response.headers['content-length'];
    if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) !== asset.bytes)) { response.destroy(); throw new Error('Размер файла релиза изменился после просмотра.'); }
    await fs.mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
    const folder = await fs.lstat(cacheDirectory);
    if (!folder.isDirectory() || folder.isSymbolicLink()) { response.destroy(); throw new Error('Кэш релиза должен быть обычной папкой.'); }
    const temporary = path.join(cacheDirectory, randomUUID() + '.partial');
    try {
        let bytes = 0; const hash = createHash('sha256');
        await pipeline(response, new Transform({ transform(chunk, _encoding, done) {
            bytes += chunk.length;
            if (bytes > Math.min(asset.bytes, runtime.LIMITS.compressedBytes)) { done(new Error('Файл релиза превышает заявленный размер.')); return; }
            hash.update(chunk); done(null, chunk);
        } }), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
        if (!bytes || bytes !== asset.bytes) throw new Error('Загрузка файла релиза оборвалась.');
        const sha256 = hash.digest('hex'), filename = path.join(cacheDirectory, sha256);
        await fs.chmod(temporary, 0o400);
        try { await fs.link(temporary, filename); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        await fs.rm(temporary, { force: true });
        const actual = await archiveHash(filename);
        if (actual.sha256 !== sha256 || actual.compressedBytes !== bytes) throw new Error('Кэш релиза повреждён.');
        const metadataPath = filename + '.json';
        try { await fs.writeFile(metadataPath, JSON.stringify({ schemaVersion: 1, url: asset.url, sha256, compressedBytes: bytes }), { flag: 'wx', mode: 0o400 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; }
        return { filename, sha256, compressedBytes: bytes };
    } finally { await fs.rm(temporary, { force: true }); }
}
