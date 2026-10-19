/** Ограничивает время и размер JSON-объекта, включая чтение тела ответа. */
export async function requestJson(url, {body, timeout = 5000, limit = 1024 * 1024} = {}) {
    const response = await fetch(url, {method: body === undefined ? 'GET' : 'POST', redirect: 'error',
        signal: AbortSignal.timeout(timeout), ...(body === undefined ? {} : {headers: {'content-type': 'application/json'}, body: JSON.stringify(body)})});
    const failure = `Модельный сервис: HTTP ${response.status}.`;
    if (!response.body) throw new Error(response.ok ? 'Модельный сервис вернул пустой ответ.' : failure);
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
        size += chunk.length;
        if (size > limit) throw new Error('Ответ модельного сервиса превышает допустимый размер.');
        chunks.push(chunk);
    }
    let value;
    try {value = JSON.parse(Buffer.concat(chunks).toString('utf8'));}
    catch {throw new Error(response.ok ? 'Модельный сервис вернул некорректный JSON.' : failure);}
    if (!response.ok || value?.error) {
        const error = value?.error;
        const message = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : 'Запрос отклонён.';
        throw new Error(`${failure} ${message.slice(0, 300)}`);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Модельный сервис должен вернуть JSON-объект.');
    return value;
}
