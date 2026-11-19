// Completeness метрик (AD-O3): явный список 6 app-сервисов = scrape targets prometheus.yml,
// канонический набор на каждом /metrics, гейтинг capacity/machine по CAPACITY_REQUIRED,
// счётчик auth-failures и compat validateSnapshot. Новый сервис без targets-строки = фэйл.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { readFile, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { load as loadYaml } from 'js-yaml';
import { createObservability, recordAuthFailure } from '../../services/shared/observability.cjs';
import {
    renderCapacityMetrics,
    validateSnapshot,
    resources,
    reserveBytes,
    recordCapacityQueue,
} from '../../services/shared/capacity.cjs';
import { collectMachine } from '../../services/shared/capacity-collector.cjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const PROMETHEUS = path.join(root, 'deploy/production/monitoring/prometheus.yml');

// Явный список 6 app-сервисов / metrics — знаменатель completeness. Сюда НЕ входят
// capacity-collector (snapshot.json, не HTTP), frontend/nginx (/metrics 404), postgres,
// prometheus/alertmanager (entry 12): они не отдают канон через /metrics.
const EXPECTED_TARGETS = [
    'oauth2-bridge:22222',
    'api-gateway:4000',
    'catalog-service:4100',
    'skills-service:4200',
    'rag-sync-service:4300',
    'feature-flags-service:4400',
];
const EXPECTED_SERVICES = EXPECTED_TARGETS.map((target) => target.split(':')[0]).sort();
const CAPACITY_REQUIRED = new Set(['catalog-service', 'skills-service', 'rag-sync-service']);

async function neurocenterTargets() {
    const yaml = loadYaml(await readFile(PROMETHEUS, 'utf8'));
    const job = yaml.scrape_configs.find((entry) => entry.job_name === 'neurocenter');
    assert.ok(job, 'в prometheus.yml нет job_name "neurocenter" (AD-O3)');
    assert.equal(job.metrics_path, '/metrics');
    const targets = job.static_configs.flatMap((staticConfig) => staticConfig.targets || []);
    return targets;
}

/** Поднимает HTTP-фикстуру сервиса, прогоняет пару запросов и возвращает текст /metrics. */
async function metricsFor(service, { token = 'fixture-only' } = {}) {
    const metrics = createObservability({ service, token: () => token });
    const server = http.createServer((req, res) =>
        metrics.middleware(req, res, () => {
            res.statusCode = 200;
            res.end('ok');
        }),
    );
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + server.address().port;
    try {
        await fetch(base + '/api/projects/some-project');
        await fetch(base + '/auth/callback?code=private-code');
        const response = await fetch(base + '/metrics', { headers: { 'x-neurocenter-metrics': token } });
        assert.equal(response.status, 200);
        return await response.text();
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

function fakeSnapshot() {
    return {
        schemaVersion: 2,
        observedAt: Date.now(),
        resources: Object.fromEntries(
            resources.map((key) => [
                key,
                { available: true, filesystem: '1', totalBytes: reserveBytes * 4, freeBytes: reserveBytes + 1024 },
            ]),
        ),
        machine: { ramTotalBytes: 16 * 1024 ** 3, ramAvailableBytes: 8 * 1024 ** 3, cpuCores: 8, cpuUtilization: 0.25 },
    };
}

test('Completeness: prometheus.yml содержит ровно 6/6 app-сервисов в scrape targets, включая ff:4400', async () => {
    const targets = await neurocenterTargets();
    assert.deepEqual([...targets].sort(), [...EXPECTED_TARGETS].sort());
    assert.ok(targets.includes('feature-flags-service:4400'), 'ff:4400 отсутствует в scrape targets (known defect)');
    assert.equal(new Set(targets).size, 6, 'дубликаты targets недопустимы (completeness)');
    // Каждый user-facing пары host:port маппится в известный app-сервис.
    const hostnames = targets.map((target) => target.split(':')[0]).sort();
    assert.deepEqual(hostnames, EXPECTED_SERVICES);
    // Знаменатель completeness НЕ включает не-HTTP/внешние/self-scrape компоненты (AD-O3).
    for (const excluded of [
        'capacity-collector', // snapshot.json, не /metrics
        'frontend',
        'nginx',
        'postgres',
        'prometheus',
        'alertmanager',
    ])
        assert.equal(hostnames.includes(excluded), false, `«${excluded}» не должен быть scrape-target'ом`);
});

test('Completeness: новый сервис без targets-строки и без метрик — фэйл', async () => {
    const targets = await neurocenterTargets();
    const hostnames = new Set(targets.map((target) => target.split(':')[0]));
    // Гипотетический «тихо добавленный» 7-й сервис не покрыт scrape targets → completeness нарушена.
    assert.equal(hostnames.has('example-service'), false);
    // И неизвестное имя не проходит даже регистрацию наблюдаемости.
    assert.throws(() => createObservability({ service: 'example-service' }), /Неизвестный/);
    // Явный список защищён от «тихого» расширения: любые лишние targets — тоже фэйл.
    assert.deepEqual(new Set(EXPECTED_SERVICES), new Set(hostnames));
});

for (const service of EXPECTED_SERVICES) {
    test(`Completeness: /metrics сервиса ${service} отдаёт канонический набор (http+process+auth)`, async () => {
        const text = await metricsFor(service);
        assert.match(text, /# HELP neurocenter_http_requests_total/);
        assert.match(text, new RegExp('# HELP neurocenter_http_request_duration_seconds'));
        assert.match(
            text,
            new RegExp(`neurocenter_http_request_duration_seconds_count\\{service="${service}",method="GET",group="api"\\}`),
        );
        assert.match(text, new RegExp(`neurocenter_http_in_flight\\{service="${service}"\\}`));
        assert.match(text, new RegExp(`neurocenter_process_uptime_seconds\\{service="${service}"\\}`));
        assert.match(text, new RegExp(`neurocenter_process_resident_memory_bytes\\{service="${service}"\\}`));
        assert.match(text, new RegExp(`neurocenter_process_heap_used_bytes\\{service="${service}"\\}`));
        assert.match(text, new RegExp(`neurocenter_process_cpu_seconds_total\\{service="${service}"\\}`));
        assert.match(text, new RegExp(`neurocenter_auth_failures_total\\{service="${service}"\\}`));
        // Метки — только фиксированные groups: email/ID/URL/арбитральные маршруты не попадают.
        assert.equal(text.includes('group="metrics"'), false);
        assert.equal(/some-project|private-code|fixture-only/.test(text), false);
    });
}

test('Completeness: гейтинг capacity/machine по CAPACITY_REQUIRED (catalog/skills/rag=true, остальные=false)', () => {
    const previous = process.env.CAPACITY_REQUIRED;
    const machineLines = ['neurocenter_machine_ram_total_bytes', 'neurocenter_machine_ram_available_bytes',
        'neurocenter_machine_cpu_cores', 'neurocenter_machine_cpu_utilization'];
    try {
        for (const service of EXPECTED_TARGETS.map((target) => target.split(':')[0])) {
            process.env.CAPACITY_REQUIRED = CAPACITY_REQUIRED.has(service) ? 'true' : 'false';
            const rendered = renderCapacityMetrics(fakeSnapshot());
            const hasCapacity = /neurocenter_capacity_(?:snapshot_available|free_bytes)/.test(rendered);
            const hasMachine = machineLines.every((line) => rendered.includes(line));
            // AD-O3/AD-18: capacity + machine только у CAPACITY_REQUIRED=true.
            assert.equal(hasCapacity, CAPACITY_REQUIRED.has(service), `capacity у ${service}`);
            assert.equal(hasMachine, CAPACITY_REQUIRED.has(service), `machine у ${service}`);
        }
    } finally {
        process.env.CAPACITY_REQUIRED = previous;
    }
});

test('Completeness: capacity-метрики не рендерятся в /metrics у CAPACITY_REQUIRED=false (gateway)', async () => {
    const previous = process.env.CAPACITY_REQUIRED;
    try {
        process.env.CAPACITY_REQUIRED = 'false';
        const text = await metricsFor('api-gateway');
        assert.equal(/neurocenter_capacity_|neurocenter_machine_/.test(text), false);
    } finally {
        process.env.CAPACITY_REQUIRED = previous;
    }
});

test('Auth-failure: счётчик `neurocenter_auth_failures_total` растёт на отказе auth и не раскрывает причину', () => {
    const metrics = createObservability({ service: 'api-gateway' });
    assert.match(metrics.render(), /neurocenter_auth_failures_total\{service="api-gateway"\} 0/);
    metrics.recordAuthFailure();
    assert.match(metrics.render(), /neurocenter_auth_failures_total\{service="api-gateway"\} 1/);
    recordAuthFailure('api-gateway'); // общий доступ сервисов без ссылки на экземпляр
    recordAuthFailure('oauth2-bridge');
    assert.match(metrics.render(), /neurocenter_auth_failures_total\{service="api-gateway"\} 2/);
    const rendered = metrics.render();
    assert.equal(/reason=|message=|token/i.test(rendered), false);
});

test('Machine: коллектор публикует `machine` (RAM/CPU) из /proc; cpuUtilization появляется со второго тика', async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nc-machine-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const meminfo = path.join(directory, 'meminfo');
    const stat1 = path.join(directory, 'stat1');
    const stat2 = path.join(directory, 'stat2');
    await writeFile(
        meminfo,
        'MemTotal:       16777216 kB\nMemFree:        4194304 kB\nMemAvailable:    8388608 kB\nBuffers:        1024 kB\nCached:         1048576 kB\n',
    );
    // Два последовательных /proc/stat с разным объёмом idle → дельта даёт утилизацию в [0,1].
    await writeFile(stat1, 'cpu  100 0 100 800 50 0 0 0 0 0\n');
    await writeFile(stat2, 'cpu  400 0 200 900 50 0 0 0 0 0\n');

    const first = await collectMachine({ meminfoPath: meminfo, statPath: stat1 });
    assert.equal(first.ramTotalBytes, 16777216 * 1024);
    assert.equal(first.ramAvailableBytes, 8388608 * 1024);
    assert.ok(Number.isInteger(first.cpuCores) && first.cpuCores >= 1);
    assert.equal(first.cpuUtilization, undefined, 'первый тик — нет данных (omit), а не 0');

    const second = await collectMachine({ meminfoPath: meminfo, statPath: stat2 });
    assert.ok(Number.isFinite(second.cpuUtilization), 'второй тик — утилизация присутствует');
    assert.ok(second.cpuUtilization >= 0 && second.cpuUtilization <= 1, 'cpuUtilization ∈ [0,1]');
});

test('Machine: renderCapacityMetrics отдаёт machine-gauges только когда machine есть в снапшоте', () => {
    const previous = process.env.CAPACITY_REQUIRED;
    try {
        process.env.CAPACITY_REQUIRED = 'true';
        const withMachine = renderCapacityMetrics(fakeSnapshot());
        assert.match(withMachine, /# TYPE neurocenter_machine_ram_total_bytes gauge/);
        assert.match(withMachine, /neurocenter_machine_ram_total_bytes \d+/);
        assert.match(withMachine, /neurocenter_machine_ram_available_bytes \d+/);
        assert.match(withMachine, /# TYPE neurocenter_machine_cpu_cores gauge/);
        assert.match(withMachine, /# TYPE neurocenter_machine_cpu_utilization gauge/);
        assert.match(withMachine, /neurocenter_machine_cpu_utilization 0\.25/);
        // Первый тик (нет cpuUtilization) — gauge не рендерится, остальные machine-поля остаются.
        const firstTick = renderCapacityMetrics({ ...fakeSnapshot(), machine: { ramTotalBytes: 1, ramAvailableBytes: 1, cpuCores: 1 } });
        assert.equal(firstTick.includes('neurocenter_machine_cpu_utilization'), false);
        assert.match(firstTick, /neurocenter_machine_ram_total_bytes 1/);
    } finally {
        process.env.CAPACITY_REQUIRED = previous;
    }
});

test('Completeness: work-queue семьи отдаются там, где есть очередь (rag)', () => {
    const previous = process.env.CAPACITY_REQUIRED;
    try {
        process.env.CAPACITY_REQUIRED = 'true';
        recordCapacityQueue('rag', 3, 1);
        const rendered = renderCapacityMetrics(fakeSnapshot());
        assert.match(rendered, /neurocenter_work_queue_pending\{queue="rag"\} 3/);
        assert.match(rendered, /neurocenter_work_queue_active\{queue="rag"\} 1/);
    } finally {
        process.env.CAPACITY_REQUIRED = previous;
    }
});

test('Compat: старый снапшот без machine валиден (validateSnapshot не требует machine)', () => {
    const legacy = {
        schemaVersion: 1,
        observedAt: Date.now(),
        resources: Object.fromEntries(
            resources
                .filter((key) => key !== 'model-weights')
                .map((key) => [
                    key,
                    { available: true, filesystem: '1', totalBytes: reserveBytes * 4, freeBytes: reserveBytes + 1024 },
                ]),
        ),
    };
    assert.doesNotThrow(() => validateSnapshot(legacy, Date.now()));
    // Снапшот нового коллектора несёт machine и проходит тот же валидатор.
    assert.doesNotThrow(() => validateSnapshot(fakeSnapshot(), Date.now()));
});
