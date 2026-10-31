import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseCatalogRebuildRequest, type CatalogRebuildRequest } from '../../../shared/catalog-rebuild-request.cjs';

export interface CatalogRebuildItem {
    id: string;
    name: string;
    state: 'ready' | 'pending' | 'attention' | 'archive-required';
    message: string;
    operationId?: string;
    catalogId?: string;
}
export interface CatalogRebuildState {
    requestId: string;
    sourceRevision: string;
    requestedAt: string;
    updatedAt: string;
    state: 'preparing' | 'ready' | 'attention';
    items: CatalogRebuildItem[];
    message?: string;
}

/** Reusing a UUID with different source bytes or creation time cannot resume an earlier admission. */
export const sameCatalogRebuildRequest = (
    left: Pick<CatalogRebuildRequest, 'requestId' | 'sourceRevision' | 'requestedAt'> | undefined,
    right: CatalogRebuildRequest,
): boolean =>
    left?.requestId === right.requestId &&
    left.sourceRevision === right.sourceRevision &&
    left.requestedAt === right.requestedAt;

/** The operator file is bounded data; neither it nor its status can select executable paths or principals. */
async function localJson(file: string, maximum: number): Promise<unknown | undefined> {
    if (!path.isAbsolute(file) || path.resolve(file) !== file) throw Error('Некорректный путь запроса пересборки.');
    let handle;
    try {
        if ((await fs.realpath(file)) !== file) throw Error('Ссылка вместо запроса пересборки.');
        handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
    }
    try {
        const before = await handle.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum)
            throw Error('Некорректный запрос пересборки.');
        const bytes = Buffer.alloc(before.size + 1),
            read = await handle.read(bytes, 0, bytes.length, 0),
            after = await handle.stat();
        if (
            read.bytesRead !== before.size ||
            after.size !== before.size ||
            after.mtimeMs !== before.mtimeMs ||
            after.ctimeMs !== before.ctimeMs
        )
            throw Error('Запрос пересборки изменился при чтении.');
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, read.bytesRead)));
    } finally {
        await handle.close();
    }
}
export async function readCatalogRebuildRequest(file: string | undefined): Promise<CatalogRebuildRequest | undefined> {
    const value = file ? await localJson(file, 4096) : undefined;
    return value === undefined ? undefined : parseCatalogRebuildRequest(value);
}
/** A late status belongs to its original request; readers never show it as the result of a newer rebuild. */
export async function readCatalogRebuildState(file: string | undefined): Promise<CatalogRebuildState | undefined> {
    let request: CatalogRebuildRequest | undefined;
    try {
        request = await readCatalogRebuildRequest(file);
    } catch {
        return;
    }
    if (!request || !file) return;
    const waiting: CatalogRebuildState = {
        requestId: request.requestId,
        sourceRevision: request.sourceRevision,
        requestedAt: request.requestedAt,
        updatedAt: request.requestedAt,
        state: 'preparing',
        items: [],
        message: 'Запрос пересборки создан. Ожидаем проверку прав и приёма пакетов.',
    };
    try {
        const value = (await localJson(file + '.status.json', 128 * 1024)) as CatalogRebuildState | undefined;
        if (!value || !sameCatalogRebuildRequest(value, request)) return waiting;
        if (
            !['preparing', 'ready', 'attention'].includes(value.state) ||
            typeof value.updatedAt !== 'string' ||
            !Number.isFinite(Date.parse(value.updatedAt)) ||
            (value.message !== undefined && typeof value.message !== 'string') ||
            !Array.isArray(value.items) ||
            value.items.length > 100 ||
            value.items.some(
                (item) =>
                    !item ||
                    typeof item.id !== 'string' ||
                    typeof item.name !== 'string' ||
                    typeof item.message !== 'string' ||
                    !['ready', 'pending', 'attention', 'archive-required'].includes(item.state),
            )
        )
            throw Error('Invalid rebuild status');
        return value;
    } catch {
        return {
            ...waiting,
            state: 'attention',
            message: 'Состояние пересборки не подтверждено. Откройте операции; прежние пакеты сохранены.',
        };
    }
}
export async function writeCatalogRebuildState(
    file: string,
    request: CatalogRebuildRequest,
    value: CatalogRebuildState,
): Promise<void> {
    if (!sameCatalogRebuildRequest(await readCatalogRebuildRequest(file), request)) return;
    const target = file + '.status.json',
        temporary = path.join(path.dirname(file), '.catalog-rebuild-' + randomUUID() + '.tmp');
    try {
        await fs.writeFile(temporary, JSON.stringify(value) + '\n', { flag: 'wx', mode: 0o600, flush: true });
        await fs.rename(temporary, target);
    } finally {
        await fs.rm(temporary, { force: true });
    }
}
