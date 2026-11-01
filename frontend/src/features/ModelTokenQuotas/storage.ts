import { checkedInput } from './model';
import type { IQuotaIdentity, IQuotaIntent, TQuotaStorage } from './interfaces';

export const quotaStorageKey = (identity: IQuotaIdentity): string =>
    'model-token-quota:' + encodeURIComponent(JSON.stringify([identity.scope, identity.modelId, identity.userEmail]));
/** Corrupt or another tab's bytes are preserved; a local observation is never claimed as atomic cross-tab CAS. */
export function readQuotaIntent(raw: string | null, identity: IQuotaIdentity): IQuotaIntent | undefined {
    if (raw === null) return;
    try {
        const value = JSON.parse(raw);
        if (
            value?.schemaVersion !== 1 ||
            value.scope !== identity.scope ||
            value.modelId !== identity.modelId ||
            value.userEmail !== identity.userEmail ||
            value.writerEmail !== identity.writerEmail
        )
            throw Error();
        return { schemaVersion: 1, ...identity, input: checkedInput(value.input) };
    } catch {
        throw Error(
            'Сохранённый запрос повреждён или принадлежит другому контексту. Новая запись заблокирована; исходные данные оставлены.',
        );
    }
}
export function replaceQuotaJournal(
    storage: TQuotaStorage | undefined,
    key: string,
    observed: string | null,
    value: IQuotaIntent | undefined,
): string | null {
    if (!storage) throw Error('Хранилище браузера недоступно. Разрешите его и повторите проверку перед сохранением.');
    if (storage.getItem(key) !== observed)
        throw Error('Запрос изменён в другой вкладке. Проверьте сохранённый запрос перед продолжением.');
    const raw = value ? JSON.stringify(value) : null;
    if (raw === null) storage.removeItem(key);
    else storage.setItem(key, raw);
    if (storage.getItem(key) !== raw)
        throw Error('Не удалось надёжно сохранить запрос. Отправка остановлена; проверьте хранилище браузера.');
    return raw;
}
