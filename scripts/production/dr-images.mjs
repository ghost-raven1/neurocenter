#!/usr/bin/env node
// DR-бандл образов релиза (AD-OP-2, AD-OP-4): docker save по точному image ID из
// верифицированного release-манифеста, опись с SHA256 каждого tar, docker load с
// сверкой ID и передача на S3 тем же транспортом, что и recovery-комплекты.
// Bundle ключится на релиз (commit + release + image ID), а не на бэкап: повторная
// сборка для того же релиза — no-op. Опись не несёт секретов.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { applicationServices, docker } from './compose-client.mjs';
import { validateReleaseManifest, releasePattern } from './release-manifest.mjs';
import { digestFile } from './recovery-files.mjs';
import { createExternalS3Store, externalBackupConfiguration, EXTERNAL_CHUNK_BYTES } from './external-backup.mjs';

export const imageBundleFormat = 'neurocenter-image-bundle-v1';
const commitPattern = /^[a-f0-9]{40}$/;
const imagePattern = /^sha256:[a-f0-9]{64}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const bundleIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const REMOTE_FORMAT = 'neurocenter-image-bundle-v1';
const MANIFEST_LIMIT = 1024 * 1024;
const tarNames = Object.freeze({ ...Object.fromEntries(applicationServices.map((service) => [service, service + '.tar'])), postgres: 'postgres.tar' });

/** Фиксированный набор полей не позволяет описи подменить образ, путь, размер или SHA. */
export function validateImageBundle(bundle) {
    const invalid = () => {
        throw new Error('Некорректная опись image-bundle');
    };
    if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) invalid();
    if (Object.keys(bundle).sort().join(',') !== 'bundleId,commit,createdAt,format,images,postgresImage,release')
        invalid();
    if (bundle.format !== imageBundleFormat) invalid();
    if (typeof bundle.bundleId !== 'string' || !bundleIdPattern.test(bundle.bundleId)) invalid();
    if (typeof bundle.commit !== 'string' || !commitPattern.test(bundle.commit)) invalid();
    if (typeof bundle.release !== 'string' || !releasePattern.test(bundle.release) || bundle.release === 'latest')
        invalid();
    if (!Number.isFinite(Date.parse(bundle.createdAt || ''))) invalid();
    const entries = bundle.images;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) invalid();
    if (JSON.stringify(Object.keys(entries).sort()) !== JSON.stringify([...applicationServices].sort())) invalid();
    for (const service of applicationServices) validateBundleEntry(entries[service], tarNames[service]);
    validateBundleEntry(bundle.postgresImage, tarNames.postgres);
    return bundle;
}

function validateBundleEntry(entry, tarName) {
    const invalid = () => {
        throw new Error('Некорректная запись image-bundle');
    };
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) invalid();
    if (Object.keys(entry).sort().join(',') !== 'file,imageId,sha256,size') invalid();
    if (typeof entry.imageId !== 'string' || !imagePattern.test(entry.imageId)) invalid();
    if (typeof entry.sha256 !== 'string' || !sha256Pattern.test(entry.sha256)) invalid();
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0) invalid();
    if (entry.file !== 'images/' + tarName) invalid();
}

/** Атомарная запись 0600 в закрытый каталог (idiom writeReleaseManifest: tmp + rename + fsync). */
export async function writeImageBundle(filename, bundle) {
    const value = JSON.stringify(validateImageBundle(bundle), null, 2) + '\n';
    const directory = path.dirname(filename);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.mode & 0o077)
        throw new Error('Каталог image-bundle должен быть обычным каталогом с правами 700');
    const temporary = filename + '.' + process.pid + '.tmp';
    try {
        await writeFile(temporary, value, { flag: 'wx', mode: 0o600, flush: true });
        await rename(temporary, filename);
        const handle = await open(directory, 'r');
        try {
            await handle.sync();
        } finally {
            await handle.close();
        }
    } finally {
        await rm(temporary, { force: true });
    }
    return value;
}

export async function readImageBundle(directory) {
    const filename = path.join(directory, 'image-bundle.json');
    const info = await lstat(filename);
    if (!info.isFile() || info.nlink !== 1 || info.size > MANIFEST_LIMIT) {
        throw new Error('Некорректный файл описи image-bundle');
    }
    return validateImageBundle(JSON.parse(await readFile(filename, 'utf8')));
}

/** Все пары (svc/ID) бандла: 7 приложений + postgres. */
export function bundleEntries(bundle) {
    const entries = Object.fromEntries(applicationServices.map((service) => [service, bundle.images[service]]));
    entries.postgres = bundle.postgresImage;
    return entries;
}

function assertBundleForRelease(bundle, manifest) {
    if (bundle.commit !== manifest.commit) {
        throw new Error(
            'Image-bundle собран для другого релиза (commit ' +
                bundle.commit.slice(0, 12) +
                ' ≠ ' +
                manifest.commit.slice(0, 12) +
                '): пересоберите бандл для этого release-манифеста',
        );
    }
    if (bundle.release !== manifest.release) {
        throw new Error('Image-bundle собран для другой метки релиза (' + bundle.release + ' ≠ ' + manifest.release + ')');
    }
}

/** docker save каждого образа по точному image ID; tar'ы пишутся потоком, без registry и pull. */
export async function bundleImages(manifest, destination, { run = docker, hashFile = digestFile } = {}) {
    const release = validateReleaseManifest(manifest);
    await mkdir(destination, { recursive: true, mode: 0o700 });
    const root = await lstat(destination);
    if (!root.isDirectory() || root.isSymbolicLink() || root.mode & 0o077)
        throw new Error('Каталог image-bundle должен быть обычным каталогом с правами 700');
    const wanted = Object.fromEntries([
        ...applicationServices.map((service) => [service, release.images[service]]),
        ['postgres', release.postgresImage],
    ]);
    const manifestFile = path.join(destination, 'image-bundle.json');
    let existing = null;
    try {
        existing = validateImageBundle(JSON.parse(await readFile(manifestFile, 'utf8')));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    // Idempotency: совпавшая опись того же (commit+release+image ID) не пересобирает tar'ы.
    if (existing) {
        assertBundleForRelease(existing, release);
        for (const [name, entry] of Object.entries(bundleEntries(existing))) {
            if (entry.imageId !== wanted[name]) {
                throw new Error(
                    'Image-bundle уже существует для других image ID (' +
                        name +
                        ': ' +
                        entry.imageId.slice(7, 19) +
                        ' ≠ ' +
                        wanted[name].slice(7, 19) +
                        '): выберите новое назначение',
                );
            }
            const actual = await hashFile(path.join(destination, entry.file)).catch((error) => {
                if (error.code === 'ENOENT') return null;
                throw error;
            });
            if (actual !== entry.sha256) {
                throw new Error(
                    'SHA256 tar ' + name + ' не совпадает с описью: tar повреждён или подменён, пересборка запрещена',
                );
            }
        }
        return { ok: true, destination, images: Object.keys(wanted).length, rebuilt: 0, noOp: true };
    }
    // Повтор после прерванной сборки: каталог images может уже существовать (recursive, без EEXIST).
    const imagesDir = path.join(destination, 'images');
    await mkdir(imagesDir, { recursive: true, mode: 0o700 });
    const imagesInfo = await lstat(imagesDir);
    if (!imagesInfo.isDirectory() || imagesInfo.isSymbolicLink() || imagesInfo.mode & 0o077)
        throw new Error('Каталог image-bundle/images должен быть обычным каталогом с правами 700');
    // docker save пишет outputFile через 'wx' (exclusive create): прерванные tar'ы предыдущей
    // попытки блокируют повтор (EEXIST), поэтому перед пересборкой удаляем все файлы каталога.
    for (const name of await readdir(imagesDir)) {
        const entry = await lstat(path.join(imagesDir, name));
        if (entry.isSymbolicLink() || !entry.isFile()) {
            throw new Error('Каталог image-bundle/images содержит неожиданный объект ' + name);
        }
        await rm(path.join(imagesDir, name));
    }
    const images = {};
    for (const [name, imageId] of Object.entries(wanted)) {
        const filename = path.join(destination, 'images', tarNames[name]);
        await run(['save', imageId], { outputFile: filename, timeout: 60 * 60 * 1000 });
        images[name] = {
            imageId,
            file: 'images/' + tarNames[name],
            sha256: await hashFile(filename),
            size: (await stat(filename)).size,
        };
    }
    const bundle = {
        format: imageBundleFormat,
        bundleId: 'images-' + release.commit.slice(0, 12),
        commit: release.commit,
        release: release.release,
        createdAt: new Date().toISOString(),
        images: Object.fromEntries(applicationServices.map((service) => [service, images[service]])),
        postgresImage: images.postgres,
    };
    await writeImageBundle(manifestFile, bundle);
    return {
        ok: true,
        destination,
        images: Object.keys(wanted).length,
        rebuilt: Object.keys(wanted).length,
        noOp: false,
        sha256: createHash('sha256').update(await readFile(manifestFile)).digest('hex'),
    };
}

/** docker load каждого tar; ID после загрузки обязан совпасть с описью и release-манифестом. */
export async function verifyImageBundle(source, manifest, { run = docker, hashFile = digestFile } = {}) {
    const release = validateReleaseManifest(manifest);
    const bundle = await readImageBundle(source);
    assertBundleForRelease(bundle, release);
    const expected = Object.fromEntries([
        ...applicationServices.map((service) => [service, release.images[service]]),
        ['postgres', release.postgresImage],
    ]);
    const loaded = {};
    for (const [name, entry] of Object.entries(bundleEntries(bundle))) {
        const filename = path.join(source, entry.file);
        const actual = await hashFile(filename).catch((error) => {
            if (error.code === 'ENOENT') throw new Error('Отсутствует tar ' + name + ': ' + entry.file);
            throw error;
        });
        if (actual !== entry.sha256) {
            throw new Error('SHA256 tar ' + name + ' не совпадает с описью image-bundle');
        }
        loaded[name] = await loadedImageId(filename, run);
        if (loaded[name] !== entry.imageId) {
            throw new Error(
                'Image ID после docker load не совпадает с описью (' +
                    name +
                    ': ' +
                    loaded[name] +
                    ' ≠ ' +
                    entry.imageId +
                    ')',
            );
        }
        if (loaded[name] !== expected[name]) {
            throw new Error(
                'Image ID не совпадает с release-манифестом (' + name + ': ' + loaded[name] + ' ≠ ' + expected[name] + ')',
            );
        }
    }
    return {
        ok: true,
        format: bundle.format,
        bundleId: bundle.bundleId,
        commit: bundle.commit,
        release: bundle.release,
        images: loaded,
    };
}

/**
 * Загрузка всех образов бандла на хост restore; выполняется до restoreProduction.
 * `docker save` по image ID не сохраняет теги (RepoTags: null), а production-комплект
 * резолвит приложения по `neurocenter/<service>:<release>`: после проверки ID каждый
 * образ приложения помечается меткой релиза из описи, чтобы стать доступен compose.
 * PostgreSQL в комплекте указан по digest и тегом не помечается.
 */
export async function loadImageBundle(source, { run = docker } = {}) {
    const bundle = await readImageBundle(source);
    const loaded = {};
    const tagged = {};
    for (const [name, entry] of Object.entries(bundleEntries(bundle))) {
        const filename = path.join(source, entry.file);
        loaded[name] = await loadedImageId(filename, run);
        if (loaded[name] !== entry.imageId) {
            throw new Error(
                'Image ID после docker load не совпадает с описью (' +
                    name +
                    ': ' +
                    loaded[name] +
                    ' ≠ ' +
                    entry.imageId +
                    ')',
            );
        }
        if (name !== 'postgres') {
            const tag = 'neurocenter/' + name + ':' + bundle.release;
            await run(['tag', loaded[name], tag]);
            tagged[name] = tag;
        }
    }
    return { ok: true, bundleId: bundle.bundleId, release: bundle.release, images: loaded, tagged };
}

/** docker load возвращает «Loaded image ID: …» (save по ID) или «Loaded image: ref». */
async function loadedImageId(filename, run) {
    const output = await run(['load'], { inputFile: filename, timeout: 60 * 60 * 1000 });
    const byId = output.match(/Loaded image ID: (sha256:[a-f0-9]{64})/);
    if (byId) return byId[1];
    const byRef = output.match(/Loaded image: (\S+)/);
    if (byRef) {
        const inspected = JSON.parse(await run(['image', 'inspect', byRef[1]]))[0];
        if (typeof inspected?.Id !== 'string' || !imagePattern.test(inspected.Id))
            throw new Error('Не удалось определить ID загруженного образа');
        return inspected.Id;
    }
    throw new Error('Не удалось определить ID загруженного образа');
}

const objectKey = (backupId, name, index) =>
    REMOTE_FORMAT + '/' + backupId + '/data/' + name + '/' + String(index).padStart(8, '0');
const digest = (value) => createHash('sha256').update(value).digest('hex');

async function checkedGet(store, key, size, sha256) {
    const bytes = await store.get(key, size);
    if (bytes.length !== size || digest(bytes) !== sha256) {
        throw new Error('SHA256 или размер внешнего объекта image-bundle не совпадает');
    }
    return bytes;
}

async function assertPrivate(store) {
    if (typeof store.assertPrivate !== 'function') {
        throw new Error('Транспорт не поддерживает подтверждение приватности S3');
    }
    await store.assertPrivate();
}

/** Публикует опись последней, только после чтения и SHA-проверки каждого блока. */
export async function uploadImageBundle({ source, backupId, store }) {
    if (typeof backupId !== 'string' || !bundleIdPattern.test(backupId)) {
        throw new Error('Нужен безопасный ID image-bundle');
    }
    const bundle = await readImageBundle(source);
    const raw = await readFile(path.join(source, 'image-bundle.json'));
    const manifestSha256 = digest(raw);
    let bytes = 0;
    for (const [name, entry] of Object.entries(bundleEntries(bundle))) {
        const handle = await open(path.join(source, entry.file), constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = await handle.stat();
        try {
            if (!before.isFile() || before.nlink !== 1 || before.size !== entry.size)
                throw new Error('Тар ' + name + ' изменился перед передачей');
            const full = createHash('sha256');
            let offset = 0;
            let index = 0;
            while (offset < before.size) {
                const chunk = Buffer.alloc(Math.min(EXTERNAL_CHUNK_BYTES, before.size - offset));
                let used = 0;
                while (used < chunk.length) {
                    const read = await handle.read(chunk, used, chunk.length - used, offset + used);
                    if (!read.bytesRead) throw new Error('Тар ' + name + ' усечён');
                    used += read.bytesRead;
                }
                const key = objectKey(backupId, name, index++);
                await assertPrivate(store);
                await store.put(key, chunk);
                full.update(await checkedGet(store, key, chunk.length, digest(chunk)));
                offset += chunk.length;
            }
            const after = await handle.stat();
            if (full.digest('hex') !== entry.sha256 || before.ino !== after.ino || after.nlink !== 1) {
                throw new Error('SHA256 tar ' + name + ' изменился во время передачи');
            }
            bytes += before.size;
        } finally {
            await handle.close();
        }
    }
    await assertPrivate(store);
    await store.put(REMOTE_FORMAT + '/' + backupId + '/manifest.json', raw);
    await checkedGet(store, REMOTE_FORMAT + '/' + backupId + '/manifest.json', raw.length, manifestSha256);
    return {
        ok: true,
        backupId,
        format: bundle.format,
        commit: bundle.commit,
        release: bundle.release,
        manifestSha256,
        images: Object.keys(bundleEntries(bundle)).length,
        bytes,
        transportFormat: REMOTE_FORMAT,
        verification: 'sha256-readback',
    };
}

/** Скачивает полный бандл в новый закрытый каталог и сверяет опись и SHA каждого tar. */
export async function downloadImageBundle({ destination, backupId, store }) {
    if (typeof backupId !== 'string' || !bundleIdPattern.test(backupId)) {
        throw new Error('Нужен безопасный ID image-bundle');
    }
    if (!destination) throw new Error('Нужен новый каталог назначения');
    const parent = await lstat(path.dirname(path.resolve(destination)));
    if (!parent.isDirectory() || parent.mode & 0o077) {
        throw new Error('Родитель назначения должен иметь права 700');
    }
    destination = path.join(path.dirname(path.resolve(destination)), path.basename(path.resolve(destination)));
    try {
        await lstat(destination);
        throw new Error('Целевой каталог уже существует; выберите новое имя');
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
    }
    await assertPrivate(store);
    const raw = await store.get(REMOTE_FORMAT + '/' + backupId + '/manifest.json', MANIFEST_LIMIT);
    const bundle = validateImageBundle(JSON.parse(raw.toString('utf8')));
    await mkdir(destination, { mode: 0o700 });
    await mkdir(path.join(destination, 'images'), { mode: 0o700 });
    for (const [name, entry] of Object.entries(bundleEntries(bundle))) {
        const handle = await open(path.join(destination, entry.file), 'wx', 0o600);
        const full = createHash('sha256');
        try {
            for (let offset = 0, index = 0; offset < entry.size; offset += EXTERNAL_CHUNK_BYTES, index++) {
                const chunk = await store.get(objectKey(backupId, name, index), Math.min(EXTERNAL_CHUNK_BYTES, entry.size - offset));
                if (chunk.length !== Math.min(EXTERNAL_CHUNK_BYTES, entry.size - offset)) {
                    throw new Error('Внешний блок tar ' + name + ' усечён');
                }
                full.update(chunk);
                await handle.write(chunk, 0, chunk.length, offset);
            }
            if (full.digest('hex') !== entry.sha256) {
                throw new Error('SHA256 скачанного tar ' + name + ' не совпадает с описью');
            }
        } finally {
            await handle.close();
        }
    }
    await writeFile(path.join(destination, 'image-bundle.json'), raw, { flag: 'wx', mode: 0o600, flush: true });
    const reread = await readImageBundle(destination);
    if (reread.bundleId !== bundle.bundleId) throw new Error('Опись изменилась после записи');
    return {
        ok: true,
        backupId,
        destination,
        manifestSha256: digest(raw),
        images: Object.keys(bundleEntries(bundle)).length,
    };
}

async function main() {
    process.umask(0o077);
    const args = process.argv.slice(2);
    const mode = args.shift();
    const values = {};
    const options = {
        '--manifest': 'manifest',
        '--source': 'source',
        '--destination': 'destination',
        '--backup-id': 'backupId',
    };
    for (let i = 0; i < args.length; i++) {
        const key = options[args[i]];
        if (!key || !args[i + 1] || args[i + 1].startsWith('--')) {
            throw new Error('Неизвестный или незаполненный параметр ' + args[i]);
        }
        values[key] = args[++i];
    }
    let result;
    if (mode === 'bundle') {
        if (!values.manifest || !values.destination) throw new Error('Нужны --manifest и --destination');
        result = await bundleImages(
            JSON.parse(await readFile(path.resolve(values.manifest), 'utf8')),
            path.resolve(values.destination),
        );
    } else if (mode === 'verify') {
        if (!values.source || !values.manifest) throw new Error('Нужны --source и --manifest');
        result = await verifyImageBundle(
            path.resolve(values.source),
            JSON.parse(await readFile(path.resolve(values.manifest), 'utf8')),
        );
    } else if (mode === 'load') {
        if (!values.source) throw new Error('Нужен --source');
        result = await loadImageBundle(path.resolve(values.source));
    } else if (mode === 'upload') {
        if (!values.source || !values.backupId) throw new Error('Нужны --source и --backup-id');
        const config = externalBackupConfiguration();
        result = await uploadImageBundle({
            source: path.resolve(values.source),
            backupId: values.backupId,
            store: createExternalS3Store(config),
        });
    } else if (mode === 'download') {
        if (!values.destination || !values.backupId) throw new Error('Нужны --destination и --backup-id');
        const config = externalBackupConfiguration();
        result = await downloadImageBundle({
            destination: path.resolve(values.destination),
            backupId: values.backupId,
            store: createExternalS3Store(config),
        });
    } else {
        throw new Error(
            'Команды: bundle --manifest <release-manifest.json> --destination <новый каталог> | verify --source <бандл> --manifest <release-manifest.json> | load --source <бандл> | upload --source <бандл> --backup-id <id> | download --destination <новый каталог> --backup-id <id>',
        );
    }
    console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    void main().catch((error) => {
        console.error('Image-bundle не подтверждён: ' + error.message);
        process.exitCode = 1;
    });
}
