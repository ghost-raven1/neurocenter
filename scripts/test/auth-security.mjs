import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../services/oauth2-bridge/package.json', import.meta.url));
const { SessionService } = require('../../services/oauth2-bridge/dist/auth/session.service.js');
const { AuthController } = require('../../services/oauth2-bridge/dist/auth/auth.controller.js');
const { OAuthTransactions } = require('../../services/oauth2-bridge/dist/auth/oauth-transactions.service.js');
const { loginReturn } = require('../../services/oauth2-bridge/dist/auth/login-return.js');
const {
    browserSecurity,
    allowBrowserOrigin,
} = require('../../services/oauth2-bridge/dist/security/browser-security.js');
const { filterResponse } = require('../../services/api-gateway/dist/proxy/access-response.js');
/** Валидация входа как у каталога (createSessionInput): тест не должен принимать шире продакшена. */
const sessionText = (value, max) =>
    typeof value === 'string' && !!value.trim() && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
const assertSessionCreate = ({ tokenHash, identity, selectedRole, ttlSeconds }) => {
    const invalid = () => {
        throw new Error('Некорректные данные браузерной сессии.');
    };
    if (typeof tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(tokenHash)) invalid();
    if (
        !identity ||
        typeof identity !== 'object' ||
        Array.isArray(identity) ||
        Object.keys(identity).length !== 4 ||
        !sessionText(identity.id, 512) ||
        !sessionText(identity.principalName, 512) ||
        !sessionText(identity.email, 320) ||
        !sessionText(identity.displayName, 512) ||
        !/^[^\s@]+@[^\s@]+$/.test(identity.email) ||
        Buffer.byteLength(JSON.stringify(identity)) > 8192
    )
        invalid();
    if (!sessionText(selectedRole, 128)) invalid();
    if (typeof ttlSeconds !== 'number' || !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86400)
        invalid();
};
const memorySessionStore = () => {
    const rows = new Map();
    return {
        async create(input) {
            assertSessionCreate(input);
            const { tokenHash, identity, selectedRole, ttlSeconds } = input;
            rows.set(tokenHash, {
                identity,
                selectedRole,
                expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
            });
        },
        async find(hash) {
            const row = rows.get(hash);
            if (row && Date.parse(row.expiresAt) > Date.now())
                return { identity: row.identity, selectedRole: row.selectedRole, expiresAt: row.expiresAt };
            rows.delete(hash);
            return null;
        },
        async selectRole(hash, role) {
            const row = rows.get(hash);
            if (row && Date.parse(row.expiresAt) > Date.now()) {
                row.selectedRole = role;
                return true;
            }
            return false;
        },
        async revoke(hash) {
            rows.delete(hash);
        },
    };
};
const saved = process.env.SESSION_TTL_SECONDS;
afterEach(() => {
    if (saved === undefined) {
        delete process.env.SESSION_TTL_SECONDS;
    } else {
        process.env.SESSION_TTL_SECONDS = saved;
    }
});
const response = () => ({
    cookies: [],
    cleared: [],
    target: '',
    body: null,
    statusCode: 200,
    headers: {},
    cookie(name, value, options) {
        this.cookies.push({ name, value, options });
        return this;
    },
    clearCookie(name) {
        this.cleared.push(name);
        return this;
    },
    redirect(target) {
        this.target = target;
    },
    json(body) {
        this.body = body;
        return this;
    },
    status(code) {
        this.statusCode = code;
        return this;
    },
    setHeader(name, value) {
        this.headers[name] = value;
    },
});
const user = {
    id: 'blitz-qa',
    principalName: 'qa@example.test',
    email: 'qa@example.test',
    projectRoles: [],
    displayName: 'QA',
    userRoles: ['Разработчик'],
    activeRole: 'Разработчик',
    routePermissions: [],
};
const storedUser = {
    id: 'blitz-qa',
    principalName: 'qa@example.test',
    email: 'qa@example.test',
    displayName: 'QA',
    activeRole: 'Разработчик',
    userRoles: [],
    projectRoles: [],
    routePermissions: [],
};
test('Серверная сессия истекает даже при сохранённом клиентском cookie', async (t) => {
    process.env.SESSION_TTL_SECONDS = '60';
    const sessions = new SessionService(memorySessionStore());
    const original = Date.now;
    let now = 100000;
    t.mock.method(Date, 'now', () => now);
    const token = await sessions.create(user);
    assert.deepEqual(await sessions.get(token), storedUser);
    now += 60000;
    assert.equal(await sessions.get(token), null);
    assert.equal(await sessions.get(token), null);
    assert.ok(original() > 0);
});
test('Отзыв сессии немедленно закрывает последующие запросы', async () => {
    const sessions = new SessionService(memorySessionStore());
    const token = await sessions.create(user);
    await sessions.remove(token);
    assert.equal(await sessions.get(token), null);
});
for (const value of ['0', 'NaN', '-1', '9999999']) {
    test('Небезопасный срок сессии отклонён: ' + value, () => {
        process.env.SESSION_TTL_SECONDS = value;
        assert.throws(() => new SessionService());
    });
}
for (const value of [
    'https://attacker.example',
    '//attacker.example',
    '/\\attacker.example',
    '/unknown',
    '/projects\nbad',
    'javascript:alert(1)',
]) {
    test('Возврат после входа не перенаправляет на ' + JSON.stringify(value), () => {
        assert.equal(loginReturn(value), '/');
    });
}
test('Ссылка подключения сохраняется после входа целиком', () => {
    const target = '/start?step=1&connect=0123456789ABCDEF';
    assert.equal(loginReturn(target), target);
});
test('Mock-вход возвращает на подтверждение и ограничивает cookie', async () => {
    const controller = new AuthController(
        { ssoDisabled: true, panelUrl: 'http://localhost:5173', mockUser: async () => user },
        new SessionService(memorySessionStore()),
    );
    const res = response();
    await controller.login({ query: { returnTo: '/projects?connect=0123456789ABCDEF' } }, res);
    assert.equal(res.target, 'http://localhost:5173/projects?connect=0123456789ABCDEF');
    assert.equal(res.cookies[0].options.httpOnly, true);
    assert.equal(res.cookies[0].options.secure, false);
    assert.ok(res.cookies[0].options.maxAge > 0);
});
test('OAuth state переживает внешний SSO-переход и истекает через десять минут', async () => {
    const transactions = new OAuthTransactions();
    const controller = new AuthController(
        {
            ssoDisabled: false,
            panelUrl: 'https://panel.example',
            authorizeUrl: (state) => 'https://sso.example/login?state=' + state,
        },
        new SessionService(memorySessionStore()),
        transactions,
    );
    const res = response();
    await controller.login({ query: { returnTo: '/start?step=1&connect=0123456789ABCDEF' } }, res);
    const state = res.cookies.find((item) => item.name === 'oauth_state');
    assert.equal(state.options.sameSite, 'lax');
    assert.equal(state.options.secure, true);
    assert.equal(state.options.maxAge, 600000);
    assert.equal(transactions.consume(state.value, state.value).returnTo, '/start?step=1&connect=0123456789ABCDEF');
    assert.equal(res.cookies.length, 1);
});
test('Неверный state не обменивает код и не создаёт сессию', async () => {
    let exchanged = false;
    const controller = new AuthController(
        {
            ssoDisabled: false,
            panelUrl: 'https://panel.example',
            exchangeCode: async () => {
                exchanged = true;
            },
        },
        new SessionService(memorySessionStore()),
        new OAuthTransactions(),
    );
    const res = response();
    await controller.callback(
        { cookies: { oauth_state: 'correct' }, query: { state: 'wrong', code: 'not-used' } },
        res,
    );
    assert.equal(exchanged, false);
    assert.equal(res.cookies.length, 0);
    assert.ok(res.target.endsWith('login_error=state'));
});
test('Успешный callback возвращает к подключению и очищает одноразовые cookies', async () => {
    const transactions = new OAuthTransactions();
    const { state } = transactions.create('/start?step=1&connect=0123456789ABCDEF');
    const controller = new AuthController(
        { ssoDisabled: false, panelUrl: 'https://panel.example', exchangeCode: async () => user },
        new SessionService(memorySessionStore()),
        transactions,
    );
    const res = response();
    await controller.callback(
        { cookies: { oauth_state: state, oauth_return: 'https://attacker.example' }, query: { state, code: 'used' } },
        res,
    );
    assert.equal(res.target, 'https://panel.example/start?step=1&connect=0123456789ABCDEF');
    assert.deepEqual(res.cleared, ['oauth_state', 'oauth_return']);
    assert.equal(res.cookies[0].options.secure, true);
});
test('Защита cookie-запросов запрещает форму и пропускает собственный интерфейс', () => {
    for (const [custom, origin, status] of [
        ['', undefined, 403],
        ['1', 'https://attacker.example', 403],
        ['1', process.env.PANEL_URL || 'http://localhost:5173', 200],
    ]) {
        const res = response();
        let next = false;
        browserSecurity(
            {
                method: 'POST',
                path: '/auth/switch-role',
                headers: { cookie: 'bridge_session=test', 'x-neurocenter-request': custom, origin },
            },
            res,
            () => {
                next = true;
            },
        );
        assert.equal(res.statusCode, status);
        assert.equal(next, status === 200);
    }
    assert.equal(allowBrowserOrigin('null'), false);
    assert.equal(allowBrowserOrigin(undefined), true);
});
test('Bearer-запрос MCP сохраняет контракт без браузерного заголовка', () => {
    const res = response();
    let next = false;
    browserSecurity(
        { method: 'POST', path: '/api/device-channel/jobs/claim', headers: { authorization: 'Bearer test' } },
        res,
        () => {
            next = true;
        },
    );
    assert.equal(next, true);
});
test('Лишний Authorization не обходит защиту cookie-сессии входа', () => {
    const res = response();
    browserSecurity(
        {
            method: 'POST',
            path: '/auth/switch-role',
            headers: {
                cookie: 'bridge_session=test',
                authorization: 'Bearer ignored',
                origin: 'https://attacker.example',
            },
        },
        res,
        () => assert.fail('Запрос не должен проходить'),
    );
    assert.equal(res.statusCode, 403);
});
test('POST-выход отзывает серверный ключ и возвращает 200 вместо Nest default 201', async () => {
    const sessions = new SessionService(memorySessionStore());
    const token = await sessions.create(user);
    const controller = new AuthController({ ssoDisabled: true }, sessions);
    const res = response();
    res.statusCode = 201;
    await controller.logoutJson({ cookies: { bridge_session: token } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(await sessions.get(token), null);
    assert.deepEqual(res.body, {});
    assert.ok(res.cleared.includes('bridge_session'));
});
// Семантика PG rate-limit pairing (60/код/мин, 6000/адрес/мин, 15/адрес-старт/мин)
// покрыта scripts/test/rate-limit-pg.test.mjs (entry 2.9, AD-6).
test('Список скиллов и RAG не раскрывает чужие данные при старой коллизии имени и ID', () => {
    const claims = {
        email: 'qa@example.test',
        userRoles: ['Админ проекта'],
        projects: [{ projectId: 'prj-own', projectName: 'prj-foreign', role: 'Админ проекта' }],
        pluginIds: [],
        skillPaths: [],
    };
    assert.deepEqual(
        filterResponse([{ path: 'project-prj-foreign/private' }], claims, 'Админ проекта', '/api/skills'),
        [],
    );
    assert.deepEqual(
        filterResponse({ projects: [{ projectKey: 'prj-foreign' }] }, claims, 'Админ проекта', '/api/rag/projects'),
        { projects: [] },
    );
});
