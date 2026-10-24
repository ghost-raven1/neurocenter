import type { IBridgeDevice, IBridgeInstallation, IBridgeJob, IBridgeJobDraft } from '../McpBridge/api';
import type { IBridgeBinding } from '../McpBridge/operationTypes';
import { hasCurrentBinding, isPending } from '../McpBridge/installationHelpers';
import { latestInstallationReport, runtimeFileBlocker, sameInstallation, uuid } from '../McpBridge/operationHelpers';
import { bridgeOperationBlocker } from '../McpBridge/readiness';
import { sameEmbeddingProfile, sha, type IProjectEmbedding } from './model';
import type { IReindexConnectionTarget } from './reindex';

export type IEmbeddingConnectionInput = Extract<IBridgeJobDraft, { kind: 'connect-rag-model' }>;
/** Поддержка подтверждается закреплённым пакетом и сверенными файлами, а не названием инструмента. */
export function embeddingInstallations(items: IBridgeInstallation[], device: IBridgeDevice | undefined, projectId: string, jobs: IBridgeJob[]): IBridgeInstallation[] {
    return items.filter(item => item.projectId === projectId && hasCurrentBinding(item, device)
        && ['mcp', 'plugin'].includes(item.assetKind) && item.hostedEmbedding?.supported === true && sha(item.manifest)
        && Number.isSafeInteger(item.version) && item.version > 0 && !runtimeFileBlocker(latestInstallationReport(item, jobs)));
}
/** Ожидание точной сверки не делает файлы, модель или индекс готовыми и не меняет выбранный пакет. */
export function pendingEmbeddingInspection(items: IBridgeInstallation[], device: IBridgeDevice | undefined, projectId: string, jobs: IBridgeJob[], selected?: IBridgeInstallation): IBridgeJob | undefined {
    return jobs.find(job => job.kind === 'inspect-installation' && isPending(job) && items.some(item => item.projectId === projectId && hasCurrentBinding(item, device)
        && ['mcp', 'plugin'].includes(item.assetKind) && item.hostedEmbedding?.supported === true && item.hostedEmbedding.reindexSupported === true
        && sha(item.manifest) && Number.isSafeInteger(item.version) && item.version > 0 && !!runtimeFileBlocker(latestInstallationReport(item, jobs))
        && sameInstallation(job, item) && job.version === String(item.version) && job.expectedManifest === item.manifest
        && (!selected || sameInstallation(job, selected) && selected.version === item.version && selected.manifest === item.manifest)));
}
export function embeddingConnectionBlocker(device: IBridgeDevice | undefined, binding: IBridgeBinding | undefined): string {
    const common = bridgeOperationBlocker(device); if (common) return common;
    if (!device?.online) return 'Включите компьютер и обновите данные моста.';
    if (!device.report.capabilities?.includes('hosted-rag-reindex-v1')||!device.report.capabilities?.includes('hosted-rag-grants-v1')||!device.report.capabilities?.includes('hosted-rag-profile-values-v1')) return 'Обновите мост для подключения модели проекта к OpenCodeRAG.';
    if (!device.report.root?.trim()) return 'Выберите общую папку проектов на выбранном компьютере.';
    if (!binding || !sha(binding.bindingId) || !uuid(binding.instanceId)) return 'Свяжите и подтвердите папку этого проекта на выбранном компьютере.';
    return '';
}
export function embeddingConnectionInput(item: IBridgeInstallation, binding: IBridgeBinding, selection: IProjectEmbedding): IEmbeddingConnectionInput {
    if (!selection.profile || !sha(selection.modelPin) || selection.revision < 1 || !sha(binding.bindingId) || !uuid(binding.instanceId)
        || item.projectId !== selection.projectId || item.bindingId !== binding.bindingId || !['mcp', 'plugin'].includes(item.assetKind)) throw new Error('Подключение изменилось. Обновите сведения.');
    return {kind: 'connect-rag-model', deviceId: item.deviceId, projectId: item.projectId, assetId: item.assetId,
        assetKind: item.assetKind as 'mcp' | 'plugin', version: item.version, expectedManifest: item.manifest,
        expectedBindingId: binding.bindingId, expectedInstanceId: binding.instanceId,
        expectedEmbeddingRevision: selection.revision, expectedEmbeddingPin: selection.modelPin,reindex:true};
}
export function embeddingConnected(job: IBridgeJob | undefined, selection: IProjectEmbedding): boolean {
    const result = job?.result;
    const rebuilt=result?.reindex as {complete?:unknown;serverSynced?:unknown;rowCount?:unknown;snapshotHash?:unknown}|undefined;
    return rebuilt?.complete===true&&rebuilt.serverSynced===true&&Number.isSafeInteger(rebuilt.rowCount)&&Number(rebuilt.rowCount)>=0&&sha(rebuilt.snapshotHash)&&job?.state === 'succeeded' && result?.status === 'connected' && result.revision === selection.revision
        && result.modelPin === selection.modelPin && result.requiresRestart === true && !!selection.profile
        && !!result.profile && typeof result.profile === 'object'
        && sameEmbeddingProfile(result.profile as NonNullable<IProjectEmbedding['profile']>, selection.profile);
}
/** Успех соседнего компьютера, версии пакета или экземпляра папки не закрывает нужное подключение. */
export function embeddingTargetConnected(jobs: IBridgeJob[], selection: IProjectEmbedding, target: IReindexConnectionTarget): boolean {
    return jobs.some(job => job.kind === 'connect-rag-model' && job.projectId === selection.projectId && job.deviceId === target.deviceId
        && job.assetId === target.assetId && job.assetKind === target.assetKind && Number(job.version) === target.version
        && job.expectedManifest === target.expectedManifest && job.bindingId === target.expectedBindingId
        && job.expectedInstanceId === target.expectedInstanceId && embeddingConnected(job, selection));
}
export function pendingEmbeddingAction(jobs: IBridgeJob[], deviceId: string, projectId: string, bindingId?: string): boolean {
    return jobs.some(job => isPending(job) && job.deviceId === deviceId && (job.kind === 'choose-root'
        || job.projectId === projectId && (['prepare-bind-project', 'bind-project'].includes(job.kind) || job.bindingId === bindingId)));
}
