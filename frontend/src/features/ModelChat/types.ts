import type { ICatalogModel } from '../ModelCatalog/types';

export interface IModelChatMessage { role: 'user' | 'assistant'; content: string; }
export interface IModelChatAnswer { content: string; finishReason: 'stop' | 'length'; }
export interface IModelChatTurn {
    id: number; prompt: string; status: 'pending' | 'done' | 'failed' | 'cancelled';
    answer?: IModelChatAnswer; error?: string;
}
export interface IModelChatProps {
    model: ICatalogModel; projectId?: string; projectName?: string;
    unavailableReason?: string; onClose: () => void;
}
