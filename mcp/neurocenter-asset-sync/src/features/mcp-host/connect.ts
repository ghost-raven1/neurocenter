import http from 'node:http';
import https from 'node:https';
import { hub, apiHub, readState, type Credentials } from '../../bridge/state.js';
import type { Package } from '../../bridge/package.js';

const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
/** Путь канала хоста в конфигурации OpenCode: /api/mcp-host/m/<ticket>. */
export const hostedMcpPath = (path: string): boolean =>
    /^\/api\/mcp-host\/m\/[A-Za-z0-9_=-]+\.[A-Za-z0-9_-]+$/.test(path);

export const hostedMcpUrlPrefix = (): string => apiHub().replace(/\/+$/, '') + '/api/mcp-host/m/';

export const isHostedMcpUrl = (value: unknown): value is string =>
    typeof value === 'string' &&
    [apiHub(), hub()].some(
        (origin) => value.startsWith(origin + '/api/mcp-host/m/') && hostedMcpPath(value.slice(origin.length)),
    );

/** Берёт билет хоста у площадки за устройство и одобренный пакет; токен устройства в проект не уходит. */
export async function requestHostedMcpConnection(projectId: string, pkg: Package): Promise<string> {
    const credentials = await readState<Credentials>('credentials');
    if (
        !credentials ||
        !uuid.test(credentials.deviceId) ||
        typeof credentials.token !== 'string' ||
        !credentials.token ||
        /[\r\n]/.test(credentials.token) ||
        !projectId
    ) {
        throw new Error('Хост MCP доступен только подключённому проекту. Проверьте подключение к Нейроцентру.');
    }
    const url = new URL('/api/mcp-host/connect', apiHub());
    if (!['http:', 'https:'].includes(url.protocol)) {
        throw new Error('Неподдерживаемый протокол площадки.');
    }
    const body = JSON.stringify({ projectId, pkg });
    return await new Promise<string>((resolve, reject) => {
        let failed = false;
        const fail = (message: string) => {
            if (failed) {
                return;
            }
            failed = true;
            clearTimeout(timer);
            request.destroy();
            reject(new Error(message));
        };
        const request = (url.protocol === 'https:' ? https : http).request(
            url,
            {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${credentials.token}`,
                    'content-type': 'application/json',
                    'content-length': String(Buffer.byteLength(body)),
                },
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on('data', (chunk) => {
                    chunks.push(chunk as Buffer);
                    if (Buffer.concat(chunks).byteLength > 1024 * 1024) {
                        fail('Ответ площадки превышает лимит.');
                    }
                });
                let done = false;
                const finish = (fn: () => void) => {
                    if (!done) {
                        done = true;
                        fn();
                    }
                };
                response.once('end', () => {
                    const status = response.statusCode ?? 0;
                    if (status !== 200) {
                        finish(() =>
                            fail(
                                status >= 500
                                    ? 'Сервис хоста MCP недоступен. Повторите установку позже.'
                                    : 'Хост MCP не разрешил подключение этого пакета.',
                            ),
                        );
                        return;
                    }
                    let parsed: { path?: unknown };
                    try {
                        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    } catch {
                        finish(() => fail('Площадка ответила некорректно. Повторите установку.'));
                        return;
                    }
                    if (typeof parsed.path !== 'string' || !hostedMcpPath(parsed.path)) {
                        finish(() => fail('Площадка выдала некорректный канал хоста. Повторите установку.'));
                        return;
                    }
                    const managed = parsed.path;
                    finish(() => resolve(managed));
                });
                response.on('error', () => finish(() => fail('Соединение с хостом MCP прервано.')));
            },
        );
        const timer = setTimeout(() => fail('Хост MCP не ответил вовремя. Повторите установку.'), 20000);
        timer.unref();
        request.setTimeout(20000, () => fail('Хост MCP не ответил вовремя. Повторите установку.'));
        request.on('error', () => {
            clearTimeout(timer);
            reject(new Error('Хост MCP недоступен. Проверьте подключение и повторите установку.'));
        });
        request.write(body);
        request.end();
    });
}
