import { ConflictException } from '@nestjs/common';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { reserveCapacity } from '../../../shared/capacity.cjs';
import type { IArchiveFile, IValidatedSourceArchive } from './source-archive-validation';

/** Public SHA cache files are immutable; a different existing file is never overwritten. */
async function verified(filename: string, file: IArchiveFile, signal: AbortSignal): Promise<boolean> {
    let handle: fs.FileHandle;
    try {
        handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
        throw error;
    }
    try {
        const before = await handle.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size !== file.bytes)
            throw new ConflictException('Сохранённый SHA-кэш источника повреждён.');
        const hash = createHash('sha256');
        let count = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
            signal.throwIfAborted();
            count += chunk.length;
            if (count > file.bytes) throw new ConflictException('Сохранённый SHA-кэш изменился.');
            hash.update(chunk);
        }
        const after = await handle.stat(),
            named = await fs.lstat(filename);
        if (
            count !== file.bytes ||
            hash.digest('hex') !== file.sha256 ||
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs ||
            named.dev !== before.dev ||
            named.ino !== before.ino ||
            named.isSymbolicLink()
        )
            throw new ConflictException('Сохранённый SHA-кэш источника повреждён.');
        return true;
    } finally {
        await handle.close();
    }
}

/** Called after all metadata/history validation, before snapshot acceptance; no native card or DB blob row. */
export async function publishSourceArchive(
    root: string,
    archive: IValidatedSourceArchive,
    signal: AbortSignal,
): Promise<void> {
    const rootInfo = await fs.lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink())
        throw new ConflictException('Хранилище источника заменено посторонним путём.');
    const entries = [...archive.metadata.values()]
        .map((file) => ({ file, directory: '.asset-source-metadata', extension: '.json' }))
        .concat(
            [...archive.blobs.values()].map((file) => ({ file, directory: '.asset-source-blobs', extension: '.blob' })),
        );
    for (const name of ['.asset-source-metadata', '.asset-source-blobs']) {
        const directory = path.join(root, name);
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const info = await fs.lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink())
            throw new ConflictException('Хранилище источника заменено посторонним путём.');
    }
    for (const { file, directory, extension } of entries) {
        signal.throwIfAborted();
        const folder = path.join(root, directory),
            filename = path.join(folder, file.sha256 + extension);
        if (await verified(filename, file, signal)) continue;
        const release = await reserveCapacity({ resource: 'runtime-artifacts', bytes: file.bytes, path: root }),
            temporary = path.join(folder, '.archive-' + randomUUID());
        let input: fs.FileHandle | undefined, output: fs.FileHandle | undefined;
        try {
            input = await fs.open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            const before = await input.stat();
            if (!before.isFile() || before.nlink !== 1 || before.size !== file.bytes)
                throw new ConflictException('Файл архива изменился до публикации.');
            output = await fs.open(temporary, 'wx', 0o600);
            const hash = createHash('sha256');
            let count = 0;
            for await (const chunk of input.createReadStream({ autoClose: false })) {
                signal.throwIfAborted();
                count += chunk.length;
                if (count > file.bytes) throw new ConflictException('Файл архива вырос.');
                hash.update(chunk);
                await output.writeFile(chunk);
            }
            const after = await input.stat();
            if (
                count !== file.bytes ||
                hash.digest('hex') !== file.sha256 ||
                before.dev !== after.dev ||
                before.ino !== after.ino ||
                before.size !== after.size ||
                before.mtimeMs !== after.mtimeMs
            )
                throw new ConflictException('SHA файла архива изменился.');
            await output.chmod(0o400);
            await output.sync();
            await output.close();
            output = undefined;
            try {
                await fs.link(temporary, filename);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            }
            await fs.unlink(temporary);
            if (!(await verified(filename, file, signal)))
                throw new ConflictException('Не удалось сохранить SHA-файл.');
            if (process.platform !== 'win32') {
                const handle = await fs.open(folder, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
                try {
                    await handle.sync();
                } finally {
                    await handle.close();
                }
            }
        } finally {
            try {
                await Promise.all([input?.close(), output?.close()]);
                await fs.rm(temporary, { force: true });
            } finally {
                release();
            }
        }
    }
}
