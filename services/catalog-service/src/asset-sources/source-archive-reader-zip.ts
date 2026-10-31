import type { FileHandle } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createInflateRaw } from 'node:zlib';
import { ArchiveStager, SOURCE_ARCHIVE_LIMITS, archiveFailure, archiveFileStream } from './source-archive-reader-files';

interface ZipEntry {
    fileName: string;
    fileNameRaw: Buffer;
    uncompressedSize: number;
    compressedSize: number;
    externalFileAttributes: number;
    generalPurposeBitFlag: number;
    crc32: number;
    compressionMethod: number;
    relativeOffsetOfLocalHeader: number;
}
interface LocalHeader {
    fileDataStart: number;
    generalPurposeBitFlag: number;
    compressionMethod: number;
    crc32: number;
    compressedSize: number;
    uncompressedSize: number;
    fileName: Buffer;
    extraField: Buffer;
}
interface ZipArchive {
    entryCount: number;
    readEntryCursor: number;
    on(event: 'entry', listener: (entry: ZipEntry) => void): this;
    on(event: 'error', listener: (error: Error) => void): this;
    on(event: 'end', listener: () => void): this;
    readEntry(): void;
    close(): void;
    readLocalFileHeaderPromise(entry: ZipEntry, options: object): Promise<LocalHeader>;
    openReadStreamPromise(entry: ZipEntry, options: object): Promise<Readable>;
}
interface AccessReader {
    close(callback: (error?: Error) => void): void;
    _readStreamForRange(start: number, end: number): Readable;
}
const yauzl = require('yauzl') as {
    RandomAccessReader: new () => AccessReader;
    fromRandomAccessReaderPromise: (reader: AccessReader, size: number, options: object) => Promise<ZipArchive>;
};
const integer = (value: bigint): number => {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) archiveFailure('ZIP64 содержит слишком большой размер.');
    return Number(value);
};
async function at(file: FileHandle, position: number, size: number): Promise<Buffer> {
    if (!Number.isSafeInteger(position) || position < 0 || !Number.isSafeInteger(size) || size < 0) archiveFailure();
    const bytes = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
        const next = await file.read(bytes, read, size - read, position + read);
        if (!next.bytesRead) archiveFailure('ZIP оборван.');
        read += next.bytesRead;
    }
    return bytes;
}
async function layout(file: FileHandle, size: number): Promise<{ start: number; end: number; entries: number }> {
    const tail = await at(file, Math.max(0, size - 65557), Math.min(size, 65557));
    let offset = -1;
    for (let index = tail.length - 22; index >= 0; index--)
        if (tail.readUInt32LE(index) === 0x06054b50) {
            offset = index;
            break;
        }
    if (offset < 0 || offset + 22 + tail.readUInt16LE(offset + 20) !== tail.length)
        archiveFailure('Повреждено окончание ZIP или после него есть данные.');
    const endOffset = size - tail.length + offset;
    if (tail.readUInt16LE(offset + 4) || tail.readUInt16LE(offset + 6)) archiveFailure('Многотомные ZIP запрещены.');
    let start = tail.readUInt32LE(offset + 16),
        length = tail.readUInt32LE(offset + 12),
        entries = tail.readUInt16LE(offset + 10),
        end = endOffset;
    if (endOffset >= 20) {
        const locator = await at(file, endOffset - 20, 20);
        if (locator.readUInt32LE(0) === 0x07064b50) {
            if (locator.readUInt32LE(4) !== 0 || locator.readUInt32LE(16) !== 1)
                archiveFailure('Многотомные ZIP64 запрещены.');
            end = integer(locator.readBigUInt64LE(8));
            const record = await at(file, end, 56),
                recordSize = integer(record.readBigUInt64LE(4));
            if (
                record.readUInt32LE(0) !== 0x06064b50 ||
                recordSize < 44 ||
                end + 12 + recordSize !== endOffset - 20 ||
                record.readUInt32LE(16) ||
                record.readUInt32LE(20) ||
                record.readBigUInt64LE(24) !== record.readBigUInt64LE(32)
            )
                archiveFailure('Повреждён каталог ZIP64.');
            entries = integer(record.readBigUInt64LE(32));
            length = integer(record.readBigUInt64LE(40));
            start = integer(record.readBigUInt64LE(48));
        } else if (tail.readUInt16LE(offset + 8) !== entries) archiveFailure('Повреждено число записей ZIP.');
    }
    if (entries > SOURCE_ARCHIVE_LIMITS.entries || start + length !== end || start < 0 || start > end)
        archiveFailure('ZIP превышает лимиты или содержит повреждённый каталог.');
    return { start, end, entries };
}
function localSizes(local: LocalHeader): { compressed: number; uncompressed: number } {
    let compressed = local.compressedSize,
        uncompressed = local.uncompressedSize;
    if (compressed !== 0xffffffff && uncompressed !== 0xffffffff) return { compressed, uncompressed };
    for (let offset = 0; offset + 4 <= local.extraField.length;) {
        const id = local.extraField.readUInt16LE(offset),
            length = local.extraField.readUInt16LE(offset + 2);
        offset += 4;
        if (offset + length > local.extraField.length) archiveFailure('Повреждены расширения ZIP64.');
        if (id === 1) {
            let cursor = offset;
            if (uncompressed === 0xffffffff) {
                if (cursor + 8 > offset + length) archiveFailure();
                uncompressed = integer(local.extraField.readBigUInt64LE(cursor));
                cursor += 8;
            }
            if (compressed === 0xffffffff) {
                if (cursor + 8 > offset + length) archiveFailure();
                compressed = integer(local.extraField.readBigUInt64LE(cursor));
            }
            return { compressed, uncompressed };
        }
        offset += length;
    }
    return archiveFailure('В ZIP64 отсутствуют размеры файла.');
}
interface Region {
    start: number;
    end: number;
    entry: Pick<ZipEntry, 'generalPurposeBitFlag' | 'crc32' | 'compressedSize' | 'uncompressedSize'>;
}
async function regions(file: FileHandle, items: Region[], end: number): Promise<void> {
    items.sort((a, b) => a.start - b.start);
    let expected = 0;
    for (let index = 0; index < items.length; index++) {
        const item = items[index],
            next = items[index + 1]?.start ?? end;
        if (item.start !== expected || item.end > next)
            archiveFailure('Данные ZIP перекрываются или содержат посторонние записи.');
        const length = next - item.end;
        if (item.entry.generalPurposeBitFlag & 8) {
            if (![12, 16, 20, 24].includes(length)) archiveFailure('Повреждён дескриптор данных ZIP.');
            const bytes = await at(file, item.end, length),
                signed = length === 16 || length === 24,
                offset = signed ? 4 : 0;
            if (signed && bytes.readUInt32LE(0) !== 0x08074b50) archiveFailure('Повреждён дескриптор данных ZIP.');
            const wide = length >= 20,
                compressed = wide ? integer(bytes.readBigUInt64LE(offset + 4)) : bytes.readUInt32LE(offset + 4),
                uncompressed = wide ? integer(bytes.readBigUInt64LE(offset + 12)) : bytes.readUInt32LE(offset + 8);
            if (
                bytes.readUInt32LE(offset) !== item.entry.crc32 ||
                compressed !== item.entry.compressedSize ||
                uncompressed !== item.entry.uncompressedSize
            )
                archiveFailure('Размер или CRC дескриптора ZIP не совпадает.');
        } else if (length) archiveFailure('Между файлами ZIP найдены посторонние данные.');
        expected = next;
    }
    if (expected !== end) archiveFailure('В ZIP найдены незаявленные данные.');
}

/** Lazy random-access ZIP streams each payload and validates every local record, CRC and complete directory. */
export async function readZipArchive(file: FileHandle, size: number, stager: ArchiveStager): Promise<void> {
    const directory = await layout(file, size);
    const reader = new (class extends yauzl.RandomAccessReader {
        _readStreamForRange(start: number, end: number): Readable {
            return archiveFileStream(file, start, end);
        }
        close(done: (error?: Error) => void): void {
            done();
        }
    })();
    const zip = await yauzl.fromRandomAccessReaderPromise(reader, size, {
        lazyEntries: true,
        strictFileNames: true,
        validateEntrySizes: true,
        autoClose: false,
    });
    const ranges: Region[] = [];
    let active: Readable | undefined, pending: Promise<void> | undefined;
    try {
        if (zip.entryCount !== directory.entries || zip.readEntryCursor !== directory.start) archiveFailure();
        await new Promise<void>((resolve, reject) => {
            let settled = false;
            const stop = (error?: Error) => {
                if (settled) return;
                settled = true;
                stager.signal.removeEventListener('abort', abort);
                active?.destroy();
                if (error) reject(error);
                else resolve();
            };
            const abort = () => stop(stager.signal.reason as Error);
            zip.on('error', stop);
            zip.on('end', () => stop());
            zip.on('entry', (entry: ZipEntry) => {
                pending = (async () => {
                    stager.signal.throwIfAborted();
                    let name = entry.fileName;
                    try {
                        const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
                            entry.fileNameRaw,
                        );
                        if (entry.generalPurposeBitFlag & 0x800 || entry.fileNameRaw.some((byte) => byte > 127))
                            name = decoded;
                    } catch {
                        if (entry.generalPurposeBitFlag & 0x800)
                            archiveFailure('Путь ZIP содержит некорректный UTF-8.');
                    }
                    const isDirectory = name.endsWith('/'),
                        mode = (entry.externalFileAttributes >>> 16) & 0o170000;
                    if (
                        entry.generalPurposeBitFlag & (1 | 64 | 8192) ||
                        (mode && mode !== (isDirectory ? 0o040000 : 0o100000)) ||
                        ![0, 8].includes(entry.compressionMethod)
                    )
                        archiveFailure('Ссылки, специальные или зашифрованные записи ZIP запрещены.');
                    const target = stager.add(name, entry.uncompressedSize, isDirectory),
                        local = await zip.readLocalFileHeaderPromise(entry, { minimal: false });
                    if (
                        !local.fileName.equals(entry.fileNameRaw) ||
                        local.generalPurposeBitFlag !== entry.generalPurposeBitFlag ||
                        local.compressionMethod !== entry.compressionMethod
                    )
                        archiveFailure('Локальный заголовок ZIP противоречит каталогу.');
                    if (!(entry.generalPurposeBitFlag & 8)) {
                        const sizes = localSizes(local);
                        if (
                            local.crc32 !== entry.crc32 ||
                            sizes.compressed !== entry.compressedSize ||
                            sizes.uncompressed !== entry.uncompressedSize
                        )
                            archiveFailure('Размер или CRC заголовка ZIP не совпадает.');
                    }
                    const dataEnd = local.fileDataStart + entry.compressedSize;
                    if (
                        !Number.isSafeInteger(dataEnd) ||
                        entry.relativeOffsetOfLocalHeader < 0 ||
                        dataEnd > directory.start
                    )
                        archiveFailure('Файл ZIP выходит за границы данных.');
                    ranges.push({
                        start: entry.relativeOffsetOfLocalHeader,
                        end: dataEnd,
                        entry: {
                            generalPurposeBitFlag: entry.generalPurposeBitFlag,
                            crc32: entry.crc32,
                            compressedSize: entry.compressedSize,
                            uncompressedSize: entry.uncompressedSize,
                        },
                    });
                    const raw = await zip.openReadStreamPromise(
                        entry,
                        entry.compressionMethod === 8 ? { decompress: false } : {},
                    );
                    active = raw;
                    if (settled) {
                        raw.destroy();
                        return;
                    }
                    if (entry.compressionMethod === 8) {
                        const inflated = createInflateRaw(),
                            pumping = pipeline(raw, inflated, { signal: stager.signal });
                        pumping.catch(() => undefined);
                        active = inflated;
                        try {
                            await stager.store(target, inflated, entry.crc32);
                            await pumping;
                            if (inflated.bytesWritten !== entry.compressedSize)
                                archiveFailure('После сжатых данных ZIP найдены посторонние байты.');
                        } finally {
                            raw.destroy();
                            inflated.destroy();
                            await pumping.catch(() => undefined);
                        }
                    } else await stager.store(target, raw, entry.crc32);
                    active = undefined;
                    if (!settled) zip.readEntry();
                })();
                pending.catch(stop);
            });
            stager.signal.addEventListener('abort', abort, { once: true });
            if (stager.signal.aborted) abort();
            else zip.readEntry();
        });
        if (zip.readEntryCursor !== directory.end || ranges.length !== directory.entries)
            archiveFailure('Каталог ZIP содержит лишние или отсутствующие записи.');
        await regions(file, ranges, directory.start);
    } finally {
        active?.destroy();
        await pending?.catch(() => undefined);
        zip.close();
    }
}
