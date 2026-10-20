import { z } from 'zod';
import { contentHash } from '../lib/lancedb.js';
import { locateStore } from '../lib/store.js';
import { readRagProjectIdentity, unverifiedRagProject, verifiedRagProjectIdentity } from '../lib/rag-project-identity.js';
import { ragStoreBoundary } from '../lib/rag-store-boundary.js';
import { authorizedFetch } from '../bridge/state.js';
import { openIndexSnapshot } from '../features/rag-index/snapshot.js';
import { exportRow } from '../features/rag-index/paths.js';
import { assertIndexIdle, assertVerifiedIndex, assertSameProfile } from '../features/rag-index/readiness.js';
import { FINGERPRINT_VERSION, rowFingerprint, indexSnapshotHash, normalizeIndexProfile, ragRequestHash, type ICanonicalRagRow } from '../features/rag-index/contract.js';

const AUTO_APPLY_LIMIT = 1000;
const BATCH = 100;
export const syncRagDbInputSchema = z.object({
    project: z.string().optional(), projectKey: z.string().optional(), createIfMissing: z.boolean().optional(),
    dryRun: z.boolean().optional(), scanLimit: z.number().int().positive().optional(),
    maxRows: z.number().int().positive().optional(), limit: z.number().int().positive().optional(),
});
export type TSyncRagDbInput = z.infer<typeof syncRagDbInputSchema>;
const manifestSchema = z.object({
    fingerprintVersion: z.literal(1), fingerprints: z.record(z.string().regex(/^[a-f0-9]{64}$/)),
    rowCount: z.number().int().nonnegative(), incompleteRows: z.number().int().nonnegative(),
    indexProfile: z.unknown(), complete: z.boolean(), snapshotHash: z.string().nullable(), ids: z.record(z.string()),
    usableVectorCount: z.number().int().nonnegative().optional(),
    indexState: z.enum(['unverified', 'syncing', 'ready']).optional(),
    generation:z.string().regex(/^(?:initial-[a-f0-9]{32}|[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})$/),
    selectionRevision:z.number().int().nonnegative(),dataRevision:z.number().int().nonnegative(),selectedProfile:z.unknown(),
});

/** Передаёт стабильный полный native-снимок порциями; готовность подтверждает отдельная серверная печать. */
export async function syncRagDb(input: TSyncRagDbInput, cwd: string, authorize: () => Promise<void> = async () => {},options:{allowEmpty?:boolean}={}): Promise<string> {
    const resolveIdentity = () => readRagProjectIdentity({ project: input.project, createIfMissing: input.dryRun || input.scanLimit ? false : input.createIfMissing }, cwd);
    const initial = await resolveIdentity();
    const projectKey = input.projectKey?.trim() || initial.value.projectKey;
    if (!projectKey) { return initial.raw; }
    if (!input.dryRun && !verifiedRagProjectIdentity(initial.value, projectKey)) { return unverifiedRagProject(); }
    const located = await locateStore(input.project, cwd);
    if (!located.storePath) { return JSON.stringify({ ok: false, error: 'store-not-found', message: 'Индекс не найден. Запустите OpenCodeRAG в связанной папке проекта.' }); }
    const { storePath } = located;
    const assertStore = ragStoreBoundary(input.project, cwd, storePath);
    await assertStore();
    const health = await assertIndexIdle(storePath);
    const snapshot = await openIndexSnapshot(storePath);
    try {
        if (!snapshot.rowCount&&!options.allowEmpty) { throw new Error('Локальный индекс пуст. Серверная база не изменена; выполните полную индексацию в OpenCode.'); }
        const indexProfile = await assertVerifiedIndex(located, snapshot.dimension);
        const assertCurrent = async () => {
            await authorize();
            const current = (await resolveIdentity()).value;
            if (!verifiedRagProjectIdentity(current, projectKey, initial.value)) { throw new Error('Привязка локального экземпляра изменилась. Передача остановлена.'); }
            await assertStore();
            if (await assertIndexIdle(storePath) !== health) { throw new Error('Состояние индекса изменилось. Дождитесь индексации и повторите передачу.'); }
            await snapshot.assertCurrent();
            const currentLocated = await locateStore(input.project, cwd);
            assertSameProfile(indexProfile, await assertVerifiedIndex(currentLocated, snapshot.dimension));
        };
        const fingerprints: Record<string, string> = Object.create(null) as Record<string, string>;
        for await (const source of snapshot.rows(input.scanLimit)) {
            const row = await exportRow(source, located.root);
            if (!row.embedding || row.embedding.length !== indexProfile.dimension || row.embedding.some(value => !Number.isFinite(value))) { throw new Error('В индексе есть неполные векторы. Завершите успешную полную индексацию перед передачей.'); }
            if (Object.hasOwn(fingerprints, row.id)) { throw new Error('В локальном индексе повторяются идентификаторы. Выполните полную индексацию.'); }
            fingerprints[row.id] = rowFingerprint(row);
        }
        await assertCurrent();
        const response = await authorizedFetch(`/api/rag/manifest?projectKey=${encodeURIComponent(projectKey)}`);
        if (!response.ok) { throw new Error(`Не удалось прочитать серверную базу (HTTP ${response.status}).`); }
        const parsed = manifestSchema.safeParse(await response.json());
        if (!parsed.success) { throw new Error('Сервер не поддерживает формат поколений RAG. Обновите сервер перед синхронизацией.'); }
        const baseline = parsed.data;
        await assertCurrent();
        const serverProfile = normalizeIndexProfile(baseline.indexProfile);
        assertSameProfile(indexProfile,normalizeIndexProfile(baseline.selectedProfile));
        if(serverProfile||baseline.rowCount>0)assertSameProfile(indexProfile,serverProfile);
        const added = Object.keys(fingerprints).filter(id => baseline.fingerprints[id] !== fingerprints[id]);
        const scanComplete = Object.keys(fingerprints).length === snapshot.rowCount;
        const removed = scanComplete ? Object.keys(baseline.ids).filter(id => !Object.hasOwn(fingerprints, id)) : [];
        const total = added.length + removed.length;
        const common = { projectKey, fingerprintVersion: FINGERPRINT_VERSION, indexProfile, localCount: snapshot.rowCount, dimension: snapshot.dimension };
        if (!scanComplete || input.dryRun || (!input.limit && total > (input.maxRows ?? AUTO_APPLY_LIMIT))) {
            return JSON.stringify({ ...common, ok: false, applied: false, complete: false, dryRun: !!input.dryRun, scanComplete,
                addedCount: added.length, removedCount: scanComplete ? removed.length : null, remaining: total,
                note: !scanComplete ? 'Неполное сканирование: запись запрещена.' : 'Предварительный просмотр; задайте limit для передачи порциями.' });
        }
        const snapshotHash = indexSnapshotHash(indexProfile, fingerprints);
        const restored = JSON.parse(health) as { complete?: unknown; snapshotHash?: unknown };
        if (restored.complete === true && restored.snapshotHash !== snapshotHash) { throw new Error('Восстановленный индекс изменён без полного прохода OpenCodeRAG. Выполните индексацию перед передачей.'); }
        const selected = added.slice(0, input.limit ?? added.length);
        const toRemove = removed.slice(0, input.limit == null ? removed.length : Math.max(0, input.limit - selected.length));
        // Validate every selected ID before the first POST, including before any deletion.
        const rows: ICanonicalRagRow[] = [];
        for (let offset = 0; offset < selected.length; offset += BATCH) {
            for (const source of await snapshot.selected(selected.slice(offset, offset + BATCH))) {
                const row = await exportRow(source, located.root);
                if (rowFingerprint(row) !== fingerprints[row.id]) { throw new Error('Фрагмент не соответствует зафиксированному снимку. Передача остановлена.'); }
                rows.push(row);
            }
        }
        let dataRevision=baseline.dataRevision;
        const post = async (chunks: ICanonicalRagRow[], deletes: string[], complete = false) => {
            await assertCurrent();
            const payload={projectKey,fingerprintVersion:FINGERPRINT_VERSION,indexProfile,
                expectedGeneration:baseline.generation,expectedSelectionRevision:baseline.selectionRevision,expectedDataRevision:dataRevision,
                snapshot:{hash:snapshotHash,rowCount:snapshot.rowCount,complete},chunks:chunks.map(row=>({...row,contentHash:contentHash(row.content)})),deletes};
            const result = await authorizedFetch('/api/rag/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
                ...payload,requestKey:ragRequestHash(payload),
            }) });
            if (!result.ok) {
                let message = 'Подтверждённые порции сохранены; повторите синхронизацию.';
                try {
                    const body = await result.json() as { code?: unknown; message?: unknown };
                    if (body.code === 'RAG_QUOTA_EXCEEDED' && typeof body.message === 'string' && body.message.length <= 2048) { message = body.message; }
                } catch { /* Ответы прокси и внутренние детали не показываются. */ }
                throw new Error(`Передача остановлена (HTTP ${result.status}). ${message}`);
            }
            const receipt = await result.json() as { upserted?: number; deleted?: number; complete?: boolean; snapshotHash?: string;generation?:string;selectionRevision?:number;dataRevision?:number };
            if(receipt.generation!==baseline.generation||receipt.selectionRevision!==baseline.selectionRevision||receipt.dataRevision!==dataRevision+1){throw new Error('Сервер не подтвердил ревизию записанного пакета. Повторите чтение снимка.');}
            dataRevision=receipt.dataRevision;
            if (chunks.length && receipt.upserted !== chunks.length) { throw new Error('Сервер подтвердил не все отправленные фрагменты. Снимок не завершён.'); }
            if (complete && (receipt.complete !== true || receipt.snapshotHash !== snapshotHash)) { throw new Error('Сервер не подтвердил целостность полного снимка. Повторите синхронизацию.'); }
            return receipt;
        };
        let upserted = 0; let deleted = 0;
        try {
            for (let offset = 0; offset < rows.length; offset += BATCH) { upserted += (await post(rows.slice(offset, offset + BATCH), [])).upserted ?? 0; }
        } catch (error) {
            if (upserted > 0) { throw new Error(`${error instanceof Error ? error.message : 'Передача остановлена.'} Ранее подтверждено фрагментов: ${upserted}.`, { cause: error }); }
            throw error;
        }
        for (let offset = 0; offset < toRemove.length; offset += BATCH) { deleted += (await post([], toRemove.slice(offset, offset + BATCH))).deleted ?? 0; }
        const remaining = total - selected.length - toRemove.length;
        await assertCurrent();
        if (remaining === 0) { await post([], [], true); }
        return JSON.stringify({ ...common, ok: true, applied: true, complete: remaining === 0, scanComplete: true,
            snapshotHash, upserted, deleted, appliedNow: upserted + deleted, remaining, added: added.length, removed: removed.length });
    } finally { snapshot.close(); }
}
