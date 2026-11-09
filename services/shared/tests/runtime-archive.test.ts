import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';

const require = createRequire(import.meta.url);
const { inspectRuntimeArchive } = require('../runtime/archive.cjs') as typeof import('../runtime/archive.cjs');

interface ITestFile {
    path: string;
    content: string | Buffer;
    mode?: number;
}

/** Настоящий USTAR (header 512 + выравнивание + хвост 1024 нулей), gzip. */
function buildArchive(files: ITestFile[]): { archive: Buffer; totalBytes: number } {
    const blocks: Buffer[] = [];
    let totalBytes = 0;
    for (const file of files) {
        const bytes = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
        totalBytes += bytes.length;
        const mode = file.mode ?? 0o644;
        const header = Buffer.alloc(512);
        header.write(file.path, 0, 100, 'utf8');
        header.write(mode.toString(8).padStart(7, '0') + '\0', 100, 'ascii');
        header.write('0000000\0', 108, 'ascii');
        header.write('0000000\0', 116, 'ascii');
        header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124, 'ascii');
        header.write('00000000000\0', 136, 'ascii');
        header.fill(32, 148, 156);
        header[156] = 48;
        header.write('ustar\0', 257, 'ascii');
        header.write('00', 263, 'ascii');
        let sum = 0;
        for (const byte of header) sum += byte;
        header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'ascii');
        blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
    }
    blocks.push(Buffer.alloc(1024));
    return { archive: gzipSync(Buffer.concat(blocks)), totalBytes };
}

function descriptorFor(archive: Buffer, totalBytes: number, files: number, overrides: Record<string, unknown> = {}) {
    return {
        target: 'linux-x64-glibc',
        sha256: createHash('sha256').update(archive).digest('hex'),
        compressedBytes: archive.length,
        unpackedBytes: totalBytes,
        filesCount: files,
        entrypoint: 'runtime/server.mjs',
        ...overrides,
    };
}

async function withTempDir<T>(work: (directory: string) => Promise<T>): Promise<T> {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'nc-runtime-archive-'));
    try {
        return await work(directory);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

test('Round-trip: entries с размерами, SHA-256 и исполняемостью, сортировка по пути', async () => {
    await withTempDir(async (root) => {
        const files: ITestFile[] = [
            { path: 'runtime/server.mjs', content: 'export default {};', mode: 0o755 },
            { path: 'runtime/notes.txt', content: 'release notes' },
        ];
        const { archive, totalBytes } = buildArchive(files);
        const filename = path.join(root, 'artifact.tgz');
        await writeFile(filename, archive);
        const entries = await inspectRuntimeArchive(
            filename,
            descriptorFor(archive, totalBytes, 2, { executable: true }),
            {
                limits: { unpackedBytes: 1024 * 1024, filesCount: 10 },
            },
        );
        assert.deepEqual(
            entries.map((entry) => entry.path),
            ['runtime/notes.txt', 'runtime/server.mjs'],
        );
        assert.deepEqual(entries[0], {
            path: 'runtime/notes.txt',
            size: 13,
            sha256: createHash('sha256').update('release notes').digest('hex'),
            executable: false,
        });
        assert.deepEqual(entries[1], {
            path: 'runtime/server.mjs',
            size: 18,
            sha256: createHash('sha256').update('export default {};').digest('hex'),
            executable: true,
        });
    });
});

test('destination: экстракция с правами 0o400 / 0o500 и точным содержимым', async () => {
    await withTempDir(async (root) => {
        const files: ITestFile[] = [
            { path: 'runtime/server.mjs', content: 'export default {};', mode: 0o755 },
            { path: 'runtime/notes.txt', content: 'release notes' },
        ];
        const { archive, totalBytes } = buildArchive(files);
        const filename = path.join(root, 'artifact.tgz');
        await writeFile(filename, archive);
        const destination = path.join(root, 'out');
        await inspectRuntimeArchive(filename, descriptorFor(archive, totalBytes, 2), {
            destination,
            limits: { unpackedBytes: 1024 * 1024, filesCount: 10 },
        });
        const executable = await stat(path.join(destination, 'runtime/server.mjs'));
        const plain = await stat(path.join(destination, 'runtime/notes.txt'));
        assert.equal(executable.mode & 0o777, 0o500);
        assert.equal(plain.mode & 0o777, 0o400);
        assert.equal(await readFile(path.join(destination, 'runtime/server.mjs'), 'utf8'), 'export default {};');
        assert.equal(await readFile(path.join(destination, 'runtime/notes.txt'), 'utf8'), 'release notes');
    });
});

test('limits — обязательный параметр: без него и с невалидными значениями честный отказ', async () => {
    await withTempDir(async (root) => {
        const files: ITestFile[] = [{ path: 'runtime/server.mjs', content: 'export default {};', mode: 0o755 }];
        const { archive, totalBytes } = buildArchive(files);
        const filename = path.join(root, 'artifact.tgz');
        await writeFile(filename, archive);
        const descriptor = descriptorFor(archive, totalBytes, 1);
        const message = /Лимиты распаковки — обязательный параметр/;
        await assert.rejects(inspectRuntimeArchive(filename, descriptor, {}), message);
        await assert.rejects(inspectRuntimeArchive(filename, descriptor, { limits: undefined }), message);
        for (const limits of [
            { unpackedBytes: 0, filesCount: 10 },
            { unpackedBytes: 10, filesCount: 0 },
            { unpackedBytes: 1.5, filesCount: 10 },
            { filesCount: 10 },
        ]) {
            await assert.rejects(inspectRuntimeArchive(filename, descriptor, { limits }), message);
        }
    });
});

test('Бомба: раздувание выше limits.unpackedBytes отклоняется на потоке', async () => {
    await withTempDir(async (root) => {
        const files: ITestFile[] = [{ path: 'runtime/big.bin', content: Buffer.alloc(2 * 1024 * 1024), mode: 0o644 }];
        const { archive, totalBytes } = buildArchive(files);
        const filename = path.join(root, 'artifact.tgz');
        await writeFile(filename, archive);
        await assert.rejects(
            inspectRuntimeArchive(filename, descriptorFor(archive, totalBytes, 1), {
                limits: { unpackedBytes: 1024, filesCount: 1 },
            }),
            /превышает предел/,
        );
    });
});

test('Потолок заголовков: больше limits.filesCount * 2 записей TAR отклоняется', async () => {
    await withTempDir(async (root) => {
        const files: ITestFile[] = [
            { path: 'runtime/a.txt', content: '1' },
            { path: 'runtime/b.txt', content: '2' },
            { path: 'runtime/c.txt', content: '3' },
        ];
        const { archive, totalBytes } = buildArchive(files);
        const filename = path.join(root, 'artifact.tgz');
        await writeFile(filename, archive);
        await assert.rejects(
            inspectRuntimeArchive(filename, descriptorFor(archive, totalBytes, 3), {
                limits: { unpackedBytes: 1024 * 1024, filesCount: 1 },
            }),
            /Слишком много записей TAR/,
        );
    });
});

test('Опись не совпадает: descriptor.unpackedBytes завышен', async () => {
    await withTempDir(async (root) => {
        const files: ITestFile[] = [
            { path: 'runtime/server.mjs', content: 'export default {};', mode: 0o755 },
            { path: 'runtime/notes.txt', content: 'release notes' },
        ];
        const { archive, totalBytes } = buildArchive(files);
        const filename = path.join(root, 'artifact.tgz');
        await writeFile(filename, archive);
        await assert.rejects(
            inspectRuntimeArchive(filename, descriptorFor(archive, totalBytes, 2, { unpackedBytes: totalBytes + 1 }), {
                limits: { unpackedBytes: 1024 * 1024, filesCount: 10 },
            }),
            /Опись архива не совпадает/,
        );
    });
});

test('Архив шире одобренного: два файла при descriptor.filesCount = 1', async () => {
    await withTempDir(async (root) => {
        const files: ITestFile[] = [
            { path: 'runtime/server.mjs', content: 'export default {};', mode: 0o755 },
            { path: 'runtime/notes.txt', content: 'release notes' },
        ];
        const { archive, totalBytes } = buildArchive(files);
        const filename = path.join(root, 'artifact.tgz');
        await writeFile(filename, archive);
        await assert.rejects(
            inspectRuntimeArchive(filename, descriptorFor(archive, totalBytes, 2, { filesCount: 1 }), {
                limits: { unpackedBytes: 1024 * 1024, filesCount: 10 },
            }),
            /Архив превышает одобренный размер или число файлов/,
        );
    });
});
