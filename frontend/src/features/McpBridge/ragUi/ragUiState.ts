import type { IBridgeDevice, IBridgeInstallation, IBridgeJob, IBridgeJobInput } from '../api';
import type { IBridgeBinding } from '../operationTypes';
import { hasCurrentBinding, isPending } from '../installationHelpers';
import { bridgeOperationBlocker } from '../readiness';

export type IRagUiInstallation = IBridgeInstallation & { assetKind: 'mcp' | 'plugin'; ragUi: { supported: true; mode: 'web' } };
export type IRagUiRequest = Extract<IBridgeJobInput, { kind: 'open-rag-ui' }>;
export type IRagUiDraft = Omit<IRagUiRequest, 'requestKey'>;
const sha = (value?: string): boolean => /^[a-f0-9]{64}$/.test(value ?? '');
const uuid = (value?: string): boolean => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value ?? '');

/** Поддержка определяется серверным признаком закреплённого пакета, а не названием карточки. */
export function ragUiInstallations(items: IBridgeInstallation[], device: IBridgeDevice | undefined, projectId: string, bindingId?: string): IRagUiInstallation[] {
    return items.filter((item): item is IRagUiInstallation => (item.assetKind === 'mcp' || item.assetKind === 'plugin')
        && item.ragUi?.supported === true && item.ragUi.mode === 'web' && hasCurrentBinding(item, device)
        && item.projectId === projectId && item.bindingId === bindingId && sha(item.manifest)
        && Number.isSafeInteger(item.version) && item.version > 0);
}

export function ragUiInstallationKey(item: IBridgeInstallation): string {
    return JSON.stringify([item.deviceId, item.projectId, item.bindingId, item.assetKind, item.assetId, item.version, item.manifest]);
}

export function ragUiJobMatches(job: IBridgeJob, item: IBridgeInstallation, instanceId?: string): boolean {
    return job.kind === 'open-rag-ui' && job.deviceId === item.deviceId && job.projectId === item.projectId
        && job.bindingId === item.bindingId && job.assetId === item.assetId && job.assetKind === item.assetKind
        && Number(job.version) === item.version && job.expectedManifest === item.manifest
        && !!instanceId && job.expectedInstanceId === instanceId;
}

/** История прежней папки, версии или SHA не подтверждает открытие текущего интерфейса. */
export function latestRagUiJob(jobs: IBridgeJob[], item?: IBridgeInstallation, instanceId?: string, submitted?: IBridgeJob): IBridgeJob | undefined {
    if (!item) return undefined;
    const matching = new Map<string, IBridgeJob>();
    for (const job of [...jobs, ...(submitted ? [submitted] : [])].filter(job => ragUiJobMatches(job, item, instanceId))) {
        const previous = matching.get(job.id);
        if (!previous || Date.parse(job.updatedAt) > Date.parse(previous.updatedAt)
            || job.updatedAt === previous.updatedAt && isPending(previous) && !isPending(job)) matching.set(job.id, job);
    }
    return [...matching.values()].sort((first, second) => Number(isPending(second)) - Number(isPending(first))
        || Date.parse(second.createdAt) - Date.parse(first.createdAt))[0];
}

interface IReadiness {
    device?: IBridgeDevice; projectId: string; binding?: IBridgeBinding; installation?: IRagUiInstallation;
    choiceCount?: number;
    devicesReady: boolean; jobsReady: boolean; installationsReady: boolean; canWrite: boolean; jobs: IBridgeJob[];
}
export function ragUiBlocker(input: IReadiness): string {
    if (!input.canWrite) return 'Открыть локальный интерфейс может разработчик или администратор проекта.';
    if (!input.devicesReady) return 'Дождитесь актуальной проверки подключения моста или обновите данные.';
    const common = bridgeOperationBlocker(input.device);
    if (common) return common;
    if (!input.device?.online) return 'Включите выбранный компьютер и дождитесь подключения моста.';
    if (!input.device.report.capabilities?.includes('opencode-rag-ui-v1')) return 'Обновите мост до версии 0.9.5 или новее для открытия интерфейса OpenCodeRAG.';
    if (!input.binding || !sha(input.binding.bindingId) || !uuid(input.binding.instanceId)) return 'Сначала выберите и подтвердите папку этого проекта на выбранном компьютере.';
    if (!input.jobsReady || !input.installationsReady) return 'Дождитесь загрузки установок и очереди моста или обновите данные.';
    if (!input.installation && Number(input.choiceCount) > 1) return 'Выберите установленный пакет OpenCodeRAG для этой папки.';
    if (!input.installation || !ragUiInstallations([input.installation], input.device, input.projectId, input.binding.bindingId).length) {
        return 'Установите или обновите OpenCodeRAG через каталог и выберите поддерживаемую установку.';
    }
    if (input.jobs.some(job => isPending(job) && job.deviceId === input.device!.id
        && (job.kind === 'choose-root' || job.projectId === input.projectId
            && (['prepare-bind-project', 'bind-project'].includes(job.kind) || job.bindingId === input.binding!.bindingId)))) {
        return 'Дождитесь завершения текущего действия с этой папкой проекта.';
    }
    return '';
}

export function ragUiRequest(item: IRagUiInstallation, binding: IBridgeBinding): IRagUiDraft {
    if (!sha(binding.bindingId) || !uuid(binding.instanceId) || item.bindingId !== binding.bindingId || item.projectId !== binding.projectId) {
        throw new Error('Папка проекта изменилась. Обновите данные моста.');
    }
    return { kind: 'open-rag-ui', deviceId: item.deviceId, projectId: item.projectId, assetId: item.assetId,
        assetKind: item.assetKind, version: item.version, expectedManifest: item.manifest,
        expectedBindingId: binding.bindingId!, expectedInstanceId: binding.instanceId! };
}

export function ragUiOutcome(job: IBridgeJob): { opened: true; reused: boolean; note: string } | undefined {
    const result = job.result;
    return job.state === 'succeeded' && result?.opened === true && typeof result.reused === 'boolean' && typeof result.note === 'string'
        && result.note.trim().length > 0 && result.note.length <= 2000 && Object.keys(result).every(key => ['opened', 'reused', 'note'].includes(key))
        ? { opened: true, reused: result.reused, note: result.note } : undefined;
}
