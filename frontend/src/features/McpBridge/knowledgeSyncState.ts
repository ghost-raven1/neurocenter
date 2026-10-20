import type { IBridgeDevice, IBridgeJob } from './api';
import { bridgeOperationBlocker } from './readiness';
import { isPending } from './installationHelpers';

export type KnowledgeJobKind = 'restore-rag' | 'sync-rag';

/** RAG требует отдельного контракта профиля и привязки, независимо от обычной установки инструментов. */
export function knowledgeSyncBlocker(device?: IBridgeDevice): string {
    const common = bridgeOperationBlocker(device);
    if (common) { return common; }
    if (!device?.report.capabilities?.includes('project-rag-generations-v1')) {
        return 'Обновите мост для проверки профиля индекса и безопасной синхронизации знаний.';
    }
    return device.report.ragSupported === false ? device.report.ragError || 'Локальная LanceDB недоступна на этом компьютере.' : '';
}

/** История прежней папки не выдаётся за результат работы с текущим экземпляром. */
export function currentKnowledgeJobs(jobs: IBridgeJob[], deviceId: string | undefined, projectId: string, bindingId: string | undefined): IBridgeJob[] {
    if (!deviceId || !bindingId) { return []; }
    return jobs.filter(job => job.deviceId === deviceId && job.projectId === projectId && job.bindingId === bindingId
        && ['restore-rag','sync-rag'].includes(job.kind));
}

/** Принятый queued ACK остаётся барьером, пока очередь не вернула его точный итог. */
export function currentKnowledgeJob(jobs: IBridgeJob[], deviceId: string | undefined, projectId: string, bindingId: string | undefined,
    accepted: IBridgeJob | undefined, jobsReady: boolean): IBridgeJob | undefined {
    const matching = currentKnowledgeJobs(jobs, deviceId, projectId, bindingId);
    const local = accepted && currentKnowledgeJobs([accepted], deviceId, projectId, bindingId)[0];
    const tracked = local && (jobsReady ? matching.find(item => item.id === local.id) : undefined) || local;
    return matching.find(isPending) || tracked || matching[0];
}

/** Повреждённый или чужой ACK не завершает неопределённый запрос. */
export function validKnowledgeAck(job: IBridgeJob, deviceId: string, projectId: string, bindingId: string, kind: KnowledgeJobKind): boolean {
    return !!job && typeof job.id === 'string' && !!job.id && job.kind === kind
        && ['queued', 'running', 'reconciling', 'succeeded', 'failed', 'cancelled'].includes(job.state)
        && currentKnowledgeJobs([job], deviceId, projectId, bindingId).length === 1;
}
