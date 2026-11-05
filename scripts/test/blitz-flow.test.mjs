import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../services/oauth2-bridge/package.json', import.meta.url));
const { AuthService } = require('../../services/oauth2-bridge/dist/auth/auth.service.js');
const { AuthController } = require('../../services/oauth2-bridge/dist/auth/auth.controller.js');
const { SessionService } = require('../../services/oauth2-bridge/dist/auth/session.service.js');
const { CatalogSessionClient } = require('../../services/oauth2-bridge/dist/auth/catalog-session.client.js');
const { OAuthTransactions } = require('../../services/oauth2-bridge/dist/auth/oauth-transactions.service.js');
const SESSIONS_PATH = '/internal/browser-auth-sessions';
const INTERNAL_TOKEN = 'fixture-internal-token';
const hashOk = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const textOk = (value, max) =>
    typeof value === 'string' && !!value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
/** Контракты assertInternal и createSessionInput: mock отклоняет то же, что отклоняет каталог. */
const identityOk = (value) =>
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 4 &&
    textOk(value.id, 512) &&
    textOk(value.principalName, 512) &&
    textOk(value.email, 320) &&
    textOk(value.displayName, 512) &&
    /^[^\s@]+@[^\s@]+$/.test(value.email) &&
    Buffer.byteLength(JSON.stringify(value)) <= 8192;
const createOk = (value) =>
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 4 &&
    hashOk(value.tokenHash) &&
    identityOk(value.identity) &&
    textOk(value.selectedRole, 128) &&
    typeof value.ttlSeconds === 'number' &&
    Number.isSafeInteger(value.ttlSeconds) &&
    value.ttlSeconds >= 60 &&
    value.ttlSeconds <= 86400;
const roleOk = (value) =>
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    textOk(value.selectedRole, 128);
const internalOk = (req) => {
    const token = req.headers['x-neurocenter-internal'];
    return (
        typeof token === 'string' &&
        Buffer.byteLength(token) === Buffer.byteLength(INTERNAL_TOKEN) &&
        timingSafeEqual(Buffer.from(token), Buffer.from(INTERNAL_TOKEN))
    );
};
const memoryCatalogSessions = () => {
    const rows = new Map();
    return async (req, res, url) => {
        const rest = url.pathname.slice(SESSIONS_PATH.length);
        const readBody = async () => {
            let body = '';
            for await (const chunk of req) {
                body += chunk;
            }
            return JSON.parse(body);
        };
        if (!internalOk(req)) {
            res.statusCode = 403;
            res.end(JSON.stringify({ message: 'Запрос должен пройти через авторизованный шлюз.' }));
            return;
        }
        if (req.method === 'POST' && rest === '') {
            const input = await readBody();
            if (!createOk(input)) {
                res.statusCode = 400;
                res.end(JSON.stringify({ message: 'Некорректные данные браузерной сессии.' }));
                return;
            }
            rows.set(input.tokenHash, {
                identity: input.identity,
                selectedRole: input.selectedRole,
                expiresAt: new Date(Date.now() + input.ttlSeconds * 1000).toISOString(),
            });
            res.statusCode = 201;
            res.end(JSON.stringify({ created: true }));
            return;
        }
        const hash = rest.slice(1);
        if (!hashOk(hash)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ message: 'Некорректные данные браузерной сессии.' }));
            return;
        }
        if (req.method === 'GET') {
            const row = rows.get(hash);
            res.end(
                row && Date.parse(row.expiresAt) > Date.now()
                    ? JSON.stringify({ found: true, session: row })
                    : JSON.stringify({ found: false }),
            );
            return;
        }
        if (req.method === 'PATCH' && rest.endsWith('/selected-role')) {
            const input = await readBody();
            if (!roleOk(input)) {
                res.statusCode = 400;
                res.end(JSON.stringify({ message: 'Некорректные данные браузерной сессии.' }));
                return;
            }
            const row = rows.get(hash);
            const found = !!(row && Date.parse(row.expiresAt) > Date.now());
            if (found) row.selectedRole = input.selectedRole;
            res.end(JSON.stringify({ found }));
            return;
        }
        if (req.method === 'DELETE') {
            rows.delete(hash);
            res.end(JSON.stringify({ revoked: true }));
            return;
        }
        res.statusCode = 500;
        res.end('{}');
    };
};
const response = () => ({
    cookies: [],
    cleared: [],
    cookie(name, value, options) {
        this.cookies.push({ name, value, options });
    },
    clearCookie(name) {
        this.cleared.push(name);
    },
    redirect(target) {
        this.target = target;
    },
});

test('Blitz: authorize → token с PKCE → userinfo → роли каталога → Secure-сессия', async () => {
    let authorize;
    let exchanges = 0;
    let profile = { sub: 'blitz-user', email: 'ADMIN@EXAMPLE.TEST', email_verified: true, name: 'Администратор' };
    let token = 'fixture-token';
    let redirect = false;
    const sessionsHandler = memoryCatalogSessions();
    const server = createServer(async (req, res) => {
        const url = new URL(req.url, 'http://fixture');
        res.setHeader('Content-Type', 'application/json');
        if (url.pathname === '/blitz/oauth/te') {
            exchanges++;
            let body = '';
            for await (const chunk of req) {
                body += chunk;
            }
            const params = new URLSearchParams(body);
            assert.equal(
                req.headers.authorization,
                'Basic ' + Buffer.from('test-client:fixture-only').toString('base64'),
            );
            assert.equal(params.has('client_secret'), false);
            assert.equal(params.get('redirect_uri'), 'https://panel.example.test/auth/callback');
            assert.equal(
                createHash('sha256').update(params.get('code_verifier')).digest('base64url'),
                authorize.searchParams.get('code_challenge'),
            );
            if (redirect) {
                res.writeHead(302, { location: '/must-not-follow' });
                res.end();
                return;
            }
            res.end(JSON.stringify({ access_token: token }));
            return;
        }
        if (url.pathname === '/blitz/oauth/me') {
            assert.equal(req.headers.authorization, 'Bearer ' + token);
            res.end(JSON.stringify(profile));
            return;
        }
        if (url.pathname === '/internal/access/profile') {
            assert.equal(url.searchParams.get('email'), 'admin@example.test');
            res.end(JSON.stringify({ userRoles: ['Главный админ'], projects: [] }));
            return;
        }
        if (url.pathname.startsWith(SESSIONS_PATH)) {
            await sessionsHandler(req, res, url);
            return;
        }
        res.statusCode = 500;
        res.end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = 'http://127.0.0.1:' + server.address().port;
    const previous = process.env.CATALOG_SERVICE_URL,
        previousInternal = process.env.NEUROCENTER_INTERNAL_TOKEN;
    process.env.CATALOG_SERVICE_URL = address;
    process.env.NEUROCENTER_INTERNAL_TOKEN = INTERNAL_TOKEN;
    try {
        const config = {
            SSO_HOST: address,
            SSO_CLIENT_ID: 'test-client',
            SSO_CLIENT_SECRET: 'fixture-only',
            REDIRECT_URI: 'https://panel.example.test/auth/callback',
            PANEL_URL: 'https://panel.example.test',
            SSO_DISABLE: 'false',
        };
        const auth = new AuthService({ get: (key) => config[key] });
        const sessions = new SessionService(new CatalogSessionClient());
        const transactions = new OAuthTransactions();
        const controller = new AuthController(auth, sessions, transactions);
        const login = async () => {
            const result = response();
            await controller.login({ query: { returnTo: '/projects?connect=0123456789ABCDEF' } }, result);
            authorize = new URL(result.target);
            return result.cookies[0].value;
        };
        const state = await login();
        assert.equal(authorize.pathname, '/blitz/oauth/ae');
        assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
        assert.equal(authorize.searchParams.get('state'), state);
        const request = { cookies: { oauth_state: state }, query: { state, code: 'fixture-code' } };
        const result = response();
        await controller.callback(request, result);
        assert.equal(exchanges, 1);
        assert.equal(result.target, 'https://panel.example.test/projects?connect=0123456789ABCDEF');
        assert.equal(result.cookies[0].options.secure, true);
        assert.equal((await sessions.get(result.cookies[0].value)).activeRole, 'Главный админ');
        const replay = response();
        await controller.callback(request, replay);
        assert.equal(exchanges, 1);
        assert.equal(replay.cookies.length, 0);
        assert.ok(replay.target.endsWith('login_error=state'));
        for (const invalid of [
            { email: 'admin@example.test' },
            { sub: 'user', email: 'admin@example.test', email_verified: false },
            { sub: 'user', email: ['admin@example.test'] },
            { sub: { bad: true }, email: 'admin@example.test' },
        ]) {
            profile = invalid;
            const state = await login();
            const failure = response();
            await controller.callback(
                { cookies: { oauth_state: state }, query: { state, code: 'fixture-code' } },
                failure,
            );
            assert.equal(failure.cookies.length, 0);
            assert.ok(failure.target.endsWith('login_error=exchange'));
        }
        profile = { uid: 42, email: 'admin@example.test' };
        const numericState = await login();
        const numericResult = response();
        await controller.callback(
            { cookies: { oauth_state: numericState }, query: { state: numericState, code: 'fixture-code' } },
            numericResult,
        );
        assert.equal((await sessions.get(numericResult.cookies[0].value)).id, '42');
        for (const badToken of ['', {}, 'line\nbreak']) {
            token = badToken;
            const state = await login();
            const failure = response();
            await controller.callback(
                { cookies: { oauth_state: state }, query: { state, code: 'fixture-code' } },
                failure,
            );
            assert.equal(failure.cookies.length, 0);
        }
        token = 'fixture-token';
        redirect = true;
        const redirectState = await login();
        await assert.rejects(
            auth.exchangeCode('fixture-code', transactions.consume(redirectState, redirectState).verifier),
        );
    } finally {
        if (previous === undefined) {
            delete process.env.CATALOG_SERVICE_URL;
        } else {
            process.env.CATALOG_SERVICE_URL = previous;
        }
        if (previousInternal === undefined) {
            delete process.env.NEUROCENTER_INTERNAL_TOKEN;
        } else {
            process.env.NEUROCENTER_INTERNAL_TOKEN = previousInternal;
        }
        await new Promise((resolve) => server.close(resolve));
    }
});

test('Истёкшая и отклонённая SSO-транзакции не допускают повторного обмена', async (t) => {
    let now = 100000;
    t.mock.method(Date, 'now', () => now);
    const transactions = new OAuthTransactions();
    const expired = transactions.create('/audit');
    now += 600001;
    assert.equal(transactions.consume(expired.state, expired.state), null);
    assert.equal(transactions.consume(expired.state, expired.state), null);
    let exchanges = 0;
    const controller = new AuthController(
        {
            ssoDisabled: false,
            panelUrl: 'https://panel.example.test',
            exchangeCode: async () => {
                exchanges++;
            },
        },
        new SessionService({
            create: async () => {},
            find: async () => null,
            selectRole: async () => false,
            revoke: async () => {},
        }),
        transactions,
    );
    const { state } = transactions.create('/projects');
    const failure = response();
    await controller.callback({ cookies: { oauth_state: state }, query: { state, error: 'access_denied' } }, failure);
    assert.ok(failure.target.endsWith('login_error=denied'));
    assert.equal(exchanges, 0);
    assert.equal(transactions.consume(state, state), null);
});
