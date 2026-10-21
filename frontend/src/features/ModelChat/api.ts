import api from '../../core/api/base';
import type { ICatalogModel } from '../ModelCatalog/types';
import { modelChatAnswer } from './model';
import type { IModelChatAnswer, IModelChatMessage } from './types';

/** Uses the authenticated Gateway only; provider address, key and defaults stay on the server. */
export async function sendModelChat(model: ICatalogModel, messages: IModelChatMessage[], projectId: string | undefined, signal: AbortSignal): Promise<IModelChatAnswer> {
    if (!model.modelPin || !/^[a-f0-9]{64}$/.test(model.modelPin)) throw new Error('Обновите каталог перед отправкой сообщения модели.');
    const response = await api.post<unknown>(`/api/models/${encodeURIComponent(model.id)}/ollama/v1/chat/completions`, { messages, stream: false },
        { params: { ...(projectId ? { projectId } : {}), expectedModelPin: model.modelPin }, signal, timeout: 620000 });
    return modelChatAnswer(response.data, model.model);
}
