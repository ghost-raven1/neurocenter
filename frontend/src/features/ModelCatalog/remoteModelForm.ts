import type { ICatalogModel, IRemoteModelOptions } from './types';

export type TRemoteModelOptionValues = { [Key in keyof IRemoteModelOptions]?: IRemoteModelOptions[Key] | null };

/** Очищенные поля исчезают из запроса; совместимость OpenAI задаётся только в подключении. */
export function remoteModelOptions(values: TRemoteModelOptionValues | undefined, model: Pick<ICatalogModel, 'runtime' | 'capability'>): IRemoteModelOptions {
    const options: IRemoteModelOptions = {};
    if (model.capability !== 'embedding') {
        const keys: Array<'temperature' | 'topP' | 'maxOutputTokens' | 'contextWindow'> = ['temperature', 'topP', 'maxOutputTokens'];
        if (model.runtime === 'remote-ollama' || model.runtime === 'remote-openai') keys.push('contextWindow');
        for (const key of keys) if (values?.[key] != null) options[key] = values[key];
    }
    if (model.runtime === 'remote-openai') {
        const responseModel = values?.responseModel?.trim();
        if (responseModel) options.responseModel = responseModel;
        if (model.capability !== 'embedding' && values?.tokenLimitParameter != null) options.tokenLimitParameter = values.tokenLimitParameter;
    }
    return options;
}

/** localhost и частные API допустимы; credentials и параметры URL задаются отдельными полями. */
export function isRemoteApiUrl(value: unknown): boolean {
    if (typeof value !== 'string' || !value || /[\s\\\x00-\x1f\x7f]/.test(value)) return false;
    try {
        const url = new URL(value);
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    } catch { return false; }
}
