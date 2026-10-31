import { Header, type HeaderData } from 'tar';
import { Readable } from 'node:stream';
import { ArchiveStager, SOURCE_ARCHIVE_LIMITS, archiveFailure, archivePath } from './source-archive-reader-files';

/** At most one stream chunk and bounded TAR headers are retained in memory. */
class TarBytes {
    private chunk: Buffer = Buffer.alloc(0);
    private offset = 0;
    private total = 0;
    private readonly iterator: AsyncIterator<Buffer>;
    constructor(
        input: Readable,
        private readonly signal: AbortSignal,
    ) {
        this.iterator = input[Symbol.asyncIterator]();
    }
    async take(maximum: number): Promise<Buffer | undefined> {
        this.signal.throwIfAborted();
        while (this.offset === this.chunk.length) {
            const next = await this.iterator.next();
            if (next.done) return;
            this.chunk = next.value;
            this.offset = 0;
            this.total += next.value.length;
            if (this.total > SOURCE_ARCHIVE_LIMITS.expandedBytes + SOURCE_ARCHIVE_LIMITS.entries * 1024 + 1024 * 1024)
                archiveFailure('Поток TAR превышает допустимый размер.');
        }
        const end = Math.min(this.chunk.length, this.offset + maximum),
            bytes = this.chunk.subarray(this.offset, end);
        this.offset = end;
        return bytes;
    }
    async exact(size: number): Promise<Buffer> {
        const chunks: Buffer[] = [];
        let count = 0;
        while (count < size) {
            const chunk = await this.take(size - count);
            if (!chunk) archiveFailure('Архив TAR оборван.');
            chunks.push(chunk);
            count += chunk.length;
        }
        return Buffer.concat(chunks, size);
    }
    body(size: number): Readable {
        return Readable.from(
            (async function* (reader: TarBytes) {
                let remaining = size;
                while (remaining) {
                    const chunk = await reader.take(remaining);
                    if (!chunk) archiveFailure('Файл TAR оборван.');
                    remaining -= chunk.length;
                    yield chunk;
                }
            })(this),
        );
    }
    async padding(size: number): Promise<void> {
        const bytes = await this.exact((512 - (size % 512)) % 512);
        if (bytes.some((byte) => byte !== 0)) archiveFailure('Повреждено выравнивание TAR.');
    }
    async ending(): Promise<void> {
        const second = await this.exact(512);
        if (second.some((byte) => byte !== 0)) archiveFailure('Повреждено окончание TAR.');
        let count = 1024;
        for (;;) {
            const chunk = await this.take(64 * 1024);
            if (!chunk) break;
            count += chunk.length;
            if (chunk.some((byte) => byte !== 0)) archiveFailure('После окончания TAR найдены посторонние данные.');
        }
        if (count % 512) archiveFailure('Архив TAR оборван.');
    }
}
const text = (bytes: Buffer): string => {
    try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
        return archiveFailure('Путь TAR должен содержать UTF-8.');
    }
};
function stringField(block: Buffer, start: number, length: number, decode = true): Buffer {
    const field = block.subarray(start, start + length),
        end = field.indexOf(0);
    if (end >= 0 && field.subarray(end).some((byte) => byte !== 0))
        archiveFailure('В поле пути TAR найдены скрытые данные.');
    const bytes = end < 0 ? field : field.subarray(0, end);
    if (decode) text(bytes);
    return bytes;
}
function nameFields(block: Buffer, override?: string, extensionLabel = false): void {
    const name = stringField(block, 0, 100, false),
        prefix =
            block.subarray(257, 265).toString() === 'ustar\0' + '00'
                ? stringField(block, 345, block[475] ? 155 : 130, false)
                : Buffer.alloc(0);
    const raw = prefix.length ? Buffer.concat([prefix, Buffer.from('/'), name]) : name;
    try {
        text(raw);
    } catch (error) {
        if (extensionLabel) {
            // PAX/GNU labels are not extracted; native tar can truncate their final codepoint too.
            try {
                new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw, { stream: true });
                return;
            } catch {
                throw error;
            }
        }
        // Native tar may cut its fallback path mid-codepoint; the validated PAX/GNU name remains authoritative.
        const full = override === undefined ? undefined : Buffer.from(override);
        if (!full || raw.length >= full.length || !full.subarray(0, raw.length).equals(raw)) throw error;
    }
}
function declaredSize(block: Buffer): number {
    const field = block.subarray(124, 136);
    let size: number;
    if (field[0] & 0x80) {
        if (field[0] !== 0x80) archiveFailure('Некорректный размер TAR.');
        let integer = 0n;
        for (const byte of field.subarray(1)) integer = integer * 256n + BigInt(byte);
        if (integer > BigInt(Number.MAX_SAFE_INTEGER)) archiveFailure('Некорректный размер TAR.');
        size = Number(integer);
    } else {
        const value = field.toString('ascii').replace(/\0/g, ' ').trim();
        if (!/^[0-7]+$/.test(value)) archiveFailure('Некорректный размер TAR.');
        size = parseInt(value, 8);
    }
    return size;
}
function pax(bytes: Buffer): HeaderData {
    const result: HeaderData = {};
    let offset = 0;
    while (offset < bytes.length) {
        const space = bytes.indexOf(32, offset),
            digits = space < 0 ? '' : bytes.subarray(offset, space).toString('latin1');
        if (!/^[1-9]\d{0,8}$/.test(digits)) archiveFailure('Повреждены метаданные PAX.');
        const size = Number(digits),
            end = offset + size;
        if (end > bytes.length || end <= space + 1 || bytes[end - 1] !== 10)
            archiveFailure('Повреждены метаданные PAX.');
        const line = bytes.subarray(space + 1, end - 1),
            equals = line.indexOf(61),
            key = text(line.subarray(0, equals));
        if (equals < 1 || /[\x00-\x20\x7f]/.test(key) || /sparse/i.test(key) || key === 'SCHILY.filetype')
            archiveFailure('Неподдерживаемые или повреждённые метаданные PAX.');
        // Unknown xattrs are opaque bounded provenance; they are never applied to staged files.
        if (!['path', 'linkpath', 'size', 'hdrcharset'].includes(key)) {
            offset = end;
            continue;
        }
        const value = text(line.subarray(equals + 1));
        if (value.includes('\0') || (key === 'hdrcharset' && value !== 'UTF-8'))
            archiveFailure('Неподдерживаемые или повреждённые метаданные PAX.');
        if (key === 'path') {
            archivePath(value, value.endsWith('/'));
            result.path = value;
        }
        if (key === 'linkpath') {
            archivePath(value);
            result.linkpath = value;
        }
        if (key === 'size') {
            if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
                archiveFailure('Некорректный размер PAX.');
            result.size = Number(value);
        }
        offset = end;
    }
    return result;
}

/** TAR framing, metadata, payloads and the complete zero ending are validated incrementally. */
export async function readTarArchive(input: Readable, stager: ArchiveStager): Promise<void> {
    const bytes = new TarBytes(input, stager.signal);
    let extended: HeaderData = {},
        global: HeaderData = {},
        pending = false;
    try {
        for (;;) {
            const block = await bytes.exact(512);
            if (block.every((byte) => byte === 0)) {
                if (pending) archiveFailure('В TAR отсутствует файл после метаданных.');
                await bytes.ending();
                return;
            }
            const raw = new Header(block);
            if (!raw.cksumValid || !Number.isSafeInteger(raw.size) || raw.size! < 0)
                archiveFailure('Повреждён заголовок TAR.');
            const extension = [
                'ExtendedHeader',
                'GlobalExtendedHeader',
                'NextFileHasLongPath',
                'NextFileHasLongLinkpath',
            ].includes(raw.type);
            nameFields(block, extension ? undefined : extended.path, extension);
            stringField(block, 157, 100);
            archivePath(raw.path || '', raw.type === 'Directory');
            if (raw.type === 'Directory' && declaredSize(block) !== 0) archiveFailure('Папка TAR содержит данные.');
            if (extension) {
                stager.reserve(raw.size!);
                archivePath(raw.path || '');
                if (raw.size! > SOURCE_ARCHIVE_LIMITS.extensionBytes)
                    archiveFailure('Метаданные TAR превышают 64 КиБ.');
                const payload = await bytes.exact(raw.size!);
                await bytes.padding(raw.size!);
                if (raw.type === 'ExtendedHeader') {
                    extended = { ...extended, ...pax(payload) };
                    pending = true;
                } else if (raw.type === 'GlobalExtendedHeader') global = { ...global, ...pax(payload) };
                else {
                    const name = text(payload).replace(/\0$/, '');
                    archivePath(name);
                    extended = { ...extended, [raw.type === 'NextFileHasLongPath' ? 'path' : 'linkpath']: name };
                    pending = true;
                }
                continue;
            }
            const size = extended.size ?? global.size ?? raw.size!,
                header = new Header(block, 0, extended, global);
            if (extended.path !== undefined) header.path = extended.path;
            if (extended.linkpath !== undefined) header.linkpath = extended.linkpath;
            extended = {};
            pending = false;
            if (!['File', 'Directory'].includes(header.type) || header.linkpath)
                archiveFailure('Ссылки и специальные записи TAR запрещены.');
            if (header.type === 'Directory' && size !== 0) archiveFailure('Папка TAR содержит данные.');
            const entry = stager.add(header.path || '', header.size!, header.type === 'Directory');
            await stager.store(entry, bytes.body(entry.bytes));
            await bytes.padding(entry.bytes);
        }
    } finally {
        input.destroy();
    }
}
