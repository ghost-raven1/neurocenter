import type { IModel } from './model.interfaces';

export const isRemoteModel = (model: Pick<IModel, 'runtime'>): boolean =>
    model.runtime === 'remote-openai' || model.runtime === 'remote-ollama';
