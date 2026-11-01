import http from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { personalKeyWire } from '../../src/features/opencode-personal-key/transport.js';
const servers: http.Server[] = [];
afterEach(async () => {
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    }
});
async function server(handler: http.RequestListener) {
    const value = http.createServer(handler);
    servers.push(value);
    await new Promise<void>((resolve) => value.listen(0, '127.0.0.1', resolve));
    return 'http://127.0.0.1:' + (value.address() as { port: number }).port;
}
it('does not follow a key-bearing redirect or expose secret-bearing error content', async () => {
    let forwarded = 0;
    const other = await server((_req, res) => {
        forwarded++;
        res.end('{}');
    });
    const origin = await server((_req, res) => {
        res.writeHead(307, { location: other });
        res.end('synthetic-secret-response');
    });
    await expect(
        personalKeyWire(origin, 'synthetic-device-token', 'save', { apiKey: 'synthetic-api-key' }),
    ).rejects.toThrow('Ответ сервера не подтверждён');
    expect(forwarded).toBe(0);
});
it('bounds public response bytes and rejects plaintext remote origins before transmission', async () => {
    const origin = await server((_req, res) => res.end('x'.repeat(65000)));
    await expect(personalKeyWire(origin, 'synthetic', 'receipt', {})).rejects.toThrow('Ответ сервера не подтверждён');
    await expect(personalKeyWire('http://remote.example.test', 'synthetic', 'save', {})).rejects.toThrow('HTTPS');
});
it('sends only the requested fixed endpoint with explicit device authorization', async () => {
    const requests: string[] = [];
    const origin = await server((req, res) => {
        requests.push(req.method + ' ' + req.url + ' ' + req.headers.authorization);
        res.end('{"receipt":null}');
    });
    expect(await personalKeyWire(origin, 'synthetic', 'receipt', { jobId: 'test' })).toEqual({ receipt: null });
    expect(requests).toEqual(['POST /api/device-channel/opencode-personal-key/receipt Bearer synthetic']);
});
