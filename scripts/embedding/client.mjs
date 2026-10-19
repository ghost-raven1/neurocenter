/** Ограничивает и время, и размер JSON-ответа, включая чтение тела. */
export async function requestJson(url, {body, timeout = 5000, limit = 1024 * 1024} = {}) {
    const response = await fetch(url, {method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        signal: AbortSignal.timeout(timeout), ...(body === undefined ? {} : {headers: {'content-type': 'application/json'}, body: JSON.stringify(body)})});
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) throw new Error('Ответ модельного сервиса превышает допустимый размер.');
        chunks.push(chunk);
    }
    let value;
    try {value = JSON.parse(Buffer.concat(chunks).toString('utf8'));}
    catch {throw new Error(response.ok ? 'Модельный сервис вернул некорректный JSON.' : `Ollama: HTTP ${response.status}.`);}
    if (!response.ok || value.error) throw new Error(`Ollama: HTTP ${response.status}. ${String(value.error || 'Запрос отклонён.').slice(0, 300)}`);
    return value;
}

/** Принимает только полный набор конечных ненулевых float32-векторов нужной размерности. */
export function validateVectors(value, dimension, count) {
    if (!Array.isArray(value?.embeddings) || value.embeddings.length !== count || value.embeddings.some(vector =>
        !Array.isArray(vector) || vector.length !== dimension || !vector.some(number => Math.fround(number) !== 0)
        || vector.some(number => typeof number !== 'number' || !Number.isFinite(Math.fround(number))))) {
        throw new Error(`Модель должна вернуть ${count} вектора размерности ${dimension} с конечными ненулевыми координатами.`);
    }
    return value.embeddings;
}

/** Поток загрузки ограничен общим deadline и размером каждой NDJSON-записи. */
export async function pullModel(config, progress = () => {}) {
    const response = await fetch(config.baseUrl + '/api/pull', {method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(30 * 60 * 1000), headers: {'content-type': 'application/json'},
        body: JSON.stringify({model: config.lock.model, stream: true})});
    if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Загрузка модели: HTTP ${response.status}.`);
    }
    const decoder = new TextDecoder();
    let pending = '', received = 0, success = false;
    function line(raw) {
        if (!raw.trim()) return;
        const value = JSON.parse(raw);
        if (value.error) throw new Error('Загрузка модели: ' + String(value.error).slice(0, 300));
        progress(value);
        if (value.status === 'success') success = true;
    }
    for await (const chunk of response.body) {
        received += chunk.length;
        if (received > 16 * 1024 * 1024) throw new Error('Поток состояния загрузки слишком большой.');
        pending += decoder.decode(chunk, {stream: true});
        let end;
        while ((end = pending.indexOf('\n')) !== -1) {
            if (end > 65536) throw new Error('Слишком длинная запись состояния загрузки.');
            line(pending.slice(0, end)); pending = pending.slice(end + 1);
        }
        if (pending.length > 65536) throw new Error('Слишком длинная запись состояния загрузки.');
    }
    pending += decoder.decode(); line(pending);
    if (!success) throw new Error(`Загрузка модели прервана. Повторите ${config.upCommand || 'npm run embedding:up'} для продолжения.`);
}

/** Проверка отправляет только два синтетических текста и не сохраняет сами векторы. */
export async function probeModel(config) {
    const value = await requestJson(config.baseUrl + '/api/embed', {timeout: 120000,
        body: {model: config.lock.model, input: ['Локальная проверка поиска по проекту.', 'Local project knowledge search.'], truncate: false, keep_alive: '1m'}});
    validateVectors(value, config.lock.dimension, 2);
    return {dimension: config.lock.dimension, vectors: 2};
}
