export const FILE_BYTES_LIMIT = 1048576;
export const RECEIPT_BYTES_LIMIT = 256 * 1024;
export const LEDGER_BYTES_LIMIT = 4 * 1048576;
export const LOCK_BYTES_LIMIT = 4096;
export const JOURNAL_BYTES_LIMIT = 64 * 1048576;
export const RECOVERY_BYTES_LIMIT = 1024 * 1048576;
export const DISK_RESERVE_BYTES = 128 * 1048576;

/** Метаданные имеют собственный конечный предел, независимый от лимита файлов пакета. */
export function installationReadLimit(relative: string): number {
    if (relative === '.opencode/neurocenter/installations.json') { return LEDGER_BYTES_LIMIT; }
    if (/^\.opencode\/neurocenter\/receipts\/[a-f0-9]{24}\.json$/.test(relative)) { return RECEIPT_BYTES_LIMIT; }
    if (relative === '.opencode/neurocenter/files.lock') { return LOCK_BYTES_LIMIT; }
    return FILE_BYTES_LIMIT;
}
