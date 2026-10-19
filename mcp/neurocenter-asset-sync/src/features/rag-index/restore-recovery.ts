import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { atomicText, syncDirectory } from '../../bridge/atomic-file.js';
import { saveCompletion } from '../../bridge/completions.js';
import { recoveryDirectory } from '../../bridge/installation-space.js';
import { readBoundedUtf8 } from '../../bridge/read-bounded.js';
import { hash, jobContext, stateDir } from '../../bridge/state.js';
import { withWorkspaceIdentityLock } from '../../bridge/workspace-identity-state.js';
import { safeTarget } from '../../bridge/workspace-paths.js';
import { readRagProjectIdentity, verifiedRagProjectIdentity, type IRagProjectIdentity } from '../../lib/rag-project-identity.js';
import { matchesRestoreProof, restoreDirectoryProof, type RestoreDirectoryProof } from './restore-proof.js';

const directory = () => path.join(stateDir(), 'rag-restores');
const journalPath = (root: string) => path.join(directory(), hash(root) + '.json');
const inFlight = new Set<string>();
const proofSchema = z.object({ physical: z.string().regex(/^\d+:\d+:\d+$/), entries: z.record(z.string().min(1).max(1024)) }).strict();
const identitySchema = z.object({ projectKey: z.string().min(1).max(128), instanceId: z.string().uuid(), bindingId: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const resultSchema = z.object({ ok: z.literal(true), applied: z.literal(true), complete: z.literal(true), remaining: z.literal(0),
    fingerprintVersion: z.literal(1), snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
    indexProfile: z.object({ provider: z.string().min(1).max(512), model: z.string().min(1).max(512), dimension: z.number().int().positive() }).strict(),
    written: z.number().int().positive(), sourceCount: z.number().int().positive(), dimension: z.number().int().positive() }).strict();
const schema = z.object({ version: z.literal(1), pid: z.number().int().positive(), state: z.enum(['prepared', 'committed']),
    root: z.string(), store: z.string(), stage: z.string(), backup: z.string(), lock: z.string().max(1024),
    identity: identitySchema, before: proofSchema, after: proofSchema, result: resultSchema,
    job: z.object({ id: z.string().uuid(), lease: z.string().uuid(), deviceId: z.string().uuid().optional() }).strict().optional(),
}).strict();
type RestoreIntent = z.infer<typeof schema>;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };
const uncertain = (cause: unknown) => Object.assign(new Error('Восстановление индекса требует завершения локального журнала. Файлы сохранены; повторите действие после перезапуска моста.'),
    { localChangesCommitted: true, restoreRecoveryPending: true, cause });

async function readIntent(root: string): Promise<RestoreIntent | undefined> {
    try {
        await recoveryDirectory(directory(), false);
        return schema.parse(JSON.parse(await readBoundedUtf8(journalPath(root), 16 * 1024 * 1024)));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw error; }
}

async function assertIntent(intent: RestoreIntent, root: string): Promise<void> {
    if (intent.root !== root || path.resolve(root) !== root || path.dirname(intent.stage) !== path.dirname(intent.store)
        || !/^\.neurocenter-rag-restore-[A-Za-z0-9]{6}$/.test(path.basename(intent.stage)) || intent.backup !== intent.stage + '-previous'
        || new Set([intent.store, intent.stage, intent.backup]).size !== 3) { throw new Error('Повреждены пути журнала восстановления индекса.'); }
    for (const target of [intent.store, intent.stage, intent.backup]) {
        const relative = path.relative(root, target).split(path.sep).join('/');
        if (await safeTarget(root, relative) !== target) { throw new Error('Путь восстановления индекса изменился.'); }
    }
    for (const proof of [intent.before, intent.after]) {
        if (Object.keys(proof.entries).some(relative => !relative || path.posix.isAbsolute(relative) || relative.includes('\\')
            || relative.split('/').some(part => !part || part === '.' || part === '..'))) { throw new Error('Повреждён снимок файлов восстановления.'); }
    }
    const identity = (await readRagProjectIdentity({ project: root }, root)).value;
    if (!verifiedRagProjectIdentity(identity, intent.identity.projectKey, { ...intent.identity, ok: true })) {
        throw new Error('Привязка папки изменилась. Автоматическое восстановление индекса остановлено.');
    }
    if (intent.result.written !== intent.result.sourceCount || intent.result.dimension !== intent.result.indexProfile.dimension) {
        throw new Error('Повреждён результат восстановления индекса.');
    }
}

async function finish(intent: RestoreIntent): Promise<void> {
    await assertIntent(intent, intent.root);
    const proof = (target: string) => restoreDirectoryProof(target, intent.lock);
    const remove = async (target: string, expected: RestoreDirectoryProof) => {
        const current = await proof(target);
        if (!current) { return; }
        if (!matchesRestoreProof(current, expected, true)) { throw new Error('Файлы резервной папки изменились. Автоматическая очистка остановлена.'); }
        await fs.rm(target, { recursive: true }); await syncDirectory(path.dirname(target));
    };
    let store = await proof(intent.store), stage = await proof(intent.stage), backup = await proof(intent.backup);
    if (intent.state === 'prepared') {
        if (matchesRestoreProof(store, intent.after) && matchesRestoreProof(backup, intent.before) && !stage) {
            await fs.rename(intent.store, intent.stage); await syncDirectory(path.dirname(intent.store));
            store = undefined; stage = await proof(intent.stage);
        }
        if (!store && matchesRestoreProof(backup, intent.before) && matchesRestoreProof(stage, intent.after)) {
            await fs.rename(intent.backup, intent.store); await syncDirectory(path.dirname(intent.store));
            store = await proof(intent.store); backup = undefined;
        }
        if (!matchesRestoreProof(store, intent.before) || backup) { throw new Error('Положение исходного индекса неоднозначно. Резервные файлы сохранены.'); }
        await remove(intent.stage, intent.after);
    } else {
        if (!matchesRestoreProof(store, intent.after) || stage) { throw new Error('Восстановленный индекс изменился. Резервные файлы сохранены.'); }
        await remove(intent.backup, intent.before);
    }
    const activeLock = path.join(intent.store, 'index.lock');
    try { if (await readBoundedUtf8(activeLock, 1024) === intent.lock) { await fs.unlink(activeLock); await syncDirectory(intent.store); } }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
    if (intent.job) {
        await saveCompletion({ ...intent.job, state: intent.state === 'committed' ? 'succeeded' : 'failed',
            message: intent.state === 'committed' ? 'Семантический индекс восстановлен.' : 'Прерванное восстановление отменено; исходный индекс и настройки сохранены.',
            result: intent.state === 'committed' ? { projectId: intent.identity.projectKey, bindingId: intent.identity.bindingId, ...intent.result } : {} });
    }
    await fs.unlink(journalPath(intent.root)); await syncDirectory(directory());
}

/** Под identity-lock запись intent предшествует обоим rename; prepared откатывается, committed завершает свою очистку. */
export async function commitRagRestore(input: { root: string; store: string; stage: string; lock: string; overrides: string | null; identity: IRagProjectIdentity; result: Record<string, unknown> }): Promise<void> {
    await recoveryDirectory(directory());
    if (await readIntent(input.root)) { throw new Error('Предыдущее восстановление индекса ещё не завершено.'); }
    const before = await restoreDirectoryProof(input.store, input.lock), after = await restoreDirectoryProof(input.stage, input.lock, true);
    if (!before || !after) { throw new Error('Исходная или подготовленная папка индекса отсутствует.'); }
    const overrides = async (target: string) => readBoundedUtf8(path.join(target, 'runtime-overrides.json'), 1024 * 1024)
        .catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') { return null; } throw error; });
    if (await overrides(input.store) !== input.overrides || await overrides(input.stage) !== input.overrides) {
        throw new Error('Настройки индекса изменились перед переключением. Исходный индекс сохранён.');
    }
    const intent = schema.parse({ version: 1, pid: process.pid, state: 'prepared', root: input.root, store: input.store, stage: input.stage,
        backup: input.stage + '-previous', lock: input.lock, identity: { projectKey: input.identity.projectKey, instanceId: input.identity.instanceId, bindingId: input.identity.bindingId },
        before, after, result: Object.fromEntries(Object.keys(resultSchema.shape).map(key => [key, input.result[key]])), job: jobContext.getStore() });
    await assertIntent(intent, input.root);
    const encoded = JSON.stringify(intent);
    if (Buffer.byteLength(encoded) > 16 * 1024 * 1024) { throw new Error('Журнал восстановления индекса превышает 16 МиБ. Исходный индекс сохранён.'); }
    const file = journalPath(input.root), temporary = path.join(directory(), '.' + randomUUID() + '.tmp');
    let published = false;
    inFlight.add(input.root);
    try {
        await atomicText(temporary, encoded, 0o600);
        await fs.link(temporary, file); published = true; await syncDirectory(directory());
        if (!matchesRestoreProof(await restoreDirectoryProof(intent.store, intent.lock), before)
            || !matchesRestoreProof(await restoreDirectoryProof(intent.stage, intent.lock), after)) {
            throw new Error('Индекс изменился перед переключением. Файлы сохранены.');
        }
        await fs.rename(intent.store, intent.backup); await syncDirectory(path.dirname(intent.store));
        await fs.rename(intent.stage, intent.store); await syncDirectory(path.dirname(intent.store));
        intent.state = 'committed'; await atomicText(file, JSON.stringify(intent), 0o600);
        await finish(intent);
    } catch (error) {
        if (published) {
            try { const saved = await readIntent(input.root); if (saved) { await finish(saved); } }
            catch (failure) { throw uncertain(failure); }
        }
        throw error;
    } finally { inFlight.delete(input.root); await fs.rm(temporary, { force: true }); }
}

/** Чтение и повтор сначала восстанавливают только известный intent, не угадывая случайные previous-папки. */
export async function recoverRagRestore(root: string): Promise<void> {
    const intent = await readIntent(root);
    if (!intent) { return; }
    const running = (pid: number) => alive(pid) && (pid !== process.pid || inFlight.has(root));
    if (running(intent.pid)) { throw new Error('Восстановление индекса уже выполняется. Дождитесь завершения.'); }
    await withWorkspaceIdentityLock(async () => {
        const current = await readIntent(root);
        if (!current) { return; }
        if (running(current.pid)) { throw new Error('Восстановление индекса уже выполняется.'); }
        await assertIntent(current, root); await finish(current);
    });
}

/** Worker доставляет прежний итог задания после восстановления файлов, без повторной загрузки снимка. */
export async function recoverRagRestores(): Promise<void> {
    try { await recoveryDirectory(directory(), false); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return; } throw error; }
    for (const name of (await fs.readdir(directory())).filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
        const intent = schema.parse(JSON.parse(await readBoundedUtf8(path.join(directory(), name), 16 * 1024 * 1024)));
        if (path.basename(journalPath(intent.root)) !== name) { throw new Error('Имя журнала восстановления не совпадает с папкой проекта.'); }
        await recoverRagRestore(intent.root);
    }
}
