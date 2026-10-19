import { requireManagedIndexProfile } from './rag-index-profile.mjs';

/** Проверяет модель и размерность до upstream, скрывающего несовместимость пустой выдачей. */
export function protectedNativeStore(store, provenance) {
    return new Proxy(store, { get(object, key) {
        const value = Reflect.get(object, key, object);
        if (typeof value !== 'function') return value;
        if (!['search', 'searchWithFilter'].includes(key)) return value.bind(object);
        return async (vector, ...args) => {
            if (provenance) await requireManagedIndexProfile(object, provenance.storePath, provenance.config, provenance.dimension, provenance.embedder);
            const dimension = await object.getVectorDimension?.();
            if (typeof dimension === 'number' && vector.length !== dimension) {
                throw new Error('Ошибка локального индекса. Размерность модели отличается от индекса; требуется повторное индексирование.');
            }
            return value.call(object, vector, ...args);
        };
    } });
}

/** Возвращает только известную причину; ответ провайдера и локальные пути не попадают в инструмент. */
export function nativeSearchFailure(error) {
    const message = error instanceof Error ? error.message : '';
    const status = message.match(/Ошибка провайдера эмбеддингов \(HTTP (\d{3})\)/)?.[1];
    if (status) return `Поиск не выполнен: провайдер эмбеддингов вернул HTTP ${status}. Проверьте локальное подключение.`;
    if (message.startsWith('Ошибка локального индекса.')) return 'Поиск не выполнен: модель или индекс не проверены. Перезапустите OpenCode и повторите полное индексирование; при отключённой автоиндексации включите её.';
    return 'Поиск не выполнен. Проверьте провайдер эмбеддингов и состояние индекса.';
}
