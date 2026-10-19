import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat,open,writeFile,rename,rm} from 'node:fs/promises';

export const MAX_RECEIPT_BYTES = 16 * 1024;
const invalid = () => ({receipt: null, issue: 'Отметка готовности недоступна или повреждена. Проверьте её файл и повторите проверку модели.'});

/** Статус читает только небольшой обычный файл; FIFO и ссылки не открываются. */
export async function readReceipt(config) {
    let handle;
    try {
        const named = await lstat(config.receipt);
        if (!named.isFile() || named.isSymbolicLink() || !named.size || named.size > MAX_RECEIPT_BYTES) return invalid();
        handle = await open(config.receipt, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const before = await handle.stat();
        if (!before.isFile() || before.ino !== named.ino || before.dev !== named.dev || before.size > MAX_RECEIPT_BYTES) return invalid();
        const bytes = Buffer.alloc(MAX_RECEIPT_BYTES + 1);
        let size = 0;
        while (size < bytes.length) {
            const {bytesRead} = await handle.read(bytes, size, bytes.length - size, null);
            if (!bytesRead) break;
            size += bytesRead;
        }
        const after = await handle.stat();
        const current = await lstat(config.receipt);
        if (size > MAX_RECEIPT_BYTES || size !== before.size || after.size !== before.size
            || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
            || current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev) return invalid();
        const receipt = JSON.parse(bytes.subarray(0, size).toString('utf8'));
        return receipt && typeof receipt === 'object' && !Array.isArray(receipt) ? {receipt} : invalid();
    } catch (error) {
        if (error.code === 'ENOENT') return {receipt: null};
        if (error instanceof SyntaxError || ['EACCES', 'EPERM', 'ELOOP', 'ENOTDIR'].includes(error.code)) return invalid();
        throw error;
    } finally {await handle?.close();}
}

/** Квитанция появляется целиком; временный файл удаляется и при неудачной записи. */
export async function writeReceipt(config, value) {
    const temporary = config.receipt + '.' + randomUUID() + '.next';
    try {
        await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {mode: 0o600, flag: 'wx'});
        await rename(temporary, config.receipt);
    } finally {await rm(temporary, {force: true});}
}

/** Одна модель не подтверждает другую; дата обозначает последнюю содержательную пробу. */
export function verifiedReceipt(config, receipt) {
    const checkedAt = typeof receipt?.checkedAt === 'string' ? Date.parse(receipt.checkedAt) : NaN;
    return Number.isFinite(checkedAt) && checkedAt <= Date.now() && new Date(checkedAt).toISOString() === receipt.checkedAt
        && receipt?.model === config.lock.model && receipt?.manifestSha256 === config.lock.manifestSha256 && receipt?.image === config.lock.image
        && (config.capability === 'vision' ? receipt.capability === 'vision' && receipt.visionVerified === true
            : Number.isSafeInteger(config.lock.dimension) && receipt.dimension === config.lock.dimension);
}
