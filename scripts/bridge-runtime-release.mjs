import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {opencodeVersion} from './opencode-platforms.mjs';

const repository = fileURLToPath(new URL('../', import.meta.url));
const targets = ['darwin-arm64','darwin-x64','linux-arm64','linux-x64','linux-arm64-musl','linux-x64-musl','windows-arm64','windows-x64'];
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const archiveName = (target, version) => `neurocenter-asset-sync-${target}-${version}.tgz`;
const triplet = name => [name, name + '.json', name + '.sha256'];
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);

/** Опись закрепляет архив, его runtime и URL собственного неизменяемого GitHub release. */
export function validateBridgeRuntimeRelease(value) {
    if (!object(value) || value.schemaVersion !== 1 || !/^\d+\.\d+\.\d+$/.test(value.version || '') || !sha(value.buildId)
        || value.release !== `bridge-v${value.version}` || !Array.isArray(value.artifacts) || !value.artifacts.length || value.artifacts.length > targets.length) {
        throw new Error('Некорректная закреплённая опись автономного моста.');
    }
    const seen = new Set();
    for (const artifact of value.artifacts) {
        const metadata = artifact?.metadata;
        if (!object(metadata) || !targets.includes(metadata.target) || seen.has(metadata.target)
            || metadata.version !== value.version || metadata.buildId !== value.buildId || !/^24\.\d+\.\d+$/.test(metadata.nodeVersion || '')
            || typeof metadata.ragSupported !== 'boolean' || !Number.isSafeInteger(metadata.bytes) || metadata.bytes <= 0 || metadata.bytes > 1024 ** 3
            || !sha(metadata.sha256) || metadata.probeEngine?.version !== opencodeVersion || !sha(metadata.probeEngine?.sha256)
            || metadata.probeEngine?.file !== `bin/opencode-probe${metadata.target.startsWith('windows-') ? '.exe' : ''}`
            || Object.keys(metadata).some(key => !['version','target','nodeVersion','buildId','ragSupported','probeEngine','windowsJobHelper','sha256','bytes'].includes(key))
            || metadata.windowsJobHelper !== undefined && (metadata.windowsJobHelper?.file !== 'bin/neurocenter-job.exe' || !sha(metadata.windowsJobHelper?.sha256))) {
            throw new Error('Метаданные автономного моста не совпали с закреплённой версией и сборкой.');
        }
        const file = archiveName(metadata.target, value.version);
        if (artifact.file !== file || artifact.url !== `https://github.com/ghost-raven1/neurocenter/releases/download/${value.release}/${file}`) {
            throw new Error('Архив моста должен загружаться из закреплённого GitHub release Нейроцентра.');
        }
        seen.add(metadata.target);
    }
    return value;
}

export async function readBridgeRuntimeRelease({directory = repository} = {}) {
    const file = path.join(directory, 'scripts/bridge-runtime-release.json');
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 256 * 1024) { throw new Error('Некорректный файл описи автономного моста.'); }
    return validateBridgeRuntimeRelease(JSON.parse(await fs.readFile(file, 'utf8')));
}

/** Кеш подтверждается потоковой SHA; при поставке дополнительно сравниваются все закреплённые метаданные. */
export async function bridgeRuntimeCached({directory, target, version, buildId, metadata: pinned}) {
    const archive = path.join(directory, archiveName(target, version));
    try {
        const stats = await Promise.all(triplet(archive).map(file => fs.lstat(file)));
        if (!stats.every(info => info.isFile() && !info.isSymbolicLink()) || stats[1].size > 65536 || stats[2].size > 1024) { return false; }
        const metadata = JSON.parse(await fs.readFile(archive + '.json', 'utf8'));
        if (metadata.version !== version || metadata.target !== target || metadata.buildId !== buildId
            || !/^24\./.test(metadata.nodeVersion || '') || metadata.probeEngine?.version !== opencodeVersion
            || !Number.isSafeInteger(metadata.bytes) || metadata.bytes <= 0 || metadata.bytes !== stats[0].size || !sha(metadata.sha256)
            || pinned && !isDeepStrictEqual(metadata, pinned) || (await fs.readFile(archive + '.sha256', 'utf8')).trim() !== metadata.sha256) { return false; }
        const digest = createHash('sha256'); let bytes = 0;
        for await (const chunk of createReadStream(archive)) {
            bytes += chunk.length; if (bytes > metadata.bytes) { return false; } digest.update(chunk);
        }
        return bytes === metadata.bytes && digest.digest('hex') === metadata.sha256;
    } catch { return false; }
}

/** Публикация группы файлов сохраняет прежний комплект и откатывает все rename при сбое. */
export async function publishBridgeRuntimeFiles({candidate, previous, directory, files}) {
    const saved = new Set();
    await fs.mkdir(previous);
    for (const file of files) {
        try {
            const source = path.join(directory, file), backup = path.join(previous, file);
            const info = await fs.lstat(source);
            if (!info.isFile() || info.isSymbolicLink()) { throw new Error('Путь автономного пакета занят посторонними данными.'); }
            try { await fs.link(source, backup); }
            catch (error) { if (error.code === 'ENOENT') { throw error; } await fs.cp(source, backup, {preserveTimestamps: true}); }
            saved.add(file);
        } catch (error) { if (error.code !== 'ENOENT') { throw error; } }
    }
    try { for (const file of files) { await fs.rename(path.join(candidate, file), path.join(directory, file)); } }
    catch (error) {
        const failed = [];
        for (const file of files) {
            try {
                if (saved.has(file)) { await fs.rename(path.join(previous, file), path.join(directory, file)); }
                else { await fs.rm(path.join(directory, file), {force: true}); }
            } catch { failed.push(file); }
        }
        if (failed.length) { throw Object.assign(new Error(`Не удалось восстановить ${failed.join(', ')}. Резервный комплект: ${previous}`), {keepTemporary: true}); }
        throw error;
    }
}

function githubDownload(value) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port
        || !['github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(url.hostname)) {
        throw new Error('Перенаправление загрузки моста ведёт за пределы HTTPS GitHub.');
    }
    return url.href;
}

async function downloadArchive(artifact, filename, request, {signal: cancellation,onBytes=()=>{}}={}) {
    let response, current = artifact.url;
    const signal = AbortSignal.any([AbortSignal.timeout(10 * 60 * 1000),...(cancellation?[cancellation]:[])]);
    for (let hop = 0; hop < 4; hop++) {
        response = await request(githubDownload(current), {redirect: 'manual', signal});
        if (![301,302,303,307,308].includes(response.status)) { break; }
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location || hop === 3) { throw new Error('GitHub не выдал архив автономного моста.'); }
        current = new URL(location, current).href;
    }
    if (!response?.ok || !response.body) { await response?.body?.cancel(); throw new Error(`GitHub не выдал архив моста (HTTP ${response?.status || 0}).`); }
    const expected = artifact.metadata;
    if (response.headers.get('content-length') !== null && response.headers.get('content-length') !== String(expected.bytes)) {
        await response.body.cancel(); throw new Error('Размер архива моста не совпал с закреплённой описью.');
    }
    const file = await fs.open(filename, 'wx', 0o600), reader = response.body.getReader(), digest = createHash('sha256'); let bytes = 0;
    try {
        while (true) {
            signal.throwIfAborted();const chunk = await reader.read(); if (chunk.done) { break; }
            bytes += chunk.value.length;
            if (bytes > expected.bytes) { throw new Error('Архив моста превысил закреплённый размер.'); }
            digest.update(chunk.value); await file.writeFile(chunk.value);await onBytes(chunk.value.length);
        }
        if (bytes !== expected.bytes || digest.digest('hex') !== expected.sha256) { throw new Error('Размер или SHA-256 архива моста не совпали с закреплённой описью.'); }
        await file.sync();
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); await file.close(); }
}

/** Загружает только закреплённые архивы; служебные sidecar создаются из доверенной описи до публикации. */
export async function hydrateBridgeRuntimeRelease({directory = repository, release, targets: selected, fetch: request = globalThis.fetch,
    lock = true, publish = publishBridgeRuntimeFiles,signal,onProgress=()=>{}} = {}) {
    const pinned = validateBridgeRuntimeRelease(release || await readBridgeRuntimeRelease({directory}));
    const manifest = JSON.parse(await fs.readFile(path.join(directory, 'mcp/neurocenter-asset-sync/package.json'), 'utf8'));
    if (manifest.version !== pinned.version) { throw new Error('Версия пакета моста отличается от закреплённого release. Подготовьте согласованную поставку.'); }
    const requested = selected === undefined ? pinned.artifacts.map(item => item.metadata.target) : selected;
    if (!Array.isArray(requested) || requested.some(target => !pinned.artifacts.some(item => item.metadata.target === target))) {
        throw new Error('Выбранная цель отсутствует в закреплённой поставке моста.');
    }
    const artifacts = pinned.artifacts.filter(item => requested.includes(item.metadata.target));
    const output = path.join(directory, 'bridge-dist/runtime');
    const missing = [];
    for (const artifact of artifacts) {
        signal?.throwIfAborted();
        if (!await bridgeRuntimeCached({directory: output, target: artifact.metadata.target, version: pinned.version, buildId: pinned.buildId, metadata: artifact.metadata})) { missing.push(artifact); }
    }
    const result = {version: pinned.version, buildId: pinned.buildId, targets: artifacts.map(item => item.metadata.target), downloaded: []};
    if (!missing.length) { return result; }
    const lockDirectory = path.join(directory, '.run/bridge-runtimes.lock'); let owned = false, temporary, keepTemporary = false;
    try {
        if (lock) {
            await fs.mkdir(path.dirname(lockDirectory), {recursive: true});
            try { await fs.mkdir(lockDirectory); owned = true; }
            catch (error) { if (error.code !== 'EEXIST') { throw error; } throw new Error(`Подготовка автономного моста уже выполняется. Проверьте блокировку: ${lockDirectory}`); }
        }
        await fs.mkdir(output, {recursive: true});
        temporary = await fs.mkdtemp(path.join(output, '.bridge-release-'));
        const candidate = path.join(temporary, 'result'); await fs.mkdir(candidate);
        let completed=0;const total=missing.reduce((sum,item)=>sum+item.metadata.bytes,0);
        for (const artifact of missing) {
            signal?.throwIfAborted();
            // Другой процесс мог закончить подготовку между проверкой кеша и получением блокировки.
            if (await bridgeRuntimeCached({directory: output, target: artifact.metadata.target, version: pinned.version, buildId: pinned.buildId, metadata: artifact.metadata})) { continue; }
            await downloadArchive(artifact, path.join(candidate, artifact.file), request,{signal,onBytes:async bytes=>{
                completed+=bytes;await onProgress({section:'bridge',stage:'downloading',message:'Загружаем автономный мост.',completed,total});
            }});
            await fs.writeFile(path.join(candidate, artifact.file + '.json'), JSON.stringify(artifact.metadata, null, 2) + '\n', {flag: 'wx'});
            await fs.writeFile(path.join(candidate, artifact.file + '.sha256'), artifact.metadata.sha256 + '\n', {flag: 'wx'});
            result.downloaded.push(artifact.metadata.target);
        }
        const files = missing.filter(item => result.downloaded.includes(item.metadata.target)).flatMap(item => triplet(item.file));
        signal?.throwIfAborted();
        if (files.length) { await publish({candidate, previous: path.join(temporary, 'previous'), directory: output, files}); }
        return result;
    } catch (error) { keepTemporary = error.keepTemporary === true; throw error; }
    finally {
        if (temporary && !keepTemporary) { await fs.rm(temporary, {recursive: true, force: true}); }
        if (owned) { await fs.rmdir(lockDirectory); }
    }
}
