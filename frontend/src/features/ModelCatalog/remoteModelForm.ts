import type { ICatalogModel, IRemoteModelOptions } from './types';

export type TRemoteModelOptionValues = { [Key in keyof IRemoteModelOptions]?: number | null };

/** Очищенные числовые поля исчезают из запроса; нулевые значения сохраняются. */
export function remoteModelOptions(values: TRemoteModelOptionValues | undefined, model: Pick<ICatalogModel, 'runtime' | 'capability'>): IRemoteModelOptions {
    if (model.capability === 'embedding') return {};
    const options: IRemoteModelOptions = {};
    const keys: Array<keyof IRemoteModelOptions> = ['temperature', 'topP', 'maxOutputTokens'];
    if (model.runtime === 'remote-ollama' || model.runtime === 'remote-openai') keys.push('contextWindow');
    for (const key of keys) if (values?.[key] != null) options[key] = values[key];
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
