/** Проверяет размерность до upstream, который выдаёт несовместимый индекс за пустую выдачу. */
export function protectedNativeStore(store) {
    return new Proxy(store, { get(object, key) {
        const value = Reflect.get(object, key, object);
        if (typeof value !== 'function') return value;
        if (!['search', 'searchWithFilter'].includes(key)) return value.bind(object);
        return async (vector, ...args) => {
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
    if (message.startsWith('Ошибка локального индекса.')) return 'Поиск не выполнен: ошибка локального индекса. Проверьте модель и повторите индексирование.';
    return 'Поиск не выполнен. Проверьте провайдер эмбеддингов и состояние индекса.';
}
