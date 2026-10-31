import { BadRequestException } from '@nestjs/common';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import {
    ArchiveStager,
    SOURCE_ARCHIVE_LIMITS,
    archiveFailure,
    archiveFileStream,
    type SourceArchiveResult,
} from './source-archive-reader-files';
import { readZipArchive } from './source-archive-reader-zip';
import { readTarArchive } from './source-archive-reader-tar';
export { SOURCE_ARCHIVE_LIMITS };
export type { SourceArchiveResult, SourceArchiveFile } from './source-archive-reader-files';

/** Only fully checked archives expose staged regular files; failure removes this invocation's private child. */
export async function readSourceArchive(
    filename: string,
    directory: string,
    signal: AbortSignal,
): Promise<SourceArchiveResult> {
    signal.throwIfAborted();
    filename = path.resolve(filename);
    directory = path.resolve(directory);
    const named = await fs.lstat(filename);
    if (
        !named.isFile() ||
        named.isSymbolicLink() ||
        named.nlink !== 1 ||
        named.size < 22 ||
        named.size > SOURCE_ARCHIVE_LIMITS.archiveBytes
    )
        archiveFailure('Нужен обычный ZIP, TAR или TAR.GZ размером до 8 ГиБ.');
    const destination = await fs.lstat(directory);
    if (
        !destination.isDirectory() ||
        destination.isSymbolicLink() ||
        (await fs.realpath(directory)) !== path.resolve(directory)
    )
        archiveFailure('Архиву нужен отдельный безопасный временный каталог.');
    const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let stage: string | undefined;
    try {
        const before = await file.stat();
        if (
            !before.isFile() ||
            before.nlink !== 1 ||
            before.ino !== named.ino ||
            before.dev !== named.dev ||
            before.size !== named.size
        )
            archiveFailure();
        stage = await fs.mkdtemp(path.join(directory, 'source-'));
        const stager = new ArchiveStager(stage, signal),
            magic = Buffer.alloc(4);
        await file.read(magic, 0, 4, 0);
        if (magic.readUInt32LE(0) === 0x04034b50 || magic.readUInt32LE(0) === 0x06054b50)
            await readZipArchive(file, before.size, stager);
        else {
            const input = archiveFileStream(file, 0, before.size);
            if (magic[0] === 0x1f && magic[1] === 0x8b) {
                const decoded = createGunzip({ chunkSize: 64 * 1024 }),
                    pumping = pipeline(input, decoded, { signal });
                pumping.catch(() => undefined);
                try {
                    await readTarArchive(decoded, stager);
                    await pumping;
                    if (decoded.bytesWritten !== before.size) archiveFailure('После gzip найдены посторонние байты.');
                } finally {
                    input.destroy();
                    decoded.destroy();
                    await pumping.catch(() => undefined);
                }
            } else await readTarArchive(input, stager);
        }
        signal.throwIfAborted();
        const after = await file.stat(),
            current = await fs.lstat(filename),
            parent = await fs.lstat(directory);
        if (
            before.ino !== after.ino ||
            before.dev !== after.dev ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            after.nlink !== 1 ||
            !current.isFile() ||
            current.isSymbolicLink() ||
            current.ino !== before.ino ||
            current.dev !== before.dev ||
            parent.ino !== destination.ino ||
            parent.dev !== destination.dev ||
            parent.isSymbolicLink()
        )
            archiveFailure('Архив или временный каталог изменился во время чтения.');
        return stager.result();
    } catch (error) {
        if (stage) await fs.rm(stage, { recursive: true, force: true });
        signal.throwIfAborted();
        if (
            error instanceof BadRequestException ||
            String((error as NodeJS.ErrnoException).code).startsWith('CAPACITY_')
        )
            throw error;
        throw new BadRequestException('Архив поставки повреждён или имеет неподдерживаемый формат.', { cause: error });
    } finally {
        await file.close();
    }
}
