import {useEffect, useState} from 'react';
import {useAuthRequestOwner} from '../UserBlock/useAuthRequestOwner';
import {errorMessage} from '../../common/utils/errorMessage';
import {modelChatApi} from './api';
import type {IModelChatContext, IModelChatDetail} from './types';

/** A draft estimate is invalidated immediately; stale budgets never label a newer message. */
export function useChatContext(detail: IModelChatDetail | null, prompt: string, attachmentIds: string[]) {
    const {captureOwner} = useAuthRequestOwner();
    const key = JSON.stringify([detail?.conversation.id, detail?.conversation.revision, detail?.compaction?.coveredTurns, detail?.compaction?.updatedAt, prompt, attachmentIds]);
    const [state, setState] = useState<{key: string; context?: IModelChatContext; error?: string; rejected?: boolean}>({key: ''});
    useEffect(() => {
        if (!detail) return;
        const abort = new AbortController(), owns = captureOwner();
        const timer = setTimeout(() => {
            void modelChatApi.context(detail.conversation.id, prompt, attachmentIds, abort.signal)
                .then(context => {if (owns() && !abort.signal.aborted) setState({key, context});})
                .catch(cause => {
                    if (!owns() || abort.signal.aborted) return;
                    const status = typeof cause === 'object' && cause !== null && 'response' in cause
                        ? (cause as {response?: {status?: number}}).response?.status : undefined;
                    const rejected = status === 400 || status === 413 || status === 422;
                    setState({key, rejected, error: rejected ? errorMessage(cause, 'Сообщение с документами превышает допустимые ограничения.') : 'Не удалось оценить новый контекст. Сервер проверит его при отправке.'});
                });
        }, 350);
        return () => {clearTimeout(timer); abort.abort();};
    }, [key, captureOwner]);
    const baseline = !prompt && !attachmentIds.length ? detail?.context : undefined;
    return {context: state.key === key ? state.context : baseline, error: state.key === key ? state.error : '', rejected: state.key === key && !!state.rejected, loading: !!detail && state.key !== key};
}
