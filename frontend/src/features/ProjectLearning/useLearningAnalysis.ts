import {useEffect, useRef, useState} from 'react';
import {errorMessage} from '../../common/utils/errorMessage';
import {createBridgeRequestKey} from '../McpBridge/bridgeRequestKey';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {projectLearningApi} from './api';
import {isAnalysisPending, requireLearningAnalysis} from './model';
import type {LearningAnalysis, LearningOverview} from './types';

interface AnalysisIntent {projectId: string; requestKey: string; expectedRevision: number; experienceIds: string[]; modelId: string}
interface Props {projectId: string; data: LearningOverview | null; blocked: boolean; refresh: () => Promise<LearningOverview | null>}
const unavailable = 'Квитанция анализа недоступна в браузере. Анализ не отправлен; разрешите хранение данных сайта и повторите.';

/** Polling only observes an existing job. No timer or unknown result can start another model request. */
export function useLearningAnalysis(props: Props) {
    const {scope, captureOwner} = useAuthRequestOwner();
    const context = 'neurocenter.learning.analysis.' + JSON.stringify([scope, props.projectId]), current = useRef(context); current.current = context;
    const latest = useRef(props); latest.current = props;
    const [analysis, setAnalysis] = useState<LearningAnalysis | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [unconfirmed, setUnconfirmed] = useState(false);
    const [notFound, setNotFound] = useState(false);
    const intent = useRef<AnalysisIntent | null>(null), lock = useRef(false), lastCompleted = useRef('');
    const canAnalyze = !!props.data?.capabilities.record;
    const owner = (): (() => boolean) => {const owns = captureOwner(); return () => owns() && current.current === context;};
    const restore = (): AnalysisIntent | null => {
        const raw = sessionStorage.getItem(context); if (!raw) return null;
        const value = JSON.parse(raw) as AnalysisIntent;
        if (value?.projectId !== props.projectId || typeof value.requestKey !== 'string' || !Number.isSafeInteger(value.expectedRevision) || !Array.isArray(value.experienceIds) || typeof value.modelId !== 'string') throw new Error('Сохранённый запрос анализа повреждён.');
        return value;
    };
    const accept = async (value: unknown, requested: AnalysisIntent, owns: () => boolean): Promise<void> => {
        const next = requireLearningAnalysis(value, requested.projectId, requested.requestKey);
        if (!owns()) return;
        setAnalysis(next); setUnconfirmed(false); setNotFound(false); setError('');
        if (next.state === 'completed' && lastCompleted.current !== next.id) {lastCompleted.current = next.id; await latest.current.refresh();}
    };
    useEffect(() => {
        setAnalysis(null); setBusy(false); setError(''); setUnconfirmed(false); setNotFound(false); lock.current = false; intent.current = null; lastCompleted.current = '';
        if (!canAnalyze) return;
        try {
            const value = restore(); if (!value) return;
            intent.current = value; setUnconfirmed(true);
        } catch (cause) {setError(errorMessage(cause, unavailable)); setUnconfirmed(true);}
    }, [context, props.projectId, canAnalyze]);
    const start = async (experienceIds: string[], modelId: string, expectedRevision: number): Promise<boolean> => {
        const owns = owner(), selected = latest.current;
        if (!owns() || lock.current || selected.blocked || !selected.data?.capabilities.record || unconfirmed || isAnalysisPending(analysis)) return false;
        const requested: AnalysisIntent = {projectId: selected.projectId, expectedRevision, experienceIds, modelId, requestKey: createBridgeRequestKey()};
        lock.current = true; setBusy(true); setError('');
        let sent = false;
        try {
            try {sessionStorage.setItem(context, JSON.stringify(requested));} catch {throw new Error(unavailable);}
            intent.current = requested; sent = true;
            await accept(await projectLearningApi.analyze(requested.projectId, {requestKey: requested.requestKey, expectedRevision, experienceIds, modelId}), requested, owns); return owns();
        } catch (cause) {
            if (!owns()) return false;
            const status = (cause as {response?: {status?: number}})?.response?.status;
            const unknown = sent && (!status || status >= 500);
            setUnconfirmed(unknown); setError(errorMessage(cause, 'Анализ не подтверждён. Проверьте результат по квитанции.'));
            if (!unknown && sent) {sessionStorage.removeItem(context); intent.current = null;}
            if (status === 409 || status === 403 || status === 404) await selected.refresh();
            return false;
        } finally {if (owns()) {lock.current = false; setBusy(false);}}
    };
    const recover = async (repeat = false): Promise<void> => {
        const owns = owner(); let requested = intent.current;
        if (!owns() || lock.current) return;
        lock.current = true; setBusy(true); setError('');
        try {
            if (!requested) {
                requested = restore(); intent.current = requested;
                if (!requested) {
                    if (!await latest.current.refresh() || !owns()) return;
                    setUnconfirmed(false); setNotFound(false); setError(''); return;
                }
            }
            let value: LearningAnalysis;
            try {value = await projectLearningApi.analysisReceipt(requested.projectId, requested.requestKey);}
            catch (cause) {
                if ((cause as {response?: {status?: number}})?.response?.status !== 404 || !repeat || !latest.current.data?.capabilities.record || latest.current.blocked) throw cause;
                if (!owns()) return;
                value = await projectLearningApi.analyze(requested.projectId, {requestKey: requested.requestKey, expectedRevision: requested.expectedRevision, experienceIds: requested.experienceIds, modelId: requested.modelId});
            }
            await accept(value, requested, owns);
        }
        catch (cause) {if (owns()) {setUnconfirmed(true); setNotFound((cause as {response?: {status?: number}})?.response?.status === 404); setError(errorMessage(cause, 'Запрос анализа пока не найден. Повторная генерация автоматически не запускается.'));}}
        finally {if (owns()) {lock.current = false; setBusy(false);}}
    };
    useEffect(() => {
        if (!isAnalysisPending(analysis) || !intent.current) return;
        const owns = owner(), requested = intent.current; let polling = false;
        const timer = window.setInterval(() => {
            if (polling || document.visibilityState === 'hidden' || !owns()) return;
            polling = true;
            void projectLearningApi.analysis(props.projectId, analysis!.id).then(value => accept(value, requested, owns))
                .catch(cause => {if (owns()) setError(errorMessage(cause, 'Не удалось обновить состояние анализа. Генерация не запускается повторно.'));})
                .finally(() => {polling = false;});
        }, 2500);
        return () => window.clearInterval(timer);
    }, [analysis?.id, analysis?.state, context]);
    return {analysis, busy, error, unconfirmed, notFound, pending: isAnalysisPending(analysis), start, recover};
}
