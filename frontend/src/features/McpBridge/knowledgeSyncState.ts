import type { IBridgeDevice, IBridgeJob } from './api';
import { bridgeOperationBlocker } from './readiness';

/** RAG требует отдельного контракта профиля и привязки, независимо от обычной установки инструментов. */
export function knowledgeSyncBlocker(device?: IBridgeDevice): string {
    const common = bridgeOperationBlocker(device);
    if (common) { return common; }
    if (!device?.report.capabilities?.includes('project-rag-sync-v1')) {
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
