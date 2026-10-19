import path from 'node:path';
import { restoreRagDb } from '../tools/restore-rag-db.js';
import { syncRagDb } from '../tools/sync-rag-db.js';
import { locateStore } from '../lib/store.js';
import { projectFolder, safeTarget } from './workspace.js';

interface RagJob { kind: 'sync-rag' | 'restore-rag'; projectId: string; bindingId: string; }
type Result = Record<string, unknown>;
const SLICE_ROWS = 500;
const counts = ['upserted','deleted','appliedNow','added','removed','dimension','localCount','written','sourceCount'];

/** Промежуточный пакет не становится готовой базой знаний, даже если транспорт вернул ok. */
function checkedResult(raw: string, job: RagJob): Result {
    const result = JSON.parse(raw) as Result;
    if (!result || result.ok !== true || result.applied !== true || result.dryRun || result.preview || result.projectKey !== job.projectId) {
        throw new Error(typeof result?.message === 'string' ? result.message : typeof result?.error === 'string'
            ? result.error : 'Индекс не готов к синхронизации. Проверьте модель и дождитесь завершения индексации.');
    }
    if (result.fingerprintVersion !== 1 || typeof result.snapshotHash !== 'string' || !/^[a-f0-9]{64}$/.test(result.snapshotHash)
        || !Number.isSafeInteger(result.remaining) || Number(result.remaining)<0 || typeof result.complete !== 'boolean'
        || counts.some(key=>result[key]!==undefined && (!Number.isSafeInteger(result[key]) || Number(result[key])<0))) {
        throw new Error('Мост не подтвердил профиль и состояние полного индекса. Повторите синхронизацию после обновления.');
    }
    const profile = result.indexProfile as {provider?:unknown;model?:unknown;dimension?:unknown}|undefined;
    if (!profile || Object.keys(profile).length!==3 || typeof profile.provider !== 'string' || !profile.provider || typeof profile.model !== 'string' || !profile.model
        || !Number.isSafeInteger(profile.dimension) || Number(profile.dimension)<=0 || result.dimension !== profile.dimension) {
        throw new Error('Профиль модели не подтверждён. Проверьте настройки эмбеддингов и локальный индекс.');
    }
    return result;
}

/** Задание моста применяет короткие порции, сохраняя обычный ручной лимит MCP неизменным. */
export async function runRagBridgeJob(job: RagJob, authorize: () => Promise<void>, update: (percent:number,message:string)=>Promise<unknown>): Promise<Result> {
    await authorize();
    const folder = await projectFolder(job.projectId);
    const located = await locateStore(folder,folder,job.kind==='restore-rag');
    const store = located.storePath || path.join(folder,'.opencode/rag_db');
    const relative = path.relative(folder,store).split(path.sep).join('/');
    if (relative.startsWith('../') || path.isAbsolute(relative) || !relative) { throw new Error('LanceDB должна находиться внутри привязанной папки проекта.'); }
    await safeTarget(folder,relative);
    if (job.kind==='restore-rag') {
        await authorize();
        const restored = checkedResult(await restoreRagDb({projectKey:job.projectId,project:folder},folder,authorize),job);
        await authorize();
        if (restored.complete!==true || restored.remaining!==0 || !Number.isSafeInteger(restored.written) || Number(restored.written)<=0) { throw new Error('Восстановление не подтвердило полный непустой индекс.'); }
        return publicResult(restored,job);
    }
    let previousRemaining = Infinity;
    let snapshotHash: unknown;
    let profile: string | undefined;
    let upserted = 0, deleted = 0, batches = 0;
    while (true) {
        await authorize();
        const result = checkedResult(await syncRagDb({projectKey:job.projectId,project:folder,limit:SLICE_ROWS},folder,authorize),job);
        await authorize();
        const remaining = Number(result.remaining), appliedNow = Number(result.appliedNow);
        const currentProfile = JSON.stringify(Object.entries(result.indexProfile as Result).sort(([a],[b])=>a.localeCompare(b)));
        if (snapshotHash!==undefined && (snapshotHash!==result.snapshotHash || profile!==currentProfile)) {
            throw new Error('Локальный индекс изменился между пакетами. Дождитесь завершения индексации и повторите синхронизацию.');
        }
        snapshotHash = result.snapshotHash; profile = currentProfile;
        if (!Number.isSafeInteger(appliedNow) || appliedNow<0 || appliedNow>SLICE_ROWS || !Number.isSafeInteger(result.localCount) || Number(result.localCount)<=0
            || remaining>0 && (appliedNow===0 || remaining>=previousRemaining) || result.complete!==(remaining===0)) {
            throw new Error('Синхронизация не подтвердила продвижение до полного индекса. Повторите после проверки модели и индексации.');
        }
        upserted += Number(result.upserted || 0); deleted += Number(result.deleted || 0); batches++;
        await update(remaining===0 ? 99 : Math.min(95,Math.floor((upserted+deleted)*95/(upserted+deleted+remaining))),
            remaining===0 ? 'Полный индекс проверен, сохраняем результат.' : `Передано изменений: ${upserted+deleted}. Осталось: ${remaining}.`);
        if (remaining===0) { return {...publicResult(result,job),upserted,deleted,appliedNow:upserted+deleted,batches}; }
        previousRemaining = remaining;
    }
}

/** Абсолютные пути и внутренние сообщения клиента остаются на компьютере. */
function publicResult(result: Result, job: RagJob): Result {
    const allowed = ['ok','applied','complete','remaining','fingerprintVersion','indexProfile','snapshotHash','created',...counts];
    return {projectId:job.projectId,bindingId:job.bindingId,...Object.fromEntries(Object.entries(result).filter(([key])=>allowed.includes(key)))};
}
