import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import type { BigIntStats } from 'node:fs';

export interface BoundedSnapshot { bytes: Buffer; fingerprint: string }
export const fileFingerprint = (stat: BigIntStats): string =>
    [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');

/** Чтение не открывает FIFO, не следует за leaf-симлинком и обнаруживает подмену inode/снимка. */
export async function readBoundedSnapshot(file: string, maximum: number): Promise<BoundedSnapshot> {
    if (!Number.isSafeInteger(maximum) || maximum < 0) { throw new Error('Некорректный лимит чтения файла.'); }
    const before = await fs.lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) {
        throw new Error('Локальный файл должен быть обычным файлом допустимого размера.');
    }
    const changed = () => Object.assign(new Error('Локальный файл изменился во время чтения.'), { code: 'ESTALE' });
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
        .catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { throw changed(); } throw error; });
    try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || opened.size > maximum || fileFingerprint(opened) !== fileFingerprint(before)) {
            throw changed();
        }
        const buffer = Buffer.alloc(Math.min(maximum + 1, Number(opened.size) + 1));
        let length = 0;
        while (length < buffer.length) {
            const read = await handle.read(buffer, length, buffer.length - length, null);
            if (!read.bytesRead) { break; }
            length += read.bytesRead;
        }
        const after = await handle.stat({ bigint: true });
        const located = await fs.lstat(file, { bigint: true }).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') { throw changed(); } throw error;
        });
        if (length > maximum || BigInt(length) !== opened.size || fileFingerprint(after) !== fileFingerprint(opened)
            || !located.isFile() || located.isSymbolicLink() || fileFingerprint(located) !== fileFingerprint(opened)) {
            throw changed();
        }
        return { bytes: buffer.subarray(0, length), fingerprint: fileFingerprint(opened) };
    } finally { await handle.close(); }
}

/** Исходные байты используются для бинарных файлов и квитанций без потерь UTF-8. */
export async function readBoundedBytes(file: string, maximum: number): Promise<Buffer> {
    return (await readBoundedSnapshot(file, maximum)).bytes;
}

/** Совместимый текстовый API дополнительно запрещает повреждённый UTF-8 до JSON.parse. */
export async function readBoundedUtf8(file: string, maximum: number): Promise<string> {
    const bytes = await readBoundedBytes(file, maximum);
    const text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) { throw new Error('Некорректное кодирование локального JSON.'); }
    return text;
}
