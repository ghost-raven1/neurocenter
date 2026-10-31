import { HttpException, ServiceUnavailableException } from '@nestjs/common';

/** Availability is distinct from an unconfirmed successful response and keeps the existing HTTP 503 contract. */
export class ProjectRagUnavailable extends ServiceUnavailableException {}

/** Межсервисный transport передаёт только internal token и ограниченный JSON; внешних URL из тела нет. */
export class ProjectRagClient {
    private readonly base = (process.env.RAG_SERVICE_URL || 'http://localhost:4300').replace(/\/+$/, '');
    async call<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
        const requestSignal = signal ?? AbortSignal.timeout(115000);
        let url: URL, payload: string | undefined;
        try {
            url = new URL(this.base + '/internal/project-rag/' + path);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
                throw new Error('invalid endpoint');
            payload = body === undefined ? undefined : JSON.stringify(body);
        } catch {
            throw new ServiceUnavailableException('Некорректная настройка или запрос сервиса индексов.');
        }
        const cancelled = () => requestSignal.aborted && requestSignal.reason?.name !== 'TimeoutError';
        let response: Response;
        try {
            response = await fetch(url.href, {
                method: body === undefined ? 'GET' : 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN || '',
                },
                ...(payload === undefined ? {} : { body: payload }),
                signal: requestSignal,
            });
        } catch {
            const message = 'Сервис индексов недоступен. Результат записи будет проверен перед повтором.';
            if (cancelled()) throw new ServiceUnavailableException(message);
            throw new ProjectRagUnavailable(message);
        }
        if ([502, 503, 504].includes(response.status)) {
            // Error pages contain no retrieved data. Cancel them without decoding or draining an unbounded proxy body.
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
                await Promise.race([
                    response.body?.cancel().catch(() => undefined),
                    new Promise<void>((resolve) => {
                        timer = setTimeout(resolve, 1000);
                        timer.unref();
                    }),
                ]);
            } finally {
                if (timer) clearTimeout(timer);
            }
            if (cancelled()) throw new ServiceUnavailableException('Запрос сервиса индексов прерван.');
            throw new ProjectRagUnavailable(
                'Сервис индексов недоступен. Результат записи будет проверен перед повтором.',
            );
        }
        const reader = response.body?.getReader(),
            parts: Uint8Array[] = [];
        let size = 0;
        try {
            if (reader)
                while (true) {
                    const item = await reader.read();
                    if (item.done) break;
                    size += item.value.byteLength;
                    if (size > 8 * 1024 ** 2) {
                        await reader.cancel();
                        throw new ServiceUnavailableException('Ответ сервиса индексов превышает допустимый размер.');
                    }
                    parts.push(item.value);
                }
        } catch (error) {
            if (error instanceof ServiceUnavailableException) throw error;
            throw new ServiceUnavailableException('Ответ сервиса индексов не подтверждён.');
        } finally {
            reader?.releaseLock();
        }
        const text = Buffer.concat(parts).toString('utf8');
        let result: unknown;
        try {
            result = JSON.parse(text);
        } catch {
            throw new ServiceUnavailableException('Сервис индексов вернул некорректный ответ.');
        }
        if (!response.ok) {
            throw new HttpException(
                result as object,
                [400, 403, 404, 409, 413].includes(response.status) ? response.status : 503,
            );
        }
        return result as T;
    }
}
