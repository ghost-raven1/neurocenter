'use strict';
const { createHash } = require('node:crypto');
const { mkdir, open, chmod } = require('node:fs/promises');
const { createGunzip } = require('node:zlib');
const path = require('node:path');
const { portablePath } = require('./portable-path.cjs');
const ordinal = (a, b) => (a === b ? 0 : a < b ? -1 : 1);
function text(buffer) {
    const end = buffer.indexOf(0);
    const bytes = end < 0 ? buffer : buffer.subarray(0, end);
    const value = bytes.toString('utf8');
    if (!Buffer.from(value).equals(bytes)) throw new Error('Путь архива должен быть UTF-8.');
    if (end >= 0 && buffer.subarray(end).some((byte) => byte !== 0)) throw new Error('Неоднозначное поле архива.');
    return value;
}
function octal(buffer) {
    const value = buffer.toString('ascii').replace(/\0.*$/, '').trim();
    if (!/^[0-7]+$/.test(value)) throw new Error('Неподдерживаемое число в TAR.');
    const result = parseInt(value, 8);
    if (!Number.isSafeInteger(result)) throw new Error('Слишком большое число в TAR.');
    return result;
}
/** Лимиты — обязательный параметр: источник лимитов отделён от парсера (чистая функция). */
function assertLimits(limits) {
    if (
        !limits ||
        typeof limits !== 'object' ||
        !Number.isSafeInteger(limits.unpackedBytes) ||
        limits.unpackedBytes <= 0 ||
        !Number.isSafeInteger(limits.filesCount) ||
        limits.filesCount <= 0
    )
        throw new Error('Лимиты распаковки — обязательный параметр: limits.unpackedBytes и limits.filesCount.');
}
/**
 * Разбирает только обычный USTAR: никаких ссылок, PAX, устройств или исполнения кода.
 * Descriptor обязан быть уже нормализованным (normalizeRuntimeArtifacts); источник лимитов — параметр.
 */
async function inspectRuntimeArchive(filename, descriptor, { destination, signal, limits } = {}) {
    signal?.throwIfAborted();
    assertLimits(limits);
    const archive = await open(
        filename,
        require('node:fs').constants.O_RDONLY |
            require('node:fs').constants.O_NOFOLLOW |
            require('node:fs').constants.O_NONBLOCK,
    );
    try {
        const before = await archive.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size !== descriptor.compressedBytes)
            throw new Error('Размер архива не совпадает с одобренным.');
        const compressed = createHash('sha256');
        let compressedRead = 0;
        for await (const chunk of archive.createReadStream({ autoClose: false, signal })) {
            signal?.throwIfAborted();
            compressedRead += chunk.length;
            if (compressedRead > descriptor.compressedBytes) throw new Error('Архив изменился во время проверки.');
            compressed.update(chunk);
        }
        signal?.throwIfAborted();
        if (compressed.digest('hex') !== descriptor.sha256)
            throw new Error('SHA-256 архива не совпадает с одобренным.');
        const input = archive.createReadStream({ autoClose: false, start: 0, signal });
        const unzip = createGunzip();
        input.on('error', (error) => unzip.destroy(error));
        input.pipe(unzip);
        const iterator = unzip[Symbol.asyncIterator]();
        let pending = Buffer.alloc(0),
            done = false,
            expanded = 0;
        const read = async (size, allowEnd = false) => {
            signal?.throwIfAborted();
            while (pending.length < size && !done) {
                const next = await iterator.next();
                signal?.throwIfAborted();
                done = !!next.done;
                if (!done) {
                    expanded += next.value.length;
                    if (expanded > limits.unpackedBytes + limits.filesCount * 1536 + 1024 * 1024)
                        throw new Error('Распакованный архив превышает предел.');
                    pending = Buffer.concat([pending, next.value]);
                }
            }
            if (pending.length < size) {
                if (allowEnd && pending.length === 0) return null;
                throw new Error('Архив оборван.');
            }
            const result = pending.subarray(0, size);
            pending = pending.subarray(size);
            return result;
        };
        const entries = [],
            names = new Map(),
            ancestors = new Set();
        let total = 0,
            zeroes = 0,
            headers = 0;
        try {
            while (true) {
                const header = await read(512, true);
                if (!header) break;
                if (header.every((byte) => byte === 0)) {
                    zeroes++;
                    if (zeroes > 2048) throw new Error('Слишком длинное окончание TAR.');
                    continue;
                }
                if (zeroes) throw new Error('Данные после окончания TAR.');
                if (++headers > limits.filesCount * 2) throw new Error('Слишком много записей TAR.');
                const checksum = octal(header.subarray(148, 156));
                let sum = 0;
                for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 32 : header[index];
                if (sum !== checksum) throw new Error('Повреждён заголовок TAR.');
                const magic = header.subarray(257, 263).toString('ascii');
                if (magic !== 'ustar\0' && magic !== 'ustar ') throw new Error('Требуется обычный архив USTAR.');
                const type = header[156];
                if (![0, 48, 53].includes(type) || header.subarray(157, 257).some((byte) => byte !== 0))
                    throw new Error('Ссылки и специальные записи TAR запрещены.');
                const prefix = text(header.subarray(345, 500));
                const name = text(header.subarray(0, 100));
                const relative = (prefix ? prefix + '/' : '') + name;
                const normalized = type === 53 ? relative.replace(/\/$/, '') : relative;
                if (!portablePath(normalized)) throw new Error('Недопустимый путь в архиве.');
                const key = normalized.normalize('NFC').toLowerCase();
                const parents = key
                    .split('/')
                    .slice(0, -1)
                    .map((_part, index, parts) => parts.slice(0, index + 1).join('/'));
                if (
                    names.has(key) ||
                    (type !== 53 && ancestors.has(key)) ||
                    parents.some((parent) => names.has(parent) && names.get(parent) !== 'directory')
                )
                    throw new Error('Повтор или конфликт путей в архиве.');
                names.set(key, type === 53 ? 'directory' : 'file');
                for (const parent of parents) ancestors.add(parent);
                const size = octal(header.subarray(124, 136));
                const mode = octal(header.subarray(100, 108));
                if (mode & 0o7000 || (type === 53 && size !== 0)) throw new Error('Недопустимые права или размер TAR.');
                if (type === 53) {
                    if (destination) await mkdir(path.join(destination, normalized), { recursive: true, mode: 0o700 });
                    continue;
                }
                total += size;
                if (total > descriptor.unpackedBytes || entries.length >= descriptor.filesCount)
                    throw new Error('Архив превышает одобренный размер или число файлов.');
                const digest = createHash('sha256');
                let handle;
                if (destination) {
                    const target = path.join(destination, normalized);
                    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
                    handle = await open(target, 'wx', 0o600);
                }
                try {
                    let remaining = size;
                    while (remaining) {
                        const chunk = await read(Math.min(remaining, 64 * 1024));
                        digest.update(chunk);
                        if (handle) await handle.writeFile(chunk);
                        remaining -= chunk.length;
                    }
                    if (handle) await handle.sync();
                } finally {
                    await handle?.close();
                }
                const padding = (512 - (size % 512)) % 512;
                if (padding && (await read(padding)).some((byte) => byte !== 0))
                    throw new Error('Некорректное выравнивание TAR.');
                const executable = !!(mode & 0o111);
                if (destination) await chmod(path.join(destination, normalized), executable ? 0o500 : 0o400);
                entries.push({ path: normalized, size, sha256: digest.digest('hex'), executable });
            }
            if (zeroes < 2 || total !== descriptor.unpackedBytes || entries.length !== descriptor.filesCount)
                throw new Error('Опись архива не совпадает с одобренной.');
            const entry = entries.find((item) => item.path === descriptor.entrypoint);
            if (!entry || (descriptor.executable && !entry.executable))
                throw new Error('Точка входа отсутствует или не исполняемая.');
            const after = await archive.stat();
            signal?.throwIfAborted();
            if (
                before.ino !== after.ino ||
                before.size !== after.size ||
                before.mtimeMs !== after.mtimeMs ||
                after.nlink !== 1
            )
                throw new Error('Архив изменился во время проверки.');
            return entries.sort((a, b) => ordinal(a.path, b.path));
        } finally {
            input.destroy();
            unzip.destroy();
        }
    } finally {
        await archive.close();
    }
}
module.exports = { inspectRuntimeArchive };
