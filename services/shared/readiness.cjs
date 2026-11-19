'use strict';
/** Таймаут агрегированной проверки зависимостей (readiness), мс. */
const READINESS_CHECK_TIMEOUT_MS = 2500;
/** Таймаут одиночного HTTP /ready запроса к зависимому сервису, мс. */
const HTTP_READY_TIMEOUT_MS = 2000;
/** Максимальный размер тела JSON-квитанции /ready, байты. */
const READY_BODY_LIMIT_BYTES = 16384;

/** Готовность зависимостей ограничена по времени; ответ не раскрывает URL и секреты. */
async function checkReadiness(checks) {
    const entries = await Promise.all(
        Object.entries(checks).map(async ([name, check]) => {
            let timer;
            try {
                await Promise.race([
                    Promise.resolve().then(check),
                    new Promise((_, reject) => {
                        timer = setTimeout(() => reject(new Error('timeout')), READINESS_CHECK_TIMEOUT_MS);
                    }),
                ]);
                return [name, 'ready'];
            } catch {
                return [name, 'unavailable'];
            } finally {
                clearTimeout(timer);
            }
        }),
    );
    return { ok: entries.every(([, status]) => status === 'ready'), checks: Object.fromEntries(entries) };
}
async function httpReady(base) {
    const response = await fetch(base.replace(/\/$/, '') + '/ready', {
        signal: AbortSignal.timeout(HTTP_READY_TIMEOUT_MS),
        redirect: 'error',
    });
    if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error('unavailable');
    }
    const reader = response.body?.getReader(),
        parts = [];
    let bytes = 0;
    if (!reader) throw new Error('unavailable');
    try {
        for (;;) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > READY_BODY_LIMIT_BYTES) {
                await reader.cancel();
                throw new Error('unavailable');
            }
            parts.push(part.value);
        }
        const state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)));
        if (!state || typeof state !== 'object' || Array.isArray(state) || state.ok !== true)
            throw new Error('unavailable');
    } catch {
        throw new Error('unavailable');
    } finally {
        reader.releaseLock();
    }
}
module.exports = { checkReadiness, httpReady, READINESS_CHECK_TIMEOUT_MS, HTTP_READY_TIMEOUT_MS, READY_BODY_LIMIT_BYTES };
