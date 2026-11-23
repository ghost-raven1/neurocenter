import { describe, expect, it, vi } from 'vitest';
import { AuthController } from '../auth.controller';
import type { IBridgeUser } from '../interface';

/**
 * P0-RES/AD-O7: security-события входа из oauth2-bridge.
 * login.success — actor/email = профиль; login.failure — только адрес и причина
 * (state/code в событие не попадают — AD-O8).
 */
const user: IBridgeUser = {
    id: 'u1',
    principalName: 'u1',
    email: 'u@local',
    projectRoles: [],
    displayName: 'U',
    userRoles: ['Главный админ'],
    activeRole: 'Главный админ',
    routePermissions: [],
};

function makeController(consume: () => unknown, exchange: () => Promise<IBridgeUser>) {
    const events: Array<Record<string, unknown>> = [];
    const auth = {
        panelUrl: 'http://panel.local',
        ssoDisabled: false,
        exchangeCode: exchange,
        authorizeUrl: () => 'http://sso/auth',
        logoutUrl: () => 'http://sso/logout',
        policies: () => [],
        refreshAccess: async () => undefined,
        applyRole: () => undefined,
        mockUser: async () => ({}),
    };
    const sessions = {
        ttlMs: 3_600_000,
        create: async () => 'tok',
        get: async () => null,
        remove: async () => undefined,
        selectRole: async () => true,
    };
    const transactions = { create: () => ({ state: 'st', challenge: 'ch' }), consume };
    const audit = { event: (e: Record<string, unknown>) => events.push(e) };
    const redirects: string[] = [];
    const controller = new AuthController(auth as never, sessions as never, transactions as never, audit as never);
    const res = {
        redirect: (to: string) => redirects.push(to),
        cookie: () => undefined,
        clearCookie: () => undefined,
        status: vi.fn(() => res),
        json: vi.fn(),
    };
    const req = { cookies: { oauth_state: 'st' }, query: { state: 'st', code: 'code-1' }, ip: '1.2.3.4' };
    return { controller, events, redirects, req, res };
}

describe('FR-903/AD-O7: login.success / login.failure security-события (oauth2-bridge)', () => {
    it('сбой state (consume → null) → login.failure reason=state, редирект на login_error', async () => {
        const { controller, events, redirects, req, res } = makeController(() => undefined, async () => user);
        await controller.callback(req as never, res as never);
        expect(redirects).toEqual(['http://panel.local/?login_error=state']);
        expect(events).toEqual([
            { actor: '1.2.3.4', action: 'login.failure', resourceId: 'login', before: null, after: { reason: 'state' } },
        ]);
    });

    it('отказ SSO (query.error) → login.failure reason=denied', async () => {
        const { controller, events, redirects, req, res } = makeController(() => ({ returnTo: '/', verifier: 'v' }), async () => user);
        (req as { query: Record<string, string> }).query.error = 'access_denied';
        await controller.callback(req as never, res as never);
        expect(redirects).toEqual(['http://panel.local/?login_error=denied']);
        expect(events).toEqual([
            { actor: '1.2.3.4', action: 'login.failure', resourceId: 'login', before: null, after: { reason: 'denied' } },
        ]);
    });

    it('битый code (exchange → ошибка) → login.failure reason=exchange; code в событие не идёт', async () => {
        const { controller, events, redirects, req, res } = makeController(
            () => ({ returnTo: '/', verifier: 'v' }),
            async () => {
                throw new Error('bad code');
            },
        );
        await controller.callback(req as never, res as never);
        expect(redirects).toEqual(['http://panel.local/?login_error=exchange']);
        expect(events).toHaveLength(1);
        const event = events[0]!;
        expect(event).toEqual({
            actor: '1.2.3.4',
            action: 'login.failure',
            resourceId: 'login',
            before: null,
            after: { reason: 'exchange' },
        });
        // AD-O8: ни code, ни верификатор в событии
        expect(JSON.stringify(events)).not.toContain('code-1');
    });

    it('успешный exchange → login.success (actor/email = профиль, after.role)', async () => {
        const { controller, events, redirects, req, res } = makeController(() => ({ returnTo: '/x', verifier: 'v' }), async () => user);
        await controller.callback(req as never, res as never);
        expect(redirects).toEqual(['http://panel.local/x']);
        expect(events).toEqual([
            { actor: 'u@local', action: 'login.success', resourceId: 'u@local', before: null, after: { role: 'Главный админ' } },
        ]);
    });
});
