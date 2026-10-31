import { BadRequestException } from '@nestjs/common';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import type { GgufMetadata } from '../../../../shared/gguf-import';
import type { GgufImportPolicy } from '../../../../shared/gguf-import-policy.cjs';

const invalid = (detail: string): never => {
    throw new BadRequestException('GGUF: ' + detail);
};
const safe = (number: bigint) =>
    number > BigInt(Number.MAX_SAFE_INTEGER) ? invalid('число превышает безопасный диапазон.') : Number(number);
// GGML block sizes from ggml-quants.h; unknown/new encodings require an explicit supported reader.
const tensorTypes: Record<number, readonly [number, number]> = {
    0: [1, 4],
    1: [1, 2],
    2: [32, 18],
    3: [32, 20],
    6: [32, 22],
    7: [32, 24],
    8: [32, 34],
    9: [32, 36],
    10: [256, 84],
    11: [256, 110],
    12: [256, 144],
    13: [256, 176],
    14: [256, 210],
    15: [256, 292],
    16: [256, 66],
    17: [256, 74],
    18: [256, 98],
    19: [256, 50],
    20: [32, 18],
    21: [256, 110],
    22: [256, 82],
    23: [256, 136],
    24: [1, 1],
    25: [1, 2],
    26: [1, 4],
    27: [1, 8],
    28: [1, 8],
    29: [256, 56],
    30: [1, 2],
};
const scalarSizes: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

/** Reads a bounded metadata region through one small cache; tensor bytes never enter memory. */
export async function inspectGguf(
    filename: string,
    limits: GgufImportPolicy,
    check: () => Promise<void> = async () => {},
): Promise<GgufMetadata> {
    const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1) invalid('нужен отдельный обычный файл.');
        let offset = 0,
            cacheStart = -1,
            cacheEnd = -1,
            steps = 0;
        const cache = Buffer.alloc(64 * 1024);
        const bound = (length: number) => {
            if (
                !Number.isSafeInteger(length) ||
                length < 0 ||
                offset + length > Math.min(info.size, limits.metadataBytes)
            )
                invalid('заголовок обрезан или превышает настроенный лимит метаданных.');
        };
        const read = async (length: number): Promise<Buffer> => {
            bound(length);
            const result = Buffer.alloc(length);
            let copied = 0;
            while (copied < length) {
                if (offset < cacheStart || offset >= cacheEnd) {
                    cacheStart = offset;
                    cacheEnd =
                        offset +
                        (await file.read(cache, 0, Math.min(cache.length, info.size - offset), offset)).bytesRead;
                    if (cacheEnd === offset) invalid('неполный заголовок.');
                }
                const size = Math.min(length - copied, cacheEnd - offset);
                cache.copy(result, copied, offset - cacheStart, offset - cacheStart + size);
                copied += size;
                offset += size;
            }
            if (++steps % 1024 === 0) await check();
            return result;
        };
        const u32 = async () => (await read(4)).readUInt32LE();
        const u64 = async () => safe((await read(8)).readBigUInt64LE());
        const string = async (maximum = limits.stringBytes) => {
            const length = await u64();
            if (length > maximum) invalid('строка превышает настроенный лимит.');
            const bytes = await read(length);
            try {
                return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            } catch {
                return invalid('некорректный UTF-8.');
            }
        };
        const skip = (length: number) => {
            bound(length);
            offset += length;
        };
        const value = async (type: number): Promise<string | number | undefined> => {
            if (type === 8) return string();
            if (type === 9) {
                const element = await u32(),
                    count = await u64();
                if (count > limits.arrayElements || element === 9 || !(element === 8 || scalarSizes[element]))
                    invalid('неподдерживаемый или слишком большой массив метаданных.');
                if (element === 8) {
                    for (let n = 0; n < count; n++) {
                        const length = await u64();
                        if (length > limits.stringBytes) invalid('элемент массива превышает лимит строки.');
                        skip(length);
                    }
                } else skip(count * scalarSizes[element]);
                return;
            }
            const size = scalarSizes[type];
            if (!size) invalid('неизвестный тип метаданных.');
            const bytes = await read(size);
            return type === 4
                ? bytes.readUInt32LE()
                : type === 10
                  ? safe(bytes.readBigUInt64LE())
                  : type === 0
                    ? bytes[0]
                    : undefined;
        };
        if ((await read(4)).toString('ascii') !== 'GGUF') invalid('выберите файл .gguf, а не архив или HTML.');
        const version = await u32();
        if (version !== 2 && version !== 3) invalid('поддерживаются только версии 2 и 3 little-endian.');
        const tensorCount = await u64(),
            metadataCount = await u64();
        if (!tensorCount || tensorCount > limits.tensorCount || metadataCount > limits.metadataPairs)
            invalid('число тензоров или метаданных превышает настроенный лимит.');
        const keys = new Set<string>();
        let architecture = '',
            alignment = 32;
        for (let n = 0; n < metadataCount; n++) {
            const key = await string(65535);
            if (!key || keys.has(key)) invalid('повторяющийся или пустой ключ метаданных.');
            keys.add(key);
            const item = await value(await u32());
            if (key === 'general.architecture') {
                if (
                    typeof item !== 'string' ||
                    !/[a-z0-9]/.test(item) ||
                    !/^[a-z0-9]+$/.test(item) ||
                    item.length > 128
                )
                    invalid('не задана корректная general.architecture.');
                architecture = String(item);
            }
            if (key === 'general.alignment') {
                if (typeof item !== 'number' || item < 1 || item > 65536 || (item & (item - 1)) !== 0)
                    invalid('некорректное выравнивание.');
                alignment = Number(item);
            }
            if (
                key.startsWith('split.') ||
                key.startsWith('adapter.') ||
                key.startsWith('clip.') ||
                (key === 'general.type' && item !== undefined && item !== 'model')
            )
                invalid('нужен один полный chat/embedding файл; split, adapter и projector не поддерживаются.');
        }
        if (!architecture || ['clip', 'llava', 'projector', 'adapter'].includes(architecture))
            invalid('нужна архитектура полной chat/embedding модели.');
        const tensors: Array<{ offset: number; bytes: number }> = [],
            names = new Set<string>();
        for (let n = 0; n < tensorCount; n++) {
            const name = await string(64);
            if (!name || names.has(name) || /lora_[ab]|mmproj|projector/i.test(name))
                invalid('повторяющийся тензор, adapter или projector.');
            names.add(name);
            const dimensions = await u32();
            if (dimensions < 1 || dimensions > 4) invalid('неподдерживаемое число измерений тензора.');
            let elements = 1,
                first = 0;
            for (let d = 0; d < dimensions; d++) {
                const size = await u64();
                if (!size) invalid('пустой тензор.');
                if (d === 0) first = size;
                elements *= size;
                if (!Number.isSafeInteger(elements)) invalid('слишком большой тензор.');
            }
            const type = await u32(),
                layout = tensorTypes[type];
            if (!layout) invalid('тип тензора ' + type + ' пока не поддерживается.');
            if (first % layout[0]) invalid('размер строки не соответствует quant-блоку.');
            const bytes = (elements / layout[0]) * layout[1],
                position = await u64();
            if (!Number.isSafeInteger(bytes) || position % alignment) invalid('неверный размер или смещение тензора.');
            tensors.push({ offset: position, bytes });
        }
        const dataStart = Math.ceil(offset / alignment) * alignment;
        let end = 0;
        for (const tensor of tensors.sort((a, b) => a.offset - b.offset)) {
            if (tensor.offset < end || dataStart + tensor.offset + tensor.bytes > info.size)
                invalid('тензоры пересекаются или выходят за границы файла.');
            end = tensor.offset + tensor.bytes;
        }
        await check();
        const after = await file.stat();
        if (info.ino !== after.ino || info.size !== after.size || info.mtimeMs !== after.mtimeMs || after.nlink !== 1)
            invalid('файл изменился во время проверки.');
        return { format: 'gguf', version: version as 2 | 3, architecture, tensorCount, metadataCount };
    } finally {
        await file.close();
    }
}
