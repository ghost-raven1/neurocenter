/**
 * AD-OP-6 (epic-res-obs, entry 2): инвариансы ресурсной таблицы.
 *
 * Ресурсная таблица — это модель deploy/production/environment-model.json (единственный
 * машино-читаемый источник): её зеркальность compose сверяет drift-тест
 * (scripts/test/compose-drift.test.mjs, structuralDrift по каждому полю, включая pidsLimit
 * и user). Здесь — статические инвариансы самой модели (AD-OP-6(2)(3)):
 *   (a) каждый long-running сервис держит pids_limit (защита от форк-бомбы → OOM хоста);
 *   (b) каждый app-сервис (образ neurocenter/*) работает non-root: user задан и ≠ root —
 *       «0 сервисов root» среди app-сервисов; внешние образы (ollama, pgvector, prom/*)
 *       вне non-root-скоупа (6.1) — их user — фактический дефолт образа (external-note);
 *   (c) у всех сервисов задан mem_limit (таблица ресурсных ограничений полная);
 *   (d) ратифицированные значения не изменились: model-runtime 512 / capacity-collector 32 /
 *       feature-flags 128 / api-gateway 128 (AD-4) / background-agent 256 / node_exporter 64 /
 *       prometheus 512 / alertmanager 128 / postgres mem 1g;
 *   (e) one-shot setup-контейнеры (database-init, bootstrap-admin) тоже держат mem/pids
 *       (AD-OP-6 прямо называет их), но long-running-инвариант (a) на них не распространяется —
 *       классификация one-shot проверяется по compose (restart: 'no' + profile setup);
 *   (f) baseline pids_limit в x-service-якоре = 256 (OQ-1).
 *
 * Живая проверка (fork-стресс, PidsLimit в docker inspect) — final gate, не здесь.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MODEL_FILE, loadEnvironmentModel, parseComposeDocument } from '../production/environment-model.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

const ALL_SERVICES = [
    'model-runtime',
    'postgres',
    'capacity-collector',
    'database-init',
    'bootstrap-admin',
    'background-agent',
    'catalog-service',
    'feature-flags-service',
    'skills-service',
    'rag-sync-service',
    'oauth2-bridge',
    'api-gateway',
    'frontend',
    'node_exporter',
    'prometheus',
    'alertmanager',
];
/** one-shot: setup-профиль, restart 'no' — long-running-инвариант (a) на них не распространяется. */
const ONE_SHOT = new Set(['database-init', 'bootstrap-admin']);
/** App-сервисы — образы neurocenter/* (6.1: единый non-root uid 1000). 7 app + setup 2 + background-agent + capacity-collector. */
const APP_SERVICES = [
    'catalog-service',
    'feature-flags-service',
    'skills-service',
    'rag-sync-service',
    'oauth2-bridge',
    'api-gateway',
    'frontend',
    'database-init',
    'bootstrap-admin',
    'background-agent',
    'capacity-collector',
];
const LONG_RUNNING = ALL_SERVICES.filter((name) => !ONE_SHOT.has(name));
const ROOT_USERS = new Set(['0', 'root']);

const isPositiveInteger = (value) => Number.isInteger(value) && value >= 1;

test('каждый long-running сервис держит pids_limit (AD-OP-6: форк-бомба не роняет хост)', async (t) => {
    const model = await loadEnvironmentModel(root);
    assert.deepEqual(Object.keys(model.services).sort(), [...ALL_SERVICES].sort(), 'состав модели = 16 сервисов стека');
    for (const name of LONG_RUNNING) {
        const pids = model.services[name].pidsLimit;
        assert.ok(
            isPositiveInteger(pids),
            `${name}: pidsLimit обязан быть положительным целым, получено ${String(pids)}`,
        );
    }
});

test('app-сервисы работают non-root: user задан и ≠ root (0 сервисов root среди app-сервисов)', async (t) => {
    const model = await loadEnvironmentModel(root);
    for (const name of APP_SERVICES) {
        const user = model.services[name].user;
        assert.ok(
            typeof user === 'string' && user.length > 0,
            `${name}: user обязан быть задан в модели, получено ${String(user)}`,
        );
        assert.ok(!ROOT_USERS.has(user), `${name}: app-сервис обязан работать non-root, получено user=${user}`);
    }
});

test('у всех сервисов user и mem_limit заданы — ресурсная таблица полная', async (t) => {
    const model = await loadEnvironmentModel(root);
    for (const name of ALL_SERVICES) {
        const { user, memLimit } = model.services[name];
        assert.ok(
            typeof user === 'string' && user.length > 0,
            `${name}: user обязан быть задан, получено ${String(user)}`,
        );
        assert.ok(
            typeof memLimit === 'string' && memLimit.length > 0,
            `${name}: memLimit обязан быть задан, получено ${String(memLimit)}`,
        );
    }
});

test('ратифицированные значения не изменились (model 512 / capacity 32 / ff 128 / gateway 128 / bg-agent 256 / node_exporter 64 / prometheus 512 / alertmanager 128 / postgres mem 1g)', async (t) => {
    const model = await loadEnvironmentModel(root);
    const ratifiedPids = {
        'model-runtime': 512,
        'capacity-collector': 32,
        'feature-flags-service': 128,
        'api-gateway': 128,
        'background-agent': 256,
        node_exporter: 64,
        prometheus: 512,
        alertmanager: 128,
    };
    for (const [name, expected] of Object.entries(ratifiedPids)) {
        assert.equal(model.services[name].pidsLimit, expected, `${name}: ратифицированный pidsLimit ${expected}`);
    }
    assert.equal(model.services.postgres.memLimit, '1g', 'postgres: ратифицированный memLimit 1g');
});

test('one-shot setup-контейнеры держат mem/pids-лимиты (AD-OP-6), классификация — по compose', async (t) => {
    const model = await loadEnvironmentModel(root);
    for (const name of ONE_SHOT) {
        const { memLimit, pidsLimit } = model.services[name];
        assert.ok(typeof memLimit === 'string' && memLimit.length > 0, `${name}: memLimit обязан быть задан`);
        assert.ok(isPositiveInteger(pidsLimit), `${name}: pidsLimit обязан быть задан, получено ${String(pidsLimit)}`);
    }
    // Классификация one-shot подкреплена compose: ровно setup-сервисы несут restart 'no' + profile setup.
    const compose = parseComposeDocument(await fs.readFile(path.join(root, 'compose.production.yml'), 'utf8'));
    const noRestart = Object.entries(compose.services)
        .filter(([, service]) => service.restart === 'no')
        .map(([name]) => name)
        .sort();
    assert.deepEqual(noRestart, [...ONE_SHOT].sort(), 'restart: no обязаны носить только setup-сервисы');
    for (const name of ONE_SHOT) {
        assert.deepEqual(compose.services[name].profiles, ['setup'], `${name}: profile setup`);
    }
});

test('baseline pids_limit в x-service-якоре = 256 (OQ-1: запас против форк-бомбы при рабочем запасе PID)', async (t) => {
    const model = await loadEnvironmentModel(root);
    const compose = parseComposeDocument(await fs.readFile(path.join(root, model.compose.base), 'utf8'));
    assert.ok(compose['x-service'], 'якорь x-service обязан существовать');
    assert.equal(compose['x-service'].pids_limit, 256, 'baseline pids_limit якоря обязан быть 256');
});
