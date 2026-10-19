import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { writeRows } from '../lib/lancedb.js';
import { locateStore } from '../lib/store.js';
import { readRagProjectIdentity, unverifiedRagProject, verifiedRagProjectIdentity } from '../lib/rag-project-identity.js';
import { ragStoreBoundary } from '../lib/rag-store-boundary.js';
import { withWorkspaceIdentityLock } from '../bridge/workspace-identity-state.js';
import { safeTarget } from '../bridge/workspace-paths.js';
import { authorizedFetch } from '../bridge/state.js';
import { assertIndexIdle, localIndexProfile, localEmbeddingIdentity, assertSameProfile } from '../features/rag-index/readiness.js';
import { FINGERPRINT_VERSION, normalizeIndexProfile, normalizeChunkRow, rowFingerprint, indexSnapshotHash, type IIndexProfile } from '../features/rag-index/contract.js';
import { importRow, exportRow } from '../features/rag-index/paths.js';
import { openIndexSnapshot } from '../features/rag-index/snapshot.js';
import { readBoundedUtf8 } from '../bridge/read-bounded.js';
import { reserveRestoreIndex } from '../features/rag-index/restore-lock.js';

const PAGE_LIMIT = 1000;
export const restoreRagDbInputSchema = z.object({ projectKey: z.string().min(1), project: z.string().optional() });
export type TRestoreRagDbInput = z.infer<typeof restoreRagDbInputSchema>;
const sourceSchema = z.object({
    projectKey: z.string(), fingerprintVersion: z.literal(1), complete: z.literal(true), indexState: z.literal('ready'),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/), indexProfile: z.unknown(), rowCount: z.number().int().positive(),
    incompleteRows: z.literal(0),
});

/** Загружает проверенный снимок в соседний staging и заменяет индекс только после полной проверки. */
export async function restoreRagDb(input: TRestoreRagDbInput, cwd: string, authorize: () => Promise<void> = async () => {}): Promise<string> {
    const projectKey = input.projectKey.trim();
    const initial = await readRagProjectIdentity({ project: input.project }, cwd);
    if (!verifiedRagProjectIdentity(initial.value, projectKey)) { return unverifiedRagProject(); }
    const located = await locateStore(input.project, cwd, true);
    if (!located.storePath) { throw new Error('Не определена папка локального индекса.'); }
    const { storePath } = located;
    let lock: Awaited<ReturnType<typeof reserveRestoreIndex>> | undefined;
    const assertStore = ragStoreBoundary(input.project, cwd, storePath, true);
    const assertIdentity = async () => {
        await authorize();
        const current = await readRagProjectIdentity({ project: input.project }, cwd);
        if (!verifiedRagProjectIdentity(current.value, projectKey, initial.value)) { throw new Error('Привязка локального экземпляра изменилась. Восстановление остановлено.'); }
        await assertStore();
        await lock?.assert();
        await assertIndexIdle(storePath, true, lock?.raw);
    };
    await assertIdentity();
    let oldDimension: number | undefined;
    let previous: Awaited<ReturnType<typeof openIndexSnapshot>> | undefined;
    try { await fs.lstat(path.join(storePath, 'chunks.lance')); previous = await openIndexSnapshot(storePath); oldDimension = previous.dimension; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
    let expected: z.infer<typeof sourceSchema> | undefined;
    let indexProfile: IIndexProfile | null = null;
    let stage: string | undefined;
    let runtimeOverrides: string | null = null;
    const readOverrides = async () => {
        try { return await readBoundedUtf8(await safeTarget(storePath, 'runtime-overrides.json'), 1024 * 1024); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return null; } throw error; }
    };
    let offset = 0;
    const fingerprints: Record<string, string> = Object.create(null) as Record<string, string>;
    try {
        for (;;) {
            await assertIdentity();
            await previous?.assertCurrent();
            const response = await authorizedFetch(`/api/rag/chunks?projectKey=${encodeURIComponent(projectKey)}&limit=${PAGE_LIMIT}&offset=${offset}`);
            if (!response.ok) { throw new Error(`Восстановление остановлено (HTTP ${response.status}). Исходный локальный индекс сохранён.`); }
            const raw: unknown = await response.json();
            const metadata = sourceSchema.safeParse(raw);
            const page = z.object({ chunks: z.array(z.unknown()), hasMore: z.boolean() }).safeParse(raw);
            if (!metadata.success || !page.success) { throw new Error('Серверная копия не является завершённым проверенным снимком V1. Сначала выполните полную синхронизацию.'); }
            const current = metadata.data;
            if (current.projectKey !== projectKey) { throw new Error('Сервер вернул индекс другого проекта.'); }
            const profile = normalizeIndexProfile(current.indexProfile);
            if (!profile) { throw new Error('Профиль серверной модели не подтверждён.'); }
            if (!expected) {
                indexProfile = profile;
                assertSameProfile(await localIndexProfile(located, oldDimension ?? profile.dimension), profile);
                expected = current;
                // Создание staging разрешено только после проверки профиля и источника.
                await assertIdentity();
                lock = await reserveRestoreIndex(located.root, storePath);
                await assertIdentity();
                await fs.mkdir(path.dirname(storePath), { recursive: true });
                const parentRelative = path.relative(located.root, path.dirname(storePath)).split(path.sep).join('/');
                const parent = parentRelative ? await safeTarget(located.root, parentRelative) : located.root;
                stage = await fs.mkdtemp(path.join(parent, '.neurocenter-rag-restore-'));
            } else {
                assertSameProfile(indexProfile!, profile);
                if (current.snapshotHash !== expected.snapshotHash || current.rowCount !== expected.rowCount) { throw new Error('Серверный снимок изменился во время скачивания. Локальный индекс сохранён.'); }
            }
            if (!page.data.chunks.length) { throw new Error('Сервер вернул неполный или пустой снимок. Локальный индекс сохранён.'); }
            const rows: Record<string, unknown>[] = [];
            for (const value of page.data.chunks) {
                const row = normalizeChunkRow(value);
                if (!row.embedding || row.embedding.length !== profile.dimension || Object.hasOwn(fingerprints, row.id)) { throw new Error('Серверный снимок содержит неполные векторы или повторные идентификаторы.'); }
                fingerprints[row.id] = rowFingerprint(row);
                rows.push({ ...await importRow(row, located.root) });
            }
            await assertIdentity();
            await writeRows(stage!, rows, false, profile.dimension);
            offset += rows.length;
            if (offset > expected.rowCount || (page.data.hasMore && offset >= expected.rowCount)) { throw new Error('Количество фрагментов не соответствует снимку.'); }
            if (!page.data.hasMore) { break; }
        }
        if (!expected || !indexProfile || offset !== expected.rowCount || indexSnapshotHash(indexProfile, fingerprints) !== expected.snapshotHash) { throw new Error('Полнота серверного снимка не подтверждена. Локальный индекс сохранён.'); }
        // Проверяем записанный LanceDB, включая float32 и перебазированные пути, а не только входящие JSON.
        const staged = await openIndexSnapshot(stage!);
        try {
            const actual: Record<string, string> = Object.create(null) as Record<string, string>;
            for await (const value of staged.rows()) { const row = await exportRow(value, located.root); actual[row.id] = rowFingerprint(row); }
            if (staged.rowCount !== offset || indexSnapshotHash(indexProfile, actual) !== expected.snapshotHash) { throw new Error('Проверка записанного LanceDB не пройдена. Исходный индекс сохранён.'); }
        } finally { staged.close(); }
        await assertIdentity();
        const check = await authorizedFetch(`/api/rag/manifest?projectKey=${encodeURIComponent(projectKey)}`);
        const latest = check.ok ? sourceSchema.safeParse(await check.json()) : null;
        if (!latest?.success || latest.data.snapshotHash !== expected.snapshotHash || latest.data.rowCount !== expected.rowCount) { throw new Error('Снимок изменился перед сохранением. Повторите восстановление.'); }
        assertSameProfile(indexProfile, normalizeIndexProfile(latest.data.indexProfile));
        // Runtime-настройки принадлежат целевой папке, а не скачиваемому индексу.
        runtimeOverrides = await readOverrides();
        if (runtimeOverrides !== null) { await fs.writeFile(path.join(stage!, 'runtime-overrides.json'), runtimeOverrides); }
        await fs.writeFile(path.join(stage!, 'neurocenter-restored.json'), JSON.stringify({ fingerprintVersion: 1, complete: true, indexProfile, snapshotHash: expected.snapshotHash, rowCount: offset }));
        const targetIdentity = await localEmbeddingIdentity(await locateStore(input.project, cwd, true), oldDimension ?? indexProfile.dimension);
        assertSameProfile(indexProfile, targetIdentity.profile);
        await fs.writeFile(path.join(stage!, 'neurocenter-index-profile.json'), JSON.stringify({ schemaVersion: 1, state: 'ready', profile: indexProfile, embeddingSignature: targetIdentity.signature }));
        await lock!.place(stage!);
        const backup = stage! + '-previous';
        lock!.track(backup);
        await withWorkspaceIdentityLock(async () => {
            await assertIdentity(); // binding-aware lease check immediately before local commit
            const currentTarget = await localEmbeddingIdentity(await locateStore(input.project, cwd, true), oldDimension ?? indexProfile!.dimension);
            assertSameProfile(indexProfile!, currentTarget.profile);
            if (currentTarget.signature !== targetIdentity.signature) { throw new Error('Подключение к модели изменилось перед сохранением. Повторите восстановление.'); }
            if (await readOverrides() !== runtimeOverrides) { throw new Error('Настройки индекса изменились перед сохранением. Повторите восстановление.'); }
            if (!previous) {
                try { await fs.lstat(path.join(storePath, 'chunks.lance')); throw new Error('Локальный индекс появился во время скачивания. Повторите восстановление.'); }
                catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
            }
            await previous?.assertCurrent();
            await lock!.assert(stage!);
            previous?.close(); previous = undefined;
            let moved = false;
            try { await fs.rename(storePath, backup); moved = true; }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
            try { await fs.rename(stage!, storePath); }
            catch (error) { if (moved) { await fs.rename(backup, storePath); } throw error; }
            stage = undefined;
        });
        await fs.rm(backup, { recursive: true, force: true });
        return JSON.stringify({ ok: true, applied: true, complete: true, remaining: 0, projectKey, fingerprintVersion: FINGERPRINT_VERSION,
            indexProfile, snapshotHash: expected.snapshotHash, sourceCount: offset, written: offset, dimension: indexProfile.dimension,
            note: 'Семантический индекс восстановлен. OpenCode пересоздаст служебные индексы при следующем запуске.' });
    } finally {
        previous?.close();
        try { await lock?.release(); }
        finally { if (stage) { await fs.rm(stage, { recursive: true, force: true }); } }
    }
}
