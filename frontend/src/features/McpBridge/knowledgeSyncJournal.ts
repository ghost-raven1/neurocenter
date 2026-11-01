import { browserCliJournalLock } from '../ComputerSetup/journalLock';
import { cliRequestFingerprint } from '../ComputerSetup/hooks/receipt';
import { createBridgeRequestKey } from './bridgeRequestKey';
import { bridgeApi, type IBridgeJob } from './api';
import { validKnowledgeAck, type TKnowledgeJobKind } from './knowledgeSyncState';
import { isPending } from './installationHelpers';

interface IKnowledgeIntent {
    version: 1;
    role: string;
    request: {
        deviceId: string;
        projectId: string;
        expectedBindingId: string;
        kind: TKnowledgeJobKind;
        requestKey: string;
    };
}

/** Safe identities only; an unreadable journal never becomes permission to enqueue another job. */
export function knowledgeSyncJournal(
    owner: string,
    role: string,
    deviceId: string,
    projectId: string,
    bindingId: string,
) {
    const key =
        'neurocenter:knowledge-sync:v1:' + encodeURIComponent(JSON.stringify([owner, projectId, deviceId, bindingId]));
    const read = (): IKnowledgeIntent | undefined => {
        const raw = localStorage.getItem(key);
        if (raw === null) return undefined;
        if (raw.length > 4096) throw Error('Журнал синхронизации повреждён. Новый запуск приостановлен.');
        const value = JSON.parse(raw) as IKnowledgeIntent;
        if (
            !value ||
            Object.keys(value).sort().join(',') !== 'request,role,version' ||
            !value.request ||
            Object.keys(value.request).sort().join(',') !== 'deviceId,expectedBindingId,kind,projectId,requestKey' ||
            value.version !== 1 ||
            value.role !== role ||
            value.request?.deviceId !== deviceId ||
            value.request.projectId !== projectId ||
            value.request.expectedBindingId !== bindingId ||
            !['sync-rag', 'restore-rag'].includes(value.request.kind) ||
            !/^[a-f0-9-]{36}$/.test(value.request.requestKey)
        )
            throw Error('Журнал синхронизации повреждён. Исходная отправка сохранена; новый запуск приостановлен.');
        return value;
    };
    const lock = async <T>(change: () => T): Promise<T> => {
        const locked = browserCliJournalLock();
        if (!owner || !locked)
            throw Error(
                'Не удалось безопасно открыть журнал синхронизации. Используйте HTTPS или localhost и повторите.',
            );
        return locked(key, change);
    };
    const settle = async (intent: IKnowledgeIntent, job: IBridgeJob, current: () => boolean) => {
        if (!current() || isPending(job)) return;
        await lock(() => {
            if (current() && read()?.request.requestKey === intent.request.requestKey) localStorage.removeItem(key);
        });
    };
    const receipt = async (intent: IKnowledgeIntent, current: () => boolean) => {
        const value = await bridgeApi.request(intent.request.requestKey);
        if (
            value.requestKey !== intent.request.requestKey ||
            value.requestFingerprint !== (await cliRequestFingerprint(intent)) ||
            !validKnowledgeAck(value.job, deviceId, projectId, bindingId, intent.request.kind)
        )
            throw Error('Квитанция не подтверждает исходную синхронизацию. Ключ сохранён; повтор приостановлен.');
        await settle(intent, value.job, current);
        return value.job;
    };
    return {
        async recover(current: () => boolean): Promise<IBridgeJob | undefined> {
            const intent = read();
            if (!intent) return undefined;
            try {
                return await receipt(intent, current);
            } catch (error) {
                if ((error as { response?: { status?: number } })?.response?.status === 404) return undefined;
                throw error;
            }
        },
        async submit(kind: TKnowledgeJobKind, current: () => boolean): Promise<IBridgeJob | undefined> {
            const intent = await lock(() => {
                if (!current()) return undefined;
                const previous = read();
                if (previous) return { value: previous, existing: true };
                const value: IKnowledgeIntent = {
                    version: 1,
                    role,
                    request: {
                        deviceId,
                        projectId,
                        expectedBindingId: bindingId,
                        kind,
                        requestKey: createBridgeRequestKey(),
                    },
                };
                const raw = JSON.stringify(value);
                localStorage.setItem(key, raw);
                if (localStorage.getItem(key) !== raw)
                    throw Error('Не удалось сохранить ключ синхронизации. Задание не отправлено.');
                return { value, existing: false };
            });
            if (!intent || !current()) return undefined;
            if (intent.existing) {
                try {
                    return await receipt(intent.value, current);
                } catch (error) {
                    if ((error as { response?: { status?: number } })?.response?.status !== 404) throw error;
                }
            }
            if (!current()) return undefined;
            if (intent.value.request.kind !== kind)
                throw Error('Сначала повторите исходное направление синхронизации: его подтверждение ещё не получено.');
            const job = await bridgeApi.create(intent.value.request);
            if (!validKnowledgeAck(job, deviceId, projectId, bindingId, kind))
                throw Error('Неполное подтверждение задания. Исходный ключ сохранён.');
            await settle(intent.value, job, current);
            return job;
        },
    };
}
