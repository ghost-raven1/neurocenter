const hostedIdentity = Symbol.for('neurocenter.hosted-rag');
const permanentHostedFailure = Symbol('neurocenter.hosted-embedding-failure');
const hostedInputBytes = 256 * 1024;
const hostedInputCount = 64;

function hostedFailure(message, cancelled = false) {
    const error = new Error(`${message} (HTTP 422).`);
    if (cancelled) error.name = 'AbortError';
    Object.defineProperty(error, permanentHostedFailure, {value: true});
    return error;
}

/** Ошибка провайдера не должна раскрывать тело ответа, URL или локальный API-ключ. */
export function embeddingError(error) {
    if (error?.[permanentHostedFailure]) return error;
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

/** Plans the full DTO-sized request before I/O; byte counts include JSON escaping and array punctuation. */
function hostedBatches(texts) {
    if (!Array.isArray(texts) || !texts.length) throw hostedFailure('Нужны непустые тексты для эмбеддингов');
    const batches = []; let batch = [], bytes = 2;
    for (const text of texts) {
        if (typeof text !== 'string' || !text.trim()) throw hostedFailure('Нужны непустые тексты для эмбеддингов');
        const size = Buffer.byteLength(JSON.stringify(text), 'utf8');
        if (size + 2 > hostedInputBytes) throw hostedFailure('Один текст превышает 256 КиБ. Проверьте разбиение исходных текстов');
        if (batch.length === hostedInputCount || bytes + size + (batch.length ? 1 : 0) > hostedInputBytes) {
            batches.push(batch); batch = []; bytes = 2;
        }
        bytes += size + (batch.length ? 1 : 0); batch.push(text);
    }
    batches.push(batch); return batches;
}

function assertNotAborted(args) {
    for (const argument of args) {
        const signal = argument instanceof AbortSignal ? argument : argument?.signal;
        if (signal?.aborted) throw hostedFailure('Запрос эмбеддингов отменён', true);
    }
}

/** Hosted calls keep one vector per input; a partially sent composite must never be replayed by upstream retry. */
function hostedEmbedder(embedder) {
    return new Proxy(embedder, {get(object, key) {
        const value = Reflect.get(object, key, object);
        if (key !== 'embed' || typeof value !== 'function') return typeof value === 'function' ? value.bind(object) : value;
        return async (texts, ...args) => {
            assertNotAborted(args); const batches = hostedBatches(texts), vectors = [];
            for (const batch of batches) {
                try {
                    assertNotAborted(args);
                    const result = await value.call(object, batch, ...args);
                    assertNotAborted(args);
                    if (!Array.isArray(result) || result.length !== batch.length) throw hostedFailure('Модель не подтвердила все векторы подзапроса');
                    vectors.push(...result);
                } catch (error) {
                    if (error?.[permanentHostedFailure]) throw error;
                    if (error?.name === 'AbortError') throw hostedFailure('Запрос эмбеддингов отменён', true);
                    if (vectors.length) throw hostedFailure('Составной запрос эмбеддингов не завершён. Частичный результат отброшен; повторите индексацию');
                    throw error;
                }
            }
            return vectors;
        };
    }});
}

/** Не отдаёт upstream журналам ответ провайдера; только закреплённый hosted-profile включает бюджет Нейроцентра. */
export function protectedEmbedder(embedder, config) {
    return observeMethods(typeof config?.[hostedIdentity] === 'string' ? hostedEmbedder(embedder) : embedder, embeddingError);
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
