import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import path from 'node:path';
import {opencodeVersion} from './opencode-platforms.mjs';

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
        if (artifact.file !== file || ![`https://github.com/ghost-raven1/neurocenter-assets/releases/download/${value.release}/${file}`, `https://github.com/ghost-raven1/neurocenter/releases/download/${value.release}/${file}`].includes(artifact.url)) {
            throw new Error('Архив моста должен загружаться из закреплённого GitHub release Нейроцентра.');
        }
        seen.add(metadata.target);
    }
    return value;
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
