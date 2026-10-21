import {useEffect, useRef, useState} from 'react';
import {errorMessage} from '../../common/utils/errorMessage';
import {createBridgeRequestKey} from '../McpBridge/bridgeRequestKey';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {projectLearningApi} from './api';
import {clearLearningIntent, learningIntentScope, readLearningIntent, saveLearningIntent} from './intentStore';
import {commandCapability, requireLearningReceipt} from './model';
import type {LearningCommand, LearningIntent, LearningOverview} from './types';

interface Props {projectId: string; data: LearningOverview | null; blocked: boolean; refresh: () => Promise<LearningOverview | null>}

/** Lost acknowledgements keep the exact operation; a refresh alone cannot declare a write successful. */
export function useLearningActions(props: Props) {
    const {scope, captureOwner} = useAuthRequestOwner();
    const context = learningIntentScope(scope, props.projectId), current = useRef(context); current.current = context;
    const latest = useRef(props); latest.current = props;
    const [busy, setBusy] = useState(false), [error, setError] = useState(''), [conflict, setConflict] = useState(false), [unconfirmed, setUnconfirmed] = useState(false);
    const pending = useRef<LearningIntent | null>(null), lock = useRef(false);
    const writable = !!props.data && (props.data.capabilities.record || props.data.capabilities.review || props.data.capabilities.approve);
    useEffect(() => {
        lock.current = false; pending.current = null; setBusy(false); setError(''); setConflict(false); setUnconfirmed(false);
        if (!writable) return;
        try { pending.current = readLearningIntent(context, props.projectId); setUnconfirmed(!!pending.current); }
        catch (cause) { setError(errorMessage(cause, 'Квитанция запроса недоступна.')); setUnconfirmed(true); }
    }, [context, props.projectId, writable]);
    const owner = (): (() => boolean) => {const owns = captureOwner(); return () => owns() && current.current === context;};
    const finish = async (intent: LearningIntent, value: unknown, owns: () => boolean): Promise<boolean> => {
        requireLearningReceipt(value, intent.projectId, intent.requestKey);
        if (!owns()) return false;
        clearLearningIntent(context, intent.requestKey, intent.projectId); pending.current = null;
        setUnconfirmed(false); setConflict(false); setError('');
        // Socket updates may supersede this read; the overview owns actual refresh errors.
        await latest.current.refresh();
        return owns();
    };
    const fail = async (cause: unknown, intent: LearningIntent, owns: () => boolean): Promise<false> => {
        if (!owns()) return false;
        const status = (cause as {response?: {status?: number}})?.response?.status;
        const unknown = !status || status >= 500;
        if (!unknown) {
            try {clearLearningIntent(context, intent.requestKey, intent.projectId); pending.current = null;}
            catch (storageCause) {setUnconfirmed(true); setError(errorMessage(storageCause, 'Не удалось завершить квитанцию запроса.')); return false;}
        }
        setUnconfirmed(unknown); setConflict(status === 409);
        setError(errorMessage(cause, unknown ? 'Ответ потерян. Проверьте результат или повторите тот же запрос.' : 'Изменение не принято сервером.'));
        if (status === 409 || status === 401 || status === 403 || status === 404) await latest.current.refresh();
        return false;
    };
    const execute = async (command: LearningCommand, expectedRevision: number): Promise<boolean> => {
        const owns = owner(), selected = latest.current;
        if (!owns() || lock.current || pending.current || selected.blocked || !selected.data?.capabilities[commandCapability(command)]) return false;
        const intent: LearningIntent = {projectId: selected.projectId, command, expectedRevision, requestKey: createBridgeRequestKey()};
        lock.current = true; setBusy(true); setError(''); setConflict(false);
        try { saveLearningIntent(context, intent); pending.current = intent; return await finish(intent, await projectLearningApi.mutate(intent), owns); }
        catch (cause) {
            if (!pending.current) {if (owns()) {setError(errorMessage(cause, 'Запрос не отправлен.')); setUnconfirmed(false);} return false;}
            return await fail(cause, intent, owns);
        }
        finally { if (owns()) {lock.current = false; setBusy(false);} }
    };
    const recover = async (repeat: boolean): Promise<boolean> => {
        const owns = owner(); let intent = pending.current, writing = false;
        if (!owns() || lock.current) return false;
        lock.current = true; setBusy(true); setError('');
        try {
            if (!intent) {
                intent = readLearningIntent(context, latest.current.projectId); pending.current = intent;
                if (!intent) {
                    if (!await latest.current.refresh() || !owns()) return false;
                    setUnconfirmed(false); setConflict(false); setError(''); return true;
                }
            }
            let receipt = await projectLearningApi.receipt(intent.projectId, intent.requestKey);
            if (!owns()) return false;
            if (!receipt && repeat && latest.current.data?.capabilities[commandCapability(intent.command)]) {writing = true; receipt = await projectLearningApi.mutate(intent);}
            if (receipt) return await finish(intent, receipt, owns);
            setError('Сервер ещё не подтвердил этот запрос. Можно повторить тот же запрос с прежним ключом.'); return false;
        } catch (cause) {
            if (writing && intent) return await fail(cause, intent, owns);
            if (owns()) {
                setUnconfirmed(true); setError(errorMessage(cause, 'Не удалось проверить квитанцию. Исходный запрос сохранён.'));
                const status = (cause as {response?: {status?: number}})?.response?.status;
                if (status === 401 || status === 403 || status === 404) await latest.current.refresh();
            }
            return false;
        }
        finally {if (owns()) {lock.current = false; setBusy(false);}}
    };
    return {busy, error, conflict, unconfirmed, execute, recover, resetError: () => {setError(''); setConflict(false);}};
}
