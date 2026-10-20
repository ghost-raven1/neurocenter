import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import runtime from '../../services/shared/runtime-artifacts.cjs';
import repositorySource from '../../services/shared/repository-source.cjs';
import { prepareRuntimeSource } from './runtime-source.mjs';
import { applyFetchCompatibility } from './recipes/fetch-mcp.mjs';

const require = createRequire(new URL('../../services/catalog-service/package.json', import.meta.url));
const inflight = new Map();
const repositoryLimits = { filesCount: 20000, totalBytes: 1024 ** 3, fileBytes: 256 * 1024 ** 2 };
const digest = value => createHash('sha256').update(value).digest('hex');

async function hashArchive(filename) {
    const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const before = await file.stat();
        if (!before.isFile() || before.nlink !== 1 || !before.size || before.size > runtime.LIMITS.compressedBytes) { throw new Error('Некорректный архив репозитория в кэше.'); }
        const hash = createHash('sha256');
        let bytes = 0;
        for await (const chunk of file.createReadStream({ autoClose: false })) {
            bytes += chunk.length;
            if (bytes > runtime.LIMITS.compressedBytes) { throw new Error('Архив репозитория превышает 256 МиБ.'); }
            hash.update(chunk);
        }
        const after = await file.stat();
        if (bytes !== before.size || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || after.nlink !== 1) { throw new Error('Архив репозитория изменился во время проверки.'); }
        return { sha256: hash.digest('hex'), compressedBytes: bytes };
    } finally { await file.close(); }
}

async function cachedArchive(source, archivePath, metadataPath) {
    let info;
    try { info = await fs.lstat(metadataPath); }
    catch (error) { if (error.code === 'ENOENT') { return undefined; } throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 4096) { throw new Error('Некорректная запись кэша репозитория.'); }
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
    if (metadata.schemaVersion !== 1 || metadata.url !== source.url || metadata.commit !== source.commit || !/^[a-f0-9]{64}$/.test(metadata.sha256)) { throw new Error('Кэш принадлежит другому репозиторию или commit.'); }
    const actual = await hashArchive(archivePath);
    if (actual.sha256 !== metadata.sha256 || actual.compressedBytes !== metadata.compressedBytes) { throw new Error('Архив репозитория в кэше повреждён.'); }
    return { archivePath, ...actual };
}

/** Публичный GitHub скачивается по неизменяемому commit, без git, cookies и перенаправлений. */
export async function downloadRepositoryArchive(raw, cacheDirectory, { fetch: request = globalThis.fetch } = {}) {
    const source = repositorySource.validateRepositorySource(raw);
    const { owner, repository } = repositorySource.parseRepositoryUrl(source.url);
    const key = digest(source.url + '\0' + source.commit);
    const archivePath = path.join(cacheDirectory, key + '.tar.gz');
    const metadataPath = path.join(cacheDirectory, key + '.json');
    if (inflight.has(archivePath)) { return inflight.get(archivePath); }
    const task = (async () => {
        await fs.mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
        const info = await fs.lstat(cacheDirectory);
        if (!info.isDirectory() || info.isSymbolicLink()) { throw new Error('Кэш репозитория должен быть обычной папкой.'); }
        const cached = await cachedArchive(source, archivePath, metadataPath);
        if (cached) { return cached; }
        const response = await request(`https://codeload.github.com/${owner}/${repository}/tar.gz/${source.commit}`, {
            redirect: 'error', signal: AbortSignal.timeout(180_000), headers: { Accept: 'application/x-gzip' },
        });
        if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Не удалось скачать публичный репозиторий по выбранному commit.'); }
        const declared = response.headers.get('content-length');
        if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > runtime.LIMITS.compressedBytes)) {
            await response.body.cancel(); throw new Error('Архив репозитория превышает 256 МиБ.');
        }
        const temporary = archivePath + '.' + randomUUID() + '.partial';
        try {
            let bytes = 0;
            const hash = createHash('sha256');
            await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _encoding, callback) {
                bytes += chunk.length;
                if (bytes > runtime.LIMITS.compressedBytes) { callback(new Error('Архив репозитория превышает 256 МиБ.')); return; }
                hash.update(chunk); callback(null, chunk);
            } }), createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
            if (!bytes || declared !== null && Number(declared) !== bytes) { throw new Error('Загрузка архива репозитория оборвалась.'); }
            const metadata = { schemaVersion: 1, url: source.url, commit: source.commit, sha256: hash.digest('hex'), compressedBytes: bytes };
            await fs.chmod(temporary, 0o400);
            await fs.rename(temporary, archivePath);
            await fs.writeFile(metadataPath, JSON.stringify(metadata), { flag: 'wx', mode: 0o400 });
            return { archivePath, sha256: metadata.sha256, compressedBytes: bytes };
        } finally { await fs.rm(temporary, { force: true }); }
    })();
    inflight.set(archivePath, task);
    try { return await task; } finally { inflight.delete(archivePath); }
}

/** Codeload содержит один корневой каталог с именем репозитория и точным commit. */
export async function repositoryRoot(archivePath, source) {
    const { owner, repository } = repositorySource.parseRepositoryUrl(source.url);
    const expected = new Set([`${repository}-${source.commit}`, `${owner}-${repository}-${source.commit}`].map(value => value.toLowerCase()));
    const tar = require('tar');
    let root;
    let headers = 0, files = 0, bytes = 0;
    const parser = tar.t({ strict: true, filter: (name, entry) => {
        try {
            const normalized = name.replace(/^(?:\.\/)+/, '').replace(/\/$/, '');
            const first = normalized.split('/')[0];
            headers++;
            if (entry.type === 'File') { files++; bytes += entry.size; }
            if (!runtime.portablePath(normalized) || !expected.has(first.toLowerCase()) || root && root !== first
                || !['File', 'Directory'].includes(entry.type) || normalized === first && entry.type !== 'Directory'
                || headers > 2 * runtime.LIMITS.filesCount || files > runtime.LIMITS.filesCount || bytes > runtime.LIMITS.unpackedBytes) {
                throw new Error('Архив репозитория содержит ссылку, небезопасный путь или другой корневой каталог.');
            }
            root = first;
            return true;
        } catch (error) { parser.abort(error); return false; }
    } });
    await pipeline(createReadStream(archivePath), parser);
    if (!root) { throw new Error('Архив репозитория пуст.'); }
    return root;
}

async function preserveLicenses(from, destination) {
    for (const name of await fs.readdir(from)) {
        if (!/^(?:licen[sc]e|notice)(?:\.[a-z0-9._-]+)?$/i.test(name)) { continue; }
        const filename = path.join(from, name);
        const info = await fs.lstat(filename);
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1048576) { throw new Error('Лицензия репозитория должна быть обычным файлом до 1 МиБ.'); }
        await fs.mkdir(destination, { recursive: true });
        await fs.copyFile(filename, path.join(destination, name), constants.COPYFILE_EXCL);
    }
}

/** Закреплённый рецепт поставки не может измениться между просмотром и упаковкой. */
async function prepareRepositoryContent(recipe, context, directory, { prepareProject, extractRelease }) {
    if (recipe.source.snapshotSha256) {
        return prepareRuntimeSource({ ...recipe, source: recipe.source.runtimeSource }, { ...context, recipeDirectory: path.join(context.recipeDirectory, directory) }, { extractRelease });
    }
    if (!recipe.source.runtimeSource) {
        return prepareProject({ ...recipe, source: { type: 'project', directory, entrypoint: recipe.source.entrypoint } },
            context, { limits: repositoryLimits });
    }
    const project = path.join(context.recipeDirectory, directory);
    const filename = path.join(project, recipe.source.entrypoint);
    const info = await fs.lstat(filename);
    if (!info.isFile() || info.nlink !== 1 || !info.size || info.size > 65536) { throw new Error('Рецепт поставки должен быть обычным файлом до 64 КиБ.'); }
    const bytes = await fs.readFile(filename);
    if (digest(bytes) !== recipe.source.manifestSha256) { throw new Error('Рецепт поставки не совпадает с закреплённым SHA.'); }
    const manifest = repositorySource.validateRepositoryManifest(bytes);
    if (!isDeepStrictEqual(manifest.source, recipe.source.runtimeSource)) { throw new Error('Адаптер поставки изменился после проверки репозитория.'); }
    return prepareRuntimeSource({ ...recipe, source: manifest.source }, { ...context, recipeDirectory: project }, { extractRelease });
}

/** Репозиторий использует общий компилятор JS/TS или адаптер закреплённой автономной поставки. */
export async function prepareRepository(recipe, context, { extractRelease, prepareProject }) {
    const source = repositorySource.validateRepositorySource(recipe.source);
    if (source.release) {
        const result = await prepareRuntimeSource({ ...recipe, source: source.runtimeSource }, context, { extractRelease });
        await fs.writeFile(path.join(context.directory, 'repository.json'), JSON.stringify({ url: source.url, commit: source.commit, release: source.release }, null, 2) + '\n', { flag: 'wx' });
        return { ...result, upstream: { ...result.upstream, repository: source.url, commit: source.commit, release: source.release } };
    }
    const cache = context.cacheDirectory ?? path.join(path.dirname(context.directory), '.repository-cache');
    const archive = await downloadRepositoryArchive(source, cache);
    if (source.snapshotSha256 && archive.sha256 !== source.snapshotSha256) throw new Error('Снимок репозитория изменился после проверки.');
    const root = await repositoryRoot(archive.archivePath, source);
    const extracted = await fs.mkdtemp(path.join(path.dirname(context.directory), '.repository-source-'));
    try {
        await extractRelease(archive.archivePath, { format: 'tar.gz' }, extracted);
        const directory = [root, source.subdirectory].filter(Boolean).join('/');
        const patch = await applyFetchCompatibility(source, path.join(extracted, directory));
        const compatibility = patch ? { compatibilityPatches: [patch] } : {};
        const result = await prepareRepositoryContent(recipe, { ...context, recipeDirectory: extracted }, directory, { prepareProject, extractRelease });
        await preserveLicenses(path.join(extracted, root), path.join(context.directory, 'upstream-licenses/root'));
        if (source.subdirectory) { await preserveLicenses(path.join(extracted, directory), path.join(context.directory, 'upstream-licenses/package')); }
        await fs.writeFile(path.join(context.directory, 'repository.json'), JSON.stringify({ url: source.url, commit: source.commit,
            ...(source.subdirectory ? { subdirectory: source.subdirectory } : {}), archiveSha256: archive.sha256, ...compatibility,
            ...(source.manifestSha256 ? { manifestSha256: source.manifestSha256, adapter: source.runtimeSource.adapter } : {}) }, null, 2) + '\n', { flag: 'wx' });
        return { ...result, upstream: { ...result.upstream, repository: source.url, commit: source.commit,
            ...(source.subdirectory ? { subdirectory: source.subdirectory } : {}), archiveSha256: archive.sha256, archiveBytes: archive.compressedBytes, ...compatibility } };
    } finally { await fs.rm(extracted, { recursive: true, force: true }); }
}
