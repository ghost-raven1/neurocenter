import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import runtime from '../../services/shared/runtime-artifacts.cjs';

/** В архив попадают только переносимые обычные файлы; метаданные TAR воспроизводимы. */
async function inventory(directory, prefix = '') {
    const files = [];
    for (const name of (await fs.readdir(path.join(directory, prefix))).sort()) {
        const relative = prefix ? `${prefix}/${name}` : name;
        if (!runtime.portablePath(relative)) throw new Error(`Непереносимый путь: ${relative}`);
        const info = await fs.lstat(path.join(directory, relative));
        if (info.isDirectory()) files.push(...await inventory(directory, relative));
        else if (info.isFile() && info.nlink === 1) files.push({ path: relative, size: info.size });
        else throw new Error(`Ссылки и специальные файлы запрещены: ${relative}`);
    }
    return files;
}

function header(file, executable) {
    const bytes = Buffer.alloc(512);
    let name = file.path, prefix = '';
    if (Buffer.byteLength(name) > 100) {
        const parts = name.split('/');
        for (let index = 1; index < parts.length; index++) {
            const candidate = parts.slice(index).join('/');
            const parent = parts.slice(0, index).join('/');
            if (Buffer.byteLength(candidate) <= 100 && Buffer.byteLength(parent) <= 155) { name = candidate; prefix = parent; break; }
        }
    }
    if (Buffer.byteLength(name) > 100) throw new Error(`Путь не помещается в USTAR: ${file.path}`);
    bytes.write(name, 0, 100); bytes.write(prefix, 345, 155);
    bytes.write((executable ? '0000755' : '0000644') + '\0', 100, 'ascii');
    bytes.write('0000000\0', 108, 'ascii'); bytes.write('0000000\0', 116, 'ascii');
    bytes.write(file.size.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
    bytes.write('00000000000\0', 136, 'ascii'); bytes.fill(32, 148, 156);
    bytes[156] = 48; bytes.write('ustar\0', 257, 'ascii'); bytes.write('00', 263, 'ascii');
    const checksum = bytes.reduce((sum, byte) => sum + byte, 0);
    bytes.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
    return bytes;
}

/** Проверяет готовый архив тем же валидатором, который использует мост и сервер. */
export async function packRuntime({ directory, archivePath, target, entrypoint, executables = [] }) {
    const files = await inventory(directory);
    const unpackedBytes = files.reduce((total, file) => total + file.size, 0);
    if (!files.length || files.length > runtime.LIMITS.filesCount || unpackedBytes > runtime.LIMITS.unpackedBytes) throw new Error('Комплект превышает лимиты поставки.');
    const executable = new Set(executables);
    if ([entrypoint, ...executable].some(name => !files.some(file => file.path === name))) throw new Error('Точка входа или исполняемый файл отсутствует.');
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    async function* tar() {
        for (const file of files) {
            yield header(file, executable.has(file.path));
            yield* createReadStream(path.join(directory, file.path));
            yield Buffer.alloc((512 - file.size % 512) % 512);
        }
        yield Buffer.alloc(1024);
    }
    await pipeline(Readable.from(tar()), createGzip({ level: 6 }), createWriteStream(archivePath, { flags: 'wx', mode: 0o600 }));
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(archivePath)) hash.update(chunk);
    const descriptor = { target, sha256: hash.digest('hex'), compressedBytes: (await fs.stat(archivePath)).size,
        unpackedBytes, filesCount: files.length, entrypoint, ...(executable.has(entrypoint) ? { executable: true } : {}) };
    await runtime.inspectRuntimeArchive(archivePath, descriptor);
    return descriptor;
}
