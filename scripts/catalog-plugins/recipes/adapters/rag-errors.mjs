/** Ошибка провайдера не должна раскрывать тело ответа, URL или локальный API-ключ. */
export function embeddingError(error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.match(/\((?:HTTP )?(\d{3})\)/)?.[1];
    const reason = /exceed_context_size|exceeds the available context size/i.test(message)
        ? 'exceed_context_size_error' : /timed out|timeout/i.test(message)
            ? 'request timed out' : 'проверьте URL, модель и локальный API-ключ';
    return new Error(`Ошибка провайдера эмбеддингов${status ? ` (HTTP ${status})` : ''}: ${reason}.`);
}

/** Сохраняет методы класса и безопасно перехватывает синхронные и асинхронные отказы. */
function observeMethods(target, onError) {
    return new Proxy(target, { get(object, key) {
        const value = Reflect.get(object, key, object);
        if (typeof value !== 'function') return value;
        return (...args) => {
            try {
                const result = value.apply(object, args);
                return result?.then ? result.catch(error => { throw onError(error); }) : result;
            } catch (error) { throw onError(error); }
        };
    } });
}

/** Не отдаёт upstream журналам ответ провайдера с возможными секретами. */
export function protectedEmbedder(embedder) {
    return observeMethods(embedder, embeddingError);
}

/** Возвращает подавленную upstream ошибку без повторного запроса к модели. */
export function strictRetriever(retrieve) {
    return async (query, embedder, store, options = {}) => {
        let failure;
        const capture = error => { failure ??= embeddingError(error); return failure; };
        const captureIndex = () => {
            failure ??= new Error('Ошибка локального индекса. Проверьте состояние индекса и повторите запрос.');
            return failure;
        };
        const result = await retrieve(query, observeMethods(embedder, capture), observeMethods(store, captureIndex), {
            ...options,
            ...(options.keywordIndex ? { keywordIndex: observeMethods(options.keywordIndex, captureIndex) } : {}),
        });
        if (failure) throw failure;
        return result;
    };
}

/** Сохраняет статистику прохода, но не выдаёт отказ embedding за успешную индексацию. */
export function requireSuccessfulIndex(stats) {
    if (stats.embeddingUnavailable || stats.embeddingFailures > 0) {
        const error = new Error('Индексирование не завершено: провайдер эмбеддингов недоступен или не обработал часть данных. Проверьте локальную настройку и повторите индексирование.');
        error.indexStats = stats;
        throw error;
    }
    return stats;
}
