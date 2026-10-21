import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../common/utils/errorMessage';
import { useAuthRequestOwner } from '../UserBlock/useAuthRequestOwner';
import { agentCatalogApi } from './api';
import { agentConnection } from './model';
import { createAgentRequestKeys } from './requestKeys';
import type { IAgentCatalog, IAgentCatalogProps, IAgentConnectTarget, IAgentProjectPatch, IAgentSaved, ICatalogAgent } from './types';

type TMutation = 'assign' | 'configure' | 'remove';
interface IInput {kind: TMutation; agent: ICatalogAgent; revision: number; patch?: IAgentProjectPatch}
interface IProps extends IAgentCatalogProps {catalog: IAgentCatalog | null; refresh: () => Promise<IAgentCatalog | null>}

export function useAgentActions(props: IProps) {
    const { scope, captureOwner } = useAuthRequestOwner();
    const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [unconfirmed, setUnconfirmed] = useState(false);
    const lock = useRef(false), keys = useRef(createAgentRequestKeys()), retry = useRef<() => Promise<unknown>>();
    const context = JSON.stringify([scope, props.projectId]), current = useRef(context); current.current = context;
    const latest = useRef(props); latest.current = props;
    useEffect(() => { keys.current.clear(); lock.current = false; retry.current = undefined; setBusy(false); setError(''); setNotice(''); setUnconfirmed(false); }, [context]);
    const owner = (): (() => boolean) => { const owns = captureOwner(); return () => owns() && current.current === context; };
    const connect = async (revision: number, owns: () => boolean, requested?: IAgentConnectTarget | null): Promise<void> => {
        const selected = latest.current;
        const connection = agentConnection(selected);
        if (requested !== undefined && JSON.stringify(requested) !== JSON.stringify(connection.target ?? null)) {
            if (owns()) setNotice('Настройки сохранены. Выбранный компьютер или папка изменились; нажмите «Применить настройки» для нового выбора.'); return;
        }
        if (!connection.target) { if (owns()) setNotice('Настройки сохранены в проекте. ' + connection.reason + ' Затем нажмите «Применить настройки».'); return; }
        try {
            const previous = selected.catalog?.deliveries.find(item => item.deviceId === connection.target!.deviceId && item.bindingId === connection.target!.expectedBindingId
                && item.instanceId === connection.target!.expectedInstanceId && item.revision === revision && ['failed', 'cancelled', 'conflict', 'succeeded'].includes(item.state));
            const requestKey = keys.current.forRequest('connect', { projectId: selected.projectId, revision, previousJobId: previous?.jobId, ...connection.target });
            const job = await agentCatalogApi.connect(selected.projectId!, connection.target, revision, requestKey);
            if (!job || typeof job.id !== 'string' || !job.id || job.kind !== 'configure-project-agents' || job.deviceId !== connection.target.deviceId
                || job.projectId !== selected.projectId || job.desiredRevision !== revision) throw new Error('Мост не подтвердил приём настроек. Повторите применение.');
            if (!owns()) return;
            if (['failed', 'cancelled', 'conflict'].includes(job.state)) throw new Error(job.message || 'Задание завершилось без применения настроек. Повторите применение.');
            setNotice(job.state === 'succeeded' ? 'Задание завершено. Перечитываем подтверждение выбранной папки.'
                : selected.bridge.device?.online ? 'Настройки переданы мосту. Ожидаем подтверждение записи настроек.' : 'Задание в очереди. Мост применит настройки, когда компьютер выйдет на связь.');
            await Promise.all([selected.refresh(), selected.bridge.reload()]);
        } catch (cause) {
            if (owns()) {
                setError('Настройки сохранены в проекте, но их применение не подтверждено. ' + errorMessage(cause, 'Проверьте подключение и повторите применение.'));
                await selected.refresh();
            }
        }
    };
    const mutate = async (input: IInput): Promise<IAgentSaved | undefined> => {
        const owns = owner();
        if (!owns() || lock.current || !latest.current.projectId || !latest.current.canManage) return;
        lock.current = true; setBusy(true); setError(''); setNotice('');
        const projectId = latest.current.projectId;
        const requested = agentConnection(latest.current).target ?? null;
        retry.current = () => mutate(input);
        try {
            const requestKey = keys.current.forRequest(input.kind, { projectId, agentId: input.agent.id, revision: input.revision, version: input.agent.version, manifest: input.agent.manifest, patch: input.patch });
            const result = input.kind === 'assign' ? await agentCatalogApi.assign(projectId, input.agent, input.revision, requestKey)
                : input.kind === 'remove' ? await agentCatalogApi.remove(projectId, input.agent.id, input.revision, requestKey)
                : await agentCatalogApi.configure(projectId, input.agent.id, input.patch ?? {}, input.revision, requestKey);
            if (!result || !Number.isSafeInteger(result.revision) || result.revision < 0 || result.assignment?.agentId !== input.agent.id) throw new Error('Сервер не подтвердил сохранение агента. Повторите тот же запрос.');
            if (!owns()) return;
            retry.current = undefined; setUnconfirmed(false);
            await latest.current.refresh();
            if (owns()) await connect(result.revision, owns, requested);
            return owns() ? result : undefined;
        } catch (cause) {
            if (owns()) {
                const status = (cause as {response?: {status?: number}})?.response?.status;
                const unknown = !status || status >= 500;
                setUnconfirmed(unknown);
                if (!unknown) retry.current = undefined;
                setError(errorMessage(cause, 'Сохранение не подтверждено. Повторите запрос или перечитайте состояние проекта.'));
                if (status === 409) await latest.current.refresh();
            }
            throw cause;
        } finally { if (owns()) { lock.current = false; setBusy(false); } }
    };
    const apply = async (): Promise<void> => {
        const owns = owner(), selected = latest.current;
        if (!owns() || lock.current || !selected.canManage || !selected.projectId || !selected.catalog?.revision) return;
        lock.current = true; setBusy(true); setError(''); setNotice('');
        try { await connect(selected.catalog.revision, owns); }
        finally { if (owns()) { lock.current = false; setBusy(false); } }
    };
    return { busy, error, notice, unconfirmed, mutate, apply,
        repeat: async (): Promise<void> => { try { await retry.current?.(); } catch { /* The mutation retains the error and original request key. */ } },
        recheck: async (): Promise<void> => { const owns = owner(); if (await latest.current.refresh() && owns()) { setUnconfirmed(false); retry.current = undefined; setError(''); } },
    };
}
