import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import https from 'node:https';

const MAX_RESPONSE_BYTES = 16 * 1024;
const UNAVAILABLE = 'Сервис базы знаний недоступен. Повторите измерение позже.';
const INVALID = 'Сервис базы знаний вернул некорректный замер. Повторите позже.';
const TIMEOUT = 'Измерение копии знаний не завершилось вовремя. Повторите позже.';

export interface IRetainedSize {
    bytes: number | null;
    error?: string;
}

/** Ограниченный по времени и объёму замер; только подтверждённое число считается размером. */
export function fetchProjectRetainedSize(
    baseUrl: string,
    projectKey: string,
    internalToken = '',
    timeoutMs = 5000,
): Promise<IRetainedSize> {
    if (!baseUrl) return Promise.resolve({ bytes: null, error: 'Сервис базы знаний не настроен.' });
    let endpoint: URL;
    try {
        endpoint = new URL(baseUrl);
        if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('Unsupported protocol');
        endpoint.pathname = endpoint.pathname.replace(/\/+$/, '') + '/api/rag/size';
        endpoint.search = '';
        endpoint.hash = '';
        endpoint.searchParams.set('projectKey', projectKey);
    } catch {
        return Promise.resolve({ bytes: null, error: UNAVAILABLE });
    }

    return new Promise((resolve) => {
        let request: ClientRequest | undefined;
        let response: IncomingMessage | undefined;
        let settled = false;
        const finish = (result: IRetainedSize, cancel = false): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (cancel) {
                response?.destroy();
                request?.destroy();
            }
            resolve(result);
        };
        const fail = (error: string): void => finish({ bytes: null, error }, true);
        const timer = setTimeout(() => fail(TIMEOUT), timeoutMs);
        try {
            const transport = endpoint.protocol === 'https:' ? https : http;
            request = transport.get(endpoint, { headers: { 'x-neurocenter-internal': internalToken } }, (res) => {
                response = res;
                res.on('error', () => fail(UNAVAILABLE));
                res.on('aborted', () => fail(UNAVAILABLE));
                res.on('close', () => {
                    if (!res.complete) fail(UNAVAILABLE);
                });
                if (settled) {
                    res.destroy();
                    return;
                }
                if (res.statusCode !== 200) {
                    fail(UNAVAILABLE);
                    return;
                }
                const chunks: Buffer[] = [];
                let size = 0;
                res.on('data', (chunk: Buffer) => {
                    if (settled) return;
                    size += chunk.length;
                    if (size > MAX_RESPONSE_BYTES) {
                        fail(INVALID);
                        return;
                    }
                    chunks.push(chunk);
                });
                res.on('end', () => {
                    if (settled) return;
                    try {
                        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        if (
                            !body ||
                            Array.isArray(body) ||
                            body.projectKey !== projectKey ||
                            typeof body.bytes !== 'number' ||
                            !Number.isSafeInteger(body.bytes) ||
                            body.bytes < 0
                        ) {
                            fail(INVALID);
                            return;
                        }
                        finish({ bytes: body.bytes });
                    } catch {
                        fail(INVALID);
                    }
                });
            });
            request.on('error', () => fail(UNAVAILABLE));
        } catch {
            fail(UNAVAILABLE);
        }
    });
}
