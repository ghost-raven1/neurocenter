import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';
import { reserveCapacity } from '../../../shared/capacity.cjs';

export const SOURCE_ARCHIVE_LIMITS = Object.freeze({
    entries: 10000,
    expandedBytes: 8 * 1024 ** 3,
    archiveBytes: 8 * 1024 ** 3,
    pathBytes: 1024,
    pathDepth: 64,
    pathIdentityBytes: 16 * 1024 ** 2,
    extensionBytes: 64 * 1024,
});
export interface SourceArchiveFile {
    path: string;
    bytes: number;
    sha256: string;
}
export interface SourceArchiveResult {
    rootName?: string;
    files: Map<string, SourceArchiveFile>;
}
export function archiveFailure(message = 'Архив поставки повреждён или имеет неподдерживаемый формат.'): never {
    throw new BadRequestException(message);
}
export const crc32 = (zlib as typeof zlib & { crc32: (bytes: Buffer, previous?: number) => number }).crc32;
const mac = (name: string) =>
    name.split('/').some((part) => ['__macosx', '.ds_store'].includes(part.toLowerCase()) || part.startsWith('._'));

/** Destroying a borrowed range stream never closes the archive's independently owned file handle. */
export function archiveFileStream(file: FileHandle, start: number, end: number): Readable {
    return Readable.from(
        (async function* () {
            let position = start;
            while (position < end) {
                const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, end - position)),
                    next = await file.read(chunk, 0, chunk.length, position);
                if (!next.bytesRead) return;
                position += next.bytesRead;
                yield chunk.subarray(0, next.bytesRead);
            }
        })(),
    );
}

/** Archive names are identities only: no destination path is ever derived from an uploaded name. */
export function archivePath(raw: string, directory = false): string {
    if (raw.startsWith('/')) archiveFailure('В архиве найден абсолютный путь.');
    if (directory && /^(?:\.\/)*\.?$/.test(raw) && raw) return '';
    const clean = raw.replace(/^(?:\.\/)+/, ''),
        name = directory ? clean.replace(/\/$/, '') : clean;
    const checked = mac(name) ? name.replace(/(^|\/)\._\.$/, '$1._root') : name;
    if (
        !checked ||
        Buffer.byteLength(checked) > SOURCE_ARCHIVE_LIMITS.pathBytes ||
        checked.startsWith('/') ||
        /[\\<>:"|?*\x00-\x1f\x7f]/.test(checked) ||
        checked.split('/').length > SOURCE_ARCHIVE_LIMITS.pathDepth ||
        checked
            .split('/')
            .some(
                (part) =>
                    !part ||
                    part === '.' ||
                    part === '..' ||
                    Buffer.byteLength(part) > 255 ||
                    /[. ]$/.test(part) ||
                    /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part),
            )
    )
        archiveFailure('В архиве найден небезопасный или слишком глубокий путь.');
    return name;
}

/** Bounds, portable aliases and file/parent collisions include skipped macOS entries. */
export class ArchiveStager {
    private readonly names = new Map<string, boolean>();
    private readonly parents = new Set<string>();
    private readonly spellings = new Map<string, string>();
    readonly files = new Map<string, SourceArchiveFile>();
    entries = 0;
    expandedBytes = 0;
    private identityBytes = 0;
    constructor(
        readonly directory: string,
        readonly signal: AbortSignal,
    ) {}
    reserve(bytes: number): void {
        this.signal.throwIfAborted();
        if (
            ++this.entries > SOURCE_ARCHIVE_LIMITS.entries ||
            !Number.isSafeInteger(bytes) ||
            bytes < 0 ||
            (this.expandedBytes += bytes) > SOURCE_ARCHIVE_LIMITS.expandedBytes
        )
            archiveFailure('Архив превышает лимит 10000 записей или 8 ГиБ распакованных данных.');
    }
    add(
        raw: string,
        bytes: number,
        directory: boolean,
    ): { name: string; bytes: number; skip: boolean; directory: boolean } {
        this.reserve(bytes);
        const name = archivePath(raw, directory);
        if (directory && bytes) archiveFailure('Папка архива содержит данные.');
        if (!name) return { name, bytes, skip: true, directory };
        const key = name.normalize('NFC').toLowerCase(),
            parts = name.split('/');
        if (this.names.has(key) || (!directory && this.parents.has(key)))
            archiveFailure('В архиве повторяются или конфликтуют пути.');
        for (let length = 1; length <= parts.length; length++) {
            const prefix = parts.slice(0, length).join('/'),
                folded = prefix.normalize('NFC').toLowerCase();
            if (
                (this.spellings.has(folded) && this.spellings.get(folded) !== prefix) ||
                (length < parts.length && this.names.get(folded) === false)
            )
                archiveFailure('В архиве конфликтуют регистр, Unicode или родитель файла.');
            if (
                !this.spellings.has(folded) &&
                (this.identityBytes += Buffer.byteLength(prefix) + Buffer.byteLength(folded)) >
                    SOURCE_ARCHIVE_LIMITS.pathIdentityBytes
            )
                archiveFailure('Имена путей архива превышают допустимый объём.');
            this.spellings.set(folded, prefix);
            if (length < parts.length) this.parents.add(folded);
        }
        this.names.set(key, directory);
        return { name, bytes, skip: mac(name), directory };
    }
    async store(entry: ReturnType<ArchiveStager['add']>, input: Readable, checksum?: number): Promise<void> {
        const hash = createHash('sha256');
        let count = 0,
            crc = 0;
        const meter = new Transform({
            transform(chunk: Buffer, _encoding, done) {
                count += chunk.length;
                if (count > entry.bytes) {
                    done(new BadRequestException('Файл архива превышает заявленный размер.'));
                    return;
                }
                hash.update(chunk);
                crc = crc32(chunk, crc);
                done(null, chunk);
            },
        });
        const filename = path.join(this.directory, String(this.entries) + '.file');
        let release: () => void = () => {};
        try {
            if (!entry.skip && !entry.directory)
                release = await reserveCapacity({
                    resource: 'runtime-artifacts',
                    bytes: entry.bytes,
                    path: this.directory,
                });
            this.signal.throwIfAborted();
            const output =
                entry.skip || entry.directory
                    ? new Writable({
                          write(_chunk, _encoding, done) {
                              done();
                          },
                      })
                    : createWriteStream(filename, { flags: 'wx', mode: 0o600 });
            await pipeline(input, meter, output, { signal: this.signal });
            if (count !== entry.bytes || (checksum !== undefined && crc !== checksum))
                archiveFailure('Файл ZIP/TAR повреждён: размер или CRC не совпадает.');
            if (entry.skip || entry.directory) return;
            const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
            try {
                const info = await file.stat();
                if (!info.isFile() || info.nlink !== 1 || info.size !== count) archiveFailure();
                await file.sync();
            } finally {
                await file.close();
            }
            this.files.set(entry.name, { path: filename, bytes: count, sha256: hash.digest('hex') });
        } finally {
            release();
            input.destroy();
        }
    }
    result(): SourceArchiveResult {
        if (!this.files.size) archiveFailure('В архиве нет файлов поставки.');
        const names = [...this.files.keys()],
            first = names[0].split('/')[0];
        const rootName =
            !['.asset-source-metadata', '.asset-source-blobs'].includes(first) &&
            names.every((name) => name.startsWith(first + '/'))
                ? first
                : undefined;
        return {
            files: new Map(
                [...this.files].map(([name, file]) => [rootName ? name.slice(rootName.length + 1) : name, file]),
            ),
            ...(rootName ? { rootName } : {}),
        };
    }
}
