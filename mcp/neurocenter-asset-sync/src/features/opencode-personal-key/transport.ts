import http from 'node:http';
import https from 'node:https';

/** A key-bearing request never follows redirects, uses environment proxies or exposes response error text. */
export function personalKeyWire(
    origin: string,
    token: string,
    route: 'context' | 'save' | 'receipt',
    input: unknown,
    signal?: AbortSignal,
): Promise<unknown> {
    const target = new URL(origin);
    if (
        target.origin !== origin ||
        target.username ||
        target.password ||
        !['https:', 'http:'].includes(target.protocol) ||
        (target.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))
    )
        return Promise.reject(new Error('Для передачи ключа нужен HTTPS либо локальный API.'));
    const body = JSON.stringify(input);
    if (Buffer.byteLength(body) > 20000) return Promise.reject(new Error('Запрос передачи ключа недопустим.'));
    const fail = () => new Error('Ответ сервера не подтверждён. Проверьте квитанцию прежнего запроса.');
    return new Promise((resolve, reject) => {
        const request = (target.protocol === 'https:' ? https : http).request(
            new URL('/api/device-channel/opencode-personal-key/' + route, target),
            {
                method: 'POST',
                signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
                headers: {
                    authorization: 'Bearer ' + token,
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
            },
            (response) => {
                if (response.statusCode !== 200) {
                    response.destroy();
                    reject(fail());
                    return;
                }
                const chunks: Buffer[] = [];
                let size = 0;
                response.on('data', (chunk: Buffer) => {
                    if ((size += chunk.length) > 64000) {
                        response.destroy();
                        reject(fail());
                    } else chunks.push(chunk);
                });
                response.on('error', () => reject(fail()));
                response.on('end', () => {
                    try {
                        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                    } catch {
                        reject(fail());
                    }
                });
            },
        );
        request.setTimeout(20000, () => request.destroy());
        request.on('error', () => reject(fail()));
        request.end(body);
    });
}
