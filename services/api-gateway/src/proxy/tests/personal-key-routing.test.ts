import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const upstream = vi.hoisted(() => ({ post: vi.fn(async () => ({ status: 200, data: { ok: true } })) }));
vi.mock('axios', () => ({ default: { create: () => upstream } }));
import { ProxyService } from '../proxy.service';
function fixture(path: string, secure = true) {
    const auth = { authenticate: vi.fn(async () => ({ deviceId: 'owned-device', email: 'owner@example.test' })) };
    const service = new ProxyService(
        { get: () => undefined } as never,
        auth as never,
        { bridge: vi.fn(), sections: vi.fn() } as never,
    );
    const response = {
        code: 0,
        body: undefined as unknown,
        status: vi.fn(function (this: any, code: number) {
            this.code = code;
            return this;
        }),
        json: vi.fn(function (this: any, body: unknown) {
            this.body = body;
            return this;
        }),
        setHeader: vi.fn(),
    };
    const request = {
        method: 'POST',
        path: '/api/device-channel/' + path,
        headers: { authorization: 'Bearer synthetic-device', host: 'gateway.example' },
        body: { jobId: 'owned-job', apiKey: 'synthetic-private-key' },
        socket: { encrypted: secure, remoteAddress: '203.0.113.1' },
    };
    return { service, request, response, auth, run: () => service.forward(request as never, response as never) };
}
beforeEach(() => {
    upstream.post.mockReset();
    upstream.post.mockResolvedValue({ status: 200, data: { ok: true } });
});
afterEach(() => vi.unstubAllEnvs());
it.each(['context', 'save', 'receipt'])(
    'routes exactly the authenticated personal-key %s action without upstream redirects',
    async (action) => {
        const f = fixture('opencode-personal-key/' + action);
        await f.run();
        expect(f.response.code).toBe(200);
        expect(f.auth.authenticate).toHaveBeenCalledOnce();
        expect(upstream.post).toHaveBeenCalledWith(
            'http://localhost:4100/internal/device-channel/opencode-personal-key/' + action,
            f.request.body,
            expect.objectContaining({ maxRedirects: 0, proxy: false }),
        );
    },
);
it.each([
    'opencode-personal-key/save/extra',
    'opencode-personal-key/delete',
    'opencode-personal-key',
    'opencode-personal-keyish/save',
])('rejects neighboring route %s without forwarding secrets', async (route) => {
    const f = fixture(route);
    await f.run();
    expect(f.response.code).toBe(404);
    expect(upstream.post).not.toHaveBeenCalled();
    expect(JSON.stringify(f.response.body)).not.toContain('synthetic-private-key');
});
it('rejects untrusted cleartext and forged forwarded TLS before upstream transfer', async () => {
    const f = fixture('opencode-personal-key/save', false);
    Object.assign(f.request.headers, { 'x-forwarded-proto': 'https' });
    await f.run();
    expect(f.response.code).toBe(403);
    expect(upstream.post).not.toHaveBeenCalled();
});
it('sanitizes upstream transport failures containing private request material', async () => {
    const f = fixture('opencode-personal-key/save');
    upstream.post.mockRejectedValue(Error('synthetic-private-key'));
    await f.run();
    expect(f.response.code).toBe(502);
    expect(JSON.stringify(f.response.body)).not.toContain('synthetic-private-key');
});

for (const action of ['context', 'save', 'receipt']) {
    it.each([500, 307, 409])(
        `sanitizes resolved upstream %i for ${action} without forwarding body or headers`,
        async (status) => {
            const f = fixture('opencode-personal-key/' + action);
            upstream.post.mockResolvedValue({
                status,
                data: { message: 'synthetic-private-key', apiKey: 'synthetic-private-key' },
                headers: {
                    Location: 'https://private.example/synthetic-private-key',
                    'X-Private': 'synthetic-private-key',
                },
            } as never);
            await f.run();
            expect(f.response.code).toBe(status === 307 ? 502 : status);
            expect(f.response.body).toEqual({
                code: 'upstream-error',
                message: 'Перенос ключа не подтверждён. Проверьте сохранённую квитанцию перед повтором.',
            });
            expect(f.response.setHeader).not.toHaveBeenCalled();
            expect(JSON.stringify(f.response.body)).not.toContain('synthetic-private-key');
            expect(upstream.post).toHaveBeenCalledOnce();
        },
    );
}
