import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ownedTestPostgresAdmin } from './owned-postgres.fixture.mjs';

/**
 * PG-счётчики pairing-окон (AD-6, entry 2.9): общий для всех реплик gateway
 * лимит device-channel pairing — 15 start/адрес/мин, 6000 poll/адрес/мин,
 * 60 poll/код/мин. Fail-closed (AD-19): PG-сбой или отсутствие URL — 503,
 * passthrough запрещён.
 *
 * Тесты прогоняются на собственном PostgreSQL (fixture owned-postgres):
 *   CATALOG_TEST_PG_URL=postgresql://postgres:***@127.0.0.1:55432/postgres \
 *     node --test --test-concurrency=1 scripts/test/rate-limit-pg.test.mjs
 * Без переменной сьют честно пропускается. Требует свежих сборок
 * services/api-gateway и services/catalog-service (dist).
 */
const ADMIN_URL = process.env.CATALOG_TEST_PG_URL;

if (ADMIN_URL) {
    const gatewayRequire = createRequire(new URL('../../services/api-gateway/package.json', import.meta.url));
    const { ProxyService } = gatewayRequire('./dist/proxy/proxy.service.js');
    const pg = gatewayRequire('pg');
    const catalogRequire = createRequire(new URL('../../services/catalog-service/package.json', import.meta.url));
    const { RATE_LIMIT_WINDOWS_SCHEMA_SQL } = catalogRequire('./dist/rate-limit-windows/rate-limit-windows.schema.js');
    const { defaultFeatureFlags } = gatewayRequire('../../services/shared/feature-flags.cjs');

    const admin = ownedTestPostgresAdmin(ADMIN_URL);
    const dbName = 'rate_limit_pg_test_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const testUrl = new URL(ADMIN_URL);
    testUrl.pathname = '/' + dbName;

    /** Раз в минуту окно сдвигается (date_trunc('minute', now())) — сценарий перезапускаем. */
    const WINDOW_ROLLED = new Error('pairing-окно сдвинулось во время сценария');
    async function withWindowRetry(scenario) {
        for (let attempt = 0; ; attempt++) {
            const startMinute = new Date().getUTCMinutes();
            const guard = (label) => {
                if (new Date().getUTCMinutes() !== startMinute) {
                    const error = new Error('window rolled: ' + label);
                    error.windowRolled = true;
                    throw error;
                }
            };
            try {
                return await scenario(guard);
            } catch (error) {
                if (error.windowRolled && attempt === 0) continue;
                throw error;
            }
        }
    }

    const proxies = [];
    const response = () => ({
        statusCode: 0,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        },
        setHeader() {},
    });
    /** Реплика gateway: общий PG-URL, заглушки auth/live, http-ответ 201 как у каталога. */
    function makeProxy(pgUrl) {
        const env = pgUrl === undefined ? {} : { CATALOG_PG_URL: pgUrl };
        const proxy = new ProxyService(
            { get: (key) => env[key] },
            { authenticate: async () => null },
            {},
        );
        const flags = defaultFeatureFlags();
        proxy.http = {
            post: async () => ({ status: 201, data: { state: 'pending' } }),
            get: async () => ({ status: 200, data: { flags } }),
        };
        proxies.push(proxy);
        return proxy;
    }
    const request = (proxy, path, body, address) => {
        const res = response();
        return proxy
            .forward({ method: 'POST', path, headers: {}, socket: { remoteAddress: address }, body }, res)
            .then(() => res);
    };
    const call = async (proxy, suffix, address, body) => {
        const res = await request(proxy, '/api/device-channel/' + suffix, body, address);
        return { status: res.statusCode, body: res.body };
    };

    before(async () => {
        const adminClient = new pg.Client({ connectionString: ADMIN_URL });
        await adminClient.connect();
        try {
            await adminClient.query(`CREATE DATABASE ${dbName}`);
        } finally {
            await adminClient.end();
        }
        const setup = new pg.Client({ connectionString: testUrl.toString() });
        await setup.connect();
        try {
            await setup.query(RATE_LIMIT_WINDOWS_SCHEMA_SQL);
        } finally {
            await setup.end();
        }
    });
    after(async () => {
        for (const proxy of proxies) {
            if (proxy.rateLimitStore) await proxy.rateLimitStore.close();
        }
        const adminClient = new pg.Client({ connectionString: ADMIN_URL });
        await adminClient.connect();
        try {
            await adminClient.query(`DROP DATABASE IF EXISTS ${dbName}`);
        } finally {
            await adminClient.end();
        }
    });

    test('pair/start: 15/мин на адрес — общий для двух реплик gateway', async () => {
        await withWindowRetry(async (guard) => {
            const [a, b] = [makeProxy(testUrl.toString()), makeProxy(testUrl.toString())];
            const address = '10.1.1.1';
            for (let i = 0; i < 15; i++) {
                guard('start ' + i);
                const res = await call(i % 2 ? a : b, 'pair/start', address);
                assert.equal(res.status, 201, `старт ${i + 1}/15 обязан пройти`);
            }
            guard('start 16');
            const blocked = await call(b, 'pair/start', address);
            assert.equal(blocked.status, 429);
            assert.equal(blocked.body.message, 'Слишком много попыток подключения. Повторите через минуту.');
            // Чужой адрес — своё окно, не исчерпан чужим прокси-адресом.
            guard('start other');
            const other = await call(a, 'pair/start', '10.1.1.2');
            assert.equal(other.status, 201);
        });
    });

    test('pair/poll: 60/мин на код — чужой код не исчерпывает окно', async () => {
        await withWindowRetry(async (guard) => {
            const proxy = makeProxy(testUrl.toString());
            const address = '10.1.1.1';
            const codeA = 'a'.repeat(64);
            for (let i = 0; i < 60; i++) {
                guard('poll ' + i);
                const res = await call(proxy, 'pair/poll', address, { deviceCode: codeA });
                assert.equal(res.status, 201, `poll ${i + 1}/60 обязан пройти`);
            }
            guard('poll 61');
            const blocked = await call(proxy, 'pair/poll', address, { deviceCode: codeA });
            assert.equal(blocked.status, 429);
            assert.equal(blocked.body.message, 'Слишком много попыток подключения. Повторите через минуту.');
            guard('poll other-code');
            const other = await call(proxy, 'pair/poll', address, { deviceCode: 'b'.repeat(64) });
            assert.equal(other.status, 201, 'другой код — своё per-code окно');
        });
    });

    test('pair/poll: 6000/мин на адрес — перебор кодов упирается в адресный предел', async () => {
        await withWindowRetry(async (guard) => {
            const proxy = makeProxy(testUrl.toString());
            const address = '10.1.1.3';
            for (let i = 0; i < 6000; i++) {
                guard('poll ' + i);
                const code = (i + 1).toString(16).padStart(64, '0');
                const res = await call(proxy, 'pair/poll', address, { deviceCode: code });
                assert.equal(res.status, 201, `poll ${i + 1}/6000 обязан пройти`);
            }
            guard('poll 6001');
            const blocked = await call(proxy, 'pair/poll', address, { deviceCode: 'f'.repeat(64) });
            assert.equal(blocked.status, 429, 'адресное окно 6000/мин исчерпано');
        });
    });

    test('401 за некорректный код — до записи в PG-окно', async () => {
        const proxy = makeProxy(testUrl.toString());
        const before = await (async () => {
            const client = new pg.Client({ connectionString: testUrl.toString() });
            await client.connect();
            try {
                return (await client.query('SELECT count(*)::int AS n FROM rate_limit_windows WHERE scope = $1', ['pair-poll-code'])).rows[0].n;
            } finally {
                await client.end();
            }
        })();
        for (const code of ['short', 'g'.repeat(64), '']) {
            const res = await call(proxy, 'pair/poll', '10.1.1.9', { deviceCode: code });
            assert.equal(res.status, 401, `код ${JSON.stringify(code)} отклонён до записи`);
        }
        const after = await (async () => {
            const client = new pg.Client({ connectionString: testUrl.toString() });
            await client.connect();
            try {
                return (await client.query('SELECT count(*)::int AS n FROM rate_limit_windows WHERE scope = $1', ['pair-poll-code'])).rows[0].n;
            } finally {
                await client.end();
            }
        })();
        assert.equal(after, before, 'некорректный код не создаёт строк pair-poll-code');
    });

    test('Fail-closed: PG недоступен — 503 фиксированным сообщением, без passthrough', async () => {
        const proxy = makeProxy('postgresql://user:***@127.0.0.1:1/catalog');
        let upstreamCalled = false;
        proxy.http.post = async () => {
            upstreamCalled = true;
            return { status: 201, data: { state: 'pending' } };
        };
        const res = await call(proxy, 'pair/poll', '10.1.1.5', { deviceCode: 'a'.repeat(64) });
        assert.equal(res.status, 503);
        assert.equal(res.body.message, 'Не удалось проверить частоты подключений. Повторите позже.');
        assert.equal(upstreamCalled, false, 'passthrough запрещён: upstream не должен вызываться');
    });

    test('Fail-closed: CATALOG_PG_URL не задан — 503, без passthrough', async () => {
        const proxy = makeProxy(undefined);
        let upstreamCalled = false;
        proxy.http.post = async () => {
            upstreamCalled = true;
            return { status: 201, data: { state: 'pending' } };
        };
        const res = await call(proxy, 'pair/start', '10.1.1.6');
        assert.equal(res.status, 503);
        assert.equal(res.body.message, 'Не удалось проверить частоты подключений. Повторите позже.');
        assert.equal(upstreamCalled, false, 'passthrough запрещён: upstream не должен вызываться');
    });
} else {
    test('PG pairing-окна: пропуск (CATALOG_TEST_PG_URL не задан)', { skip: true }, () => {});
}
