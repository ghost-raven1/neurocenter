import { BadRequestException, ConflictException, HttpException, PayloadTooLargeException } from '@nestjs/common';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { Pool } from 'pg';
import { ASSET_SOURCE_ARCHIVE_MAX_BYTES } from '../../../shared/asset-source-archive-route.cjs';
import { CapacityError, reserveCapacity } from '../../../shared/capacity.cjs';
import { authorizeImportActor } from './import-worker';
import { AssetSourceSnapshots } from './source-snapshots';
import { readSourceArchive } from './source-archive-reader';
import { validateSourceArchive } from './source-archive-validation';
import { publishSourceArchive } from './source-archive-cache';

/** Stream an archive into a private own directory; only validated pinned files can reach the SHA cache. */
export class AssetSourceArchiveUploads {
    private active = 0;
    constructor(
        private readonly pool: Pool,
        private readonly snapshots: AssetSourceSnapshots,
        private readonly root: string,
        private readonly maximum = ASSET_SOURCE_ARCHIVE_MAX_BYTES,
        private readonly parse = readSourceArchive,
    ) {}
    async receive(actor: string, input: Readable, declared: unknown, external: AbortSignal): Promise<void> {
        if (this.active >= 2)
            throw new ConflictException('Уже загружаются два архива источника. Дождитесь завершения.');
        let expected: number | undefined;
        if (declared !== undefined) {
            if (
                typeof declared !== 'string' ||
                !/^\d+$/.test(declared) ||
                !Number.isSafeInteger(Number(declared)) ||
                Number(declared) < 1
            )
                throw new BadRequestException('Некорректный размер архива источника.');
            expected = Number(declared);
            if (expected > this.maximum) throw new PayloadTooLargeException('Архив источника превышает 8 ГиБ.');
        }
        this.active++;
        const controller = new AbortController(),
            abort = () => controller.abort(),
            signal = controller.signal;
        external.addEventListener('abort', abort, { once: true });
        if (external.aborted) abort();
        const timeout = setTimeout(abort, 30 * 60 * 1000);
        timeout.unref();
        const cancel = () => {
            if (!input.destroyed) input.destroy();
        };
        signal.addEventListener('abort', cancel, { once: true });
        let directory: string | undefined,
            release = () => {};
        try {
            signal.throwIfAborted();
            await authorizeImportActor(this.pool, actor);
            await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
            const info = await fs.lstat(this.root);
            if (!info.isDirectory() || info.isSymbolicLink())
                throw new ConflictException('Хранилище архивов заменено посторонним путём.');
            directory = await fs.mkdtemp(path.join(await fs.realpath(this.root), '.asset-source-upload-'));
            if (expected !== undefined)
                release = await reserveCapacity({ resource: 'runtime-artifacts', bytes: expected, path: this.root });
            const filename = path.join(directory, 'archive.bin'),
                output = await fs.open(filename, 'wx', 0o600),
                hash = createHash('sha256');
            let count = 0;
            try {
                for await (const value of input) {
                    signal.throwIfAborted();
                    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
                    count += chunk.length;
                    if (count > this.maximum || (expected !== undefined && count > expected))
                        throw new PayloadTooLargeException('Поток архива превышает допустимый или заявленный размер.');
                    const next =
                        expected === undefined
                            ? await reserveCapacity({
                                  resource: 'runtime-artifacts',
                                  bytes: chunk.length,
                                  path: this.root,
                              })
                            : () => {};
                    try {
                        hash.update(chunk);
                        await output.writeFile(chunk);
                    } finally {
                        next();
                    }
                }
                signal.throwIfAborted();
                if (!count || (expected !== undefined && count !== expected))
                    throw new BadRequestException('Архив передан не полностью. Повторите загрузку.');
                await output.sync();
                await output.chmod(0o400);
            } finally {
                await output.close();
            }
            release();
            release = () => {};
            const digest = hash.digest('hex'),
                parsed = await this.parse(filename, directory, signal);
            const archive = await validateSourceArchive(parsed.files, await this.snapshots.trustedPins(), signal);
            await this.snapshots.acceptArchive(archive.pin, archive.index, archive.records, digest, async (client) => {
                signal.throwIfAborted();
                await authorizeImportActor(client, actor);
                await publishSourceArchive(this.root, archive, signal);
                signal.throwIfAborted();
                await authorizeImportActor(client, actor, true);
            });
        } catch (error) {
            if (error instanceof CapacityError) throw new HttpException(error.message, error.statusCode);
            if (error instanceof HttpException) throw error;
            throw new BadRequestException(
                signal.aborted
                    ? 'Загрузка архива отменена. Можно повторить загрузку.'
                    : 'Не удалось проверить архив источника. Нужен исправный ZIP, TAR или TAR.GZ с закреплённой описью.',
            );
        } finally {
            clearTimeout(timeout);
            signal.removeEventListener('abort', cancel);
            external.removeEventListener('abort', abort);
            try {
                if (directory) await fs.rm(directory, { recursive: true, force: true });
            } finally {
                release();
                this.active--;
            }
        }
    }
}
