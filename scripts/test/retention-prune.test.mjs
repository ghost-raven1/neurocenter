/**
 * AD-D3 (entry 5.8): retention prune — unit-контракты ядра и invariant FK-покрытия.
 *
 *  - TTL-литералы, загрузка retention-таблицы (fail-closed).
 *  - buildRetentionPlan: порядок, rag-часть, filesystem rolling-n, fail-closed на drift.
 *  - Invariant: каждая входящая NO ACTION-ссылка на prune-таблицу каталога покрыта
 *    CATALOG_PRUNE_ORDER (ребёнок раньше родителя) или CATALOG_PRUNE_GUARDS —
 *    выводится из DDL-исходников, новый ребёнок без решения не пройдёт.
 *  - pruneStatements: batched-CTE, два прохода web_restore_jobs, гарды.
 *  - FS-ядра на реальном tmpdir: skill-versions rolling-N, runtime-artifacts GC;
 *    сериализованные скрипты контейнеров исполняются и дают тот же результат.
 *  - runRetentionPrune: порядок, счётчики, изоляция ошибок per ресурс, RAG-down.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, utimes, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    CATALOG_PRUNE_GUARDS,
    CATALOG_PRUNE_ORDER,
    MAINTENANCE_PRUNE_LOCATION,
    RETENTION_BATCH_LIMIT,
    artifactDeleteStatement,
    buildRetentionPlan,
    loadRetentionTable,
    pruneStatements,
    runRetentionPrune,
    runtimeArtifactRemoveCore,
    runtimeArtifactRemoveScript,
    skillVersionsPruneCore,
    skillVersionsPruneScript,
    ttlToInterval,
    ttlToMs,
} from '../production/retention-prune.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const RETENTION_FILE = path.join(root, 'deploy/production/retention.json');
const retentionResources = JSON.parse(await readFile(RETENTION_FILE, 'utf8')).resources;
const story8Resources = retentionResources.filter((item) => item.pruneLocation === MAINTENANCE_PRUNE_LOCATION);

test('TTL-литералы: таблица → SQL interval и миллисекунды', () => {
    assert.equal(ttlToInterval('90d'), '90 days');
    assert.equal(ttlToInterval('30d'), '30 days');
    assert.equal(ttlToInterval('10m'), '10 minutes');
    assert.equal(ttlToInterval('5h'), '5 hours');
    assert.equal(ttlToMs('90d'), 90 * 86400000);
    assert.equal(ttlToMs('10m'), 10 * 60000);
    for (const bad of ['30s', 'd', '', '1.5d', '90 d']) {
        assert.throws(() => ttlToInterval(bad), /Некорректный TTL/);
        assert.throws(() => ttlToMs(bad), /Некорректный TTL/);
    }
});

test('Загрузка retention-таблицы: реальная таблица проходит, повреждённая — fail-closed', async () => {
    const resources = await loadRetentionTable(RETENTION_FILE);
    assert.equal(resources.length, 167);
    const directory = await mkdtemp(path.join(tmpdir(), 'nc-retention-'));
    try {
        const broken = [
            ['unknown schema', { schema: 'other', resources: [] }],
            ['empty resources', { schema: 'neurocenter-retention-v1', resources: [] }],
            [
                'ttl без колонки',
                {
                    schema: 'neurocenter-retention-v1',
                    resources: [{ resource: 'x', mode: 'ttl', ttl: '30d' }],
                },
            ],
            [
                'rolling-n без N',
                { schema: 'neurocenter-retention-v1', resources: [{ resource: 'y', mode: 'rolling-n' }] },
            ],
        ];
        for (const [name, value] of broken) {
            const file = path.join(directory, name.replace(/\W/g, '-') + '.json');
            await writeFile(file, JSON.stringify(value));
            await assert.rejects(() => loadRetentionTable(file), /retention|схему|список/i);
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('buildRetentionPlan: 27 catalog-таблиц в FK-порядке, rag-base и skill-versions', () => {
    // Полная retention-таблица: skill-versions имеет свой pruneLocation, не maintenance-тик.
    const plan = buildRetentionPlan(retentionResources);
    assert.equal(plan.catalog.length, 27);
    assert.deepEqual(
        plan.catalog.slice(0, 4).map((entry) => entry.table),
        ['bridge_instance_events', 'device_model_calls', 'bridge_local_change_plans', 'bridge_jobs'],
    );
    assert.equal(plan.catalog.find((entry) => entry.table === 'security_events').interval, '90 days');
    assert.equal(plan.catalog.find((entry) => entry.table === 'bridge_runtime_artifacts').artifacts, true);
    assert.ok(plan.catalog.every((entry) => entry.column && entry.interval));
    assert.deepEqual(
        plan.rag.map((entry) => entry.table),
        ['rag_platform_quota_events'],
    );
    assert.deepEqual(plan.skillVersions, {
        resource: 'skill-versions',
        path: '.neurocenter-skill-versions',
        rollingN: 2,
    });
});

test('buildRetentionPlan: таблица вне FK-порядка и чужой path останавливают план (fail-closed)', () => {
    const withNewTable = [
        ...story8Resources,
        {
            resource: 'fresh_table',
            db: 'catalog',
            kind: 'table',
            mode: 'ttl',
            ttl: '30d',
            timeColumn: 'created_at',
            pruneLocation: MAINTENANCE_PRUNE_LOCATION,
        },
    ];
    assert.throws(() => buildRetentionPlan(withNewTable), /вне зафиксированного FK-порядка/);
    const badPath = retentionResources.map((item) =>
        item.resource === 'skill-versions' ? { ...item, path: '/abs/escape' } : item,
    );
    assert.throws(() => buildRetentionPlan(badPath), /некорректный относительный path/);
    const badDb = story8Resources.map((item) =>
        item.resource === 'security_events' ? { ...item, db: 'rag-project' } : item,
    );
    assert.throws(() => buildRetentionPlan(badDb), /неизвестная БД/);
});

/** DDL-блоки с балансированием скобок (CHECK(...) внутри не рвёт разбор). */
function extractDdlBlocks(text) {
    const blocks = [];
    const re =
        /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[A-Za-z_][A-Za-z0-9_]*\s*\.\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi;
    let match;
    while ((match = re.exec(text))) {
        const open = re.lastIndex - 1;
        let index = open,
            depth = 0;
        for (; index < text.length; index += 1) {
            if (text[index] === '(') depth += 1;
            else if (text[index] === ')') {
                depth -= 1;
                if (depth === 0) break;
            }
        }
        blocks.push({ name: match[1], body: text.slice(open + 1, index) });
    }
    return blocks;
}

test('FK-инвариант: каждая входящая NO ACTION-ссылка на prune-таблицу покрыта порядком или гардом', () => {
    const story8Catalog = new Set(
        story8Resources.filter((item) => item.db === 'catalog').map((item) => item.resource.toLowerCase()),
    );
    const files = [];
    for (const service of readdirSync(path.join(root, 'services'))) {
        const src = path.join(root, 'services', service, 'src');
        if (!existsSync(src)) continue;
        for (const file of readdirSync(src, { recursive: true })) {
            if (/\.(ts|sql)$/.test(file)) files.push(path.join(src, file));
        }
    }
    const incoming = new Map();
    for (const file of files) {
        for (const block of extractDdlBlocks(readFileSync(file, 'utf8'))) {
            const ref =
                /REFERENCES\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*(ON\s+DELETE\s+(?:CASCADE|SET\s+NULL|RESTRICT|NO\s+ACTION|SET\s+DEFAULT))?/gi;
            let match;
            while ((match = ref.exec(block.body))) {
                const target = match[1].toLowerCase();
                if (!story8Catalog.has(target)) continue;
                const rule = (match[3] || '').toUpperCase();
                if (rule.includes('CASCADE')) continue;
                if (!incoming.has(target)) incoming.set(target, []);
                incoming.get(target).push({ child: block.name.toLowerCase(), rule, file: path.relative(root, file) });
            }
        }
    }
    const orderIndex = new Map(CATALOG_PRUNE_ORDER.map((table, index) => [table.toLowerCase(), index]));
    const uncovered = [];
    for (const [target, children] of incoming) {
        const parentIndex = orderIndex.get(target);
        const guard = (CATALOG_PRUNE_GUARDS[target] || '').toLowerCase();
        for (const child of children) {
            if (child.child === target) continue; // само-ссылка web_restore_jobs: два прохода pruneStatements
            const childInOrderEarlier = orderIndex.has(child.child) && orderIndex.get(child.child) < parentIndex;
            const guarded =
                child.child !== target && guard.includes(child.child) && new RegExp(child.child, 'i').test(guard);
            if (!childInOrderEarlier && !guarded)
                uncovered.push(`${target} <- ${child.child} (${child.rule}) ${child.file}`);
        }
    }
    assert.deepEqual(uncovered, [], 'входящие NO ACTION-ссылки без порядка/гарда:\n' + uncovered.join('\n'));
    // Обратное направление: порядок и гарды не содержат устаревших записей.
    for (const table of CATALOG_PRUNE_ORDER)
        assert.ok(story8Catalog.has(table), `порядок: ${table} вне retention-набора`);
    for (const table of Object.keys(CATALOG_PRUNE_GUARDS))
        assert.ok(story8Catalog.has(table), `гард: ${table} вне retention-набора`);
});

test('pruneStatements: batched-CTE, лимит, гарды, два прохода web_restore_jobs', () => {
    const plan = buildRetentionPlan(story8Resources);
    const security = plan.catalog.find((entry) => entry.table === 'security_events');
    const [statement] = pruneStatements(security);
    assert.ok(
        statement.startsWith(
            "WITH deleted AS (DELETE FROM security_events WHERE created_at < now() - interval '90 days'",
        ),
    );
    assert.ok(statement.includes(`LIMIT ${RETENTION_BATCH_LIMIT}`));
    assert.ok(statement.endsWith('RETURNING 1) SELECT count(*) FROM deleted;'));
    const guarded = plan.catalog.find((entry) => entry.table === 'agent_catalog_versions');
    assert.ok(pruneStatements(guarded)[0].includes('NOT EXISTS (SELECT 1 FROM project_agents'));
    const bridgeJobs = plan.catalog.find((entry) => entry.table === 'bridge_jobs');
    const jobsStatement = pruneStatements(bridgeJobs)[0];
    for (const table of [
        'bridge_instance_events',
        'device_model_calls',
        'bridge_local_change_plans',
        'project_chat_method_workflows',
        'bridge_hosted_rag_grants',
        'plugin_auto_update_policies',
    ])
        assert.ok(jobsStatement.includes('FROM ' + table), 'гард bridge_jobs: ' + table);
    assert.equal(pruneStatements(bridgeJobs).length, 1);
    const restore = plan.catalog.find((entry) => entry.table === 'web_restore_jobs');
    const [first, second] = pruneStatements(restore, 5);
    assert.equal(pruneStatements(restore).length, 2);
    assert.ok(first.includes('preview_id IS NOT NULL') && first.includes('LIMIT 5'));
    assert.ok(
        second.includes('NOT EXISTS (SELECT 1 FROM web_restore_jobs c WHERE c.preview_id = web_restore_jobs.id)'),
    );
    // Остальные таблицы — ровно один проход.
    for (const entry of plan.catalog) {
        if (entry.table !== 'web_restore_jobs') assert.equal(pruneStatements(entry).length, 1, entry.table);
    }
});

test('bridge_runtime_artifacts: DELETE возвращает sha256, existing-снимок отдельным SELECT', () => {
    const plan = buildRetentionPlan(story8Resources);
    const entry = plan.catalog.find((item) => item.table === 'bridge_runtime_artifacts');
    const statement = artifactDeleteStatement(entry, 7);
    assert.ok(
        statement.startsWith("DELETE FROM bridge_runtime_artifacts WHERE imported_at < now() - interval '30 days'"),
    );
    assert.ok(statement.includes('LIMIT 7'));
    assert.ok(statement.endsWith('RETURNING sha256;'));
});

test('skillVersionsPruneCore: rolling N per generation, числовой порядок версий, чужие имена не трогает', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nc-skill-versions-'));
    try {
        const generationA = path.join(directory, 'skilla', 'gena');
        const generationB = path.join(directory, 'skilla', 'genb');
        const generationC = path.join(directory, 'skillb', 'genc');
        for (const [target, versions] of [
            [generationA, [1, 2, 3, 4, 5]],
            [generationB, [1]],
            [generationC, [1, 9, 10, 11]],
        ]) {
            await mkdir(target, { recursive: true, mode: 0o700 });
            for (const version of versions)
                await writeFile(path.join(target, version + '.snapshot'), 'v' + version, { mode: 0o600 });
        }
        await writeFile(path.join(generationA, 'notes.txt'), 'not a snapshot');
        await writeFile(path.join(directory, 'stray.snapshot'), 'wrong level');
        await symlink(path.join(directory, 'skilla'), path.join(directory, 'link-a'));
        const result = await skillVersionsPruneCore(directory, 2);
        // gena: 1,2,3 + genc: 9,1 — числовой порядок 11 > 10 > 9 > 1 (строкой было бы 9,11).
        assert.equal(result.deleted, 5);
        assert.deepEqual((await readdir(generationA)).filter((name) => name.endsWith('.snapshot')).sort(), [
            '4.snapshot',
            '5.snapshot',
        ]);
        assert.deepEqual(
            (await readdir(generationB)).filter((name) => name.endsWith('.snapshot')),
            ['1.snapshot'],
        );
        assert.deepEqual((await readdir(generationC)).filter((name) => name.endsWith('.snapshot')).sort(), [
            '10.snapshot',
            '11.snapshot',
        ]);
        assert.ok((await readdir(generationA)).includes('notes.txt'));
        assert.ok((await readdir(directory)).includes('stray.snapshot'));
        // Повторный проход — 0 удалений (idempotent).
        assert.deepEqual(await skillVersionsPruneCore(directory, 2), { deleted: 0 });
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('skillVersionsPruneCore: нет корня — 0, некорректный N — отказ', async () => {
    assert.deepEqual(await skillVersionsPruneCore(path.join(tmpdir(), 'nc-missing-' + Date.now()), 2), { deleted: 0 });
    const directory = await mkdtemp(path.join(tmpdir(), 'nc-skill-versions-'));
    try {
        await assert.rejects(() => skillVersionsPruneCore(directory, 0), /целым положительным/);
        await assert.rejects(() => skillVersionsPruneCore(directory, 1.5), /целым положительным/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

test('runtimeArtifactRemoveCore: файл снятой строки, старый осиротевший, свежий и закреплённые не трогает', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nc-runtime-artifacts-'));
    try {
        const sha = (value) => value.repeat(64).slice(0, 64);
        const rows = sha('a'),
            reimported = sha('b'),
            orphanOld = sha('c'),
            orphanFresh = sha('d'),
            kept = sha('e');
        for (const value of [rows, reimported, orphanOld, orphanFresh, kept])
            await writeFile(path.join(directory, value + '.tar.gz'), 'x');
        await writeFile(path.join(directory, '.partial-' + rows), 'upload in progress');
        await writeFile(path.join(directory, 'README.md'), 'metadata');
        const oldTime = new Date(Date.now() - 40 * 86400000);
        await utimes(path.join(directory, orphanOld + '.tar.gz'), oldTime, oldTime);
        const result = await runtimeArtifactRemoveCore(directory, {
            deleted: [rows, reimported],
            existing: [reimported, kept],
            cutoffMs: Date.now() - 30 * 86400000,
        });
        assert.deepEqual(result, { rowFiles: 1, orphanFiles: 1, orphans: [orphanOld + '.tar.gz'] });
        const left = (await readdir(directory)).sort();
        assert.deepEqual(left, [
            '.partial-' + rows,
            'README.md',
            reimported + '.tar.gz',
            orphanFresh + '.tar.gz',
            kept + '.tar.gz',
        ]);
        // Повтор: больше нечего снимать.
        assert.deepEqual(
            await runtimeArtifactRemoveCore(directory, {
                deleted: [],
                existing: [reimported, kept],
                cutoffMs: Date.now() - 30 * 86400000,
            }),
            { rowFiles: 0, orphanFiles: 0, orphans: [] },
        );
        for (const bad of [{ existing: [], cutoffMs: 1 }, { deleted: [], cutoffMs: 'now' }, {}])
            await assert.rejects(() => runtimeArtifactRemoveCore(directory, bad), /Некорректная спецификация/);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

/** node -e <script>; input уходит в stdin — как `docker exec -i ... node -e <script>` в production. */
const nodeEval = (script, input) =>
    new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['-e', script], { encoding: 'utf8' });
        let stdout = '',
            stderr = '';
        child.stdout.on('data', (chunk) => (stdout += chunk));
        child.stderr.on('data', (chunk) => (stderr += chunk));
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(stderr || 'exit ' + code))));
        if (input !== undefined) child.stdin.write(input);
        child.stdin.end();
    });

test('Сериализованные скрипты контейнеров исполняются и дают тот же результат', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'nc-skill-versions-'));
    try {
        const generation = path.join(directory, 'sk', 'gen');
        await mkdir(generation, { recursive: true });
        for (const version of [1, 2, 3]) await writeFile(path.join(generation, version + '.snapshot'), 'v' + version);
        const skillResult = JSON.parse(await nodeEval(skillVersionsPruneScript(directory, 2)));
        assert.deepEqual(skillResult, { deleted: 1 });
        const artifacts = await mkdtemp(path.join(tmpdir(), 'nc-runtime-artifacts-'));
        try {
            const sha = 'f'.repeat(64);
            await writeFile(path.join(artifacts, sha + '.tar.gz'), 'x');
            const spec = JSON.stringify({ deleted: [sha], existing: [], cutoffMs: Date.now() - 30 * 86400000 });
            const artifactResult = JSON.parse(await nodeEval(runtimeArtifactRemoveScript(artifacts), spec));
            assert.deepEqual(artifactResult, { rowFiles: 1, orphanFiles: 0, orphans: [] });
        } finally {
            await rm(artifacts, { recursive: true, force: true });
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

const syntheticResources = [
    {
        resource: 'security_events',
        db: 'catalog',
        kind: 'table',
        mode: 'ttl',
        ttl: '90d',
        timeColumn: 'created_at',
        pruneLocation: MAINTENANCE_PRUNE_LOCATION,
    },
    {
        resource: 'ai_plugin_versions',
        db: 'catalog',
        kind: 'table',
        mode: 'ttl',
        ttl: '90d',
        timeColumn: 'created_at',
        pruneLocation: MAINTENANCE_PRUNE_LOCATION,
    },
    {
        resource: 'bridge_runtime_artifacts',
        db: 'catalog',
        kind: 'table',
        mode: 'ttl',
        ttl: '30d',
        timeColumn: 'imported_at',
        pruneLocation: MAINTENANCE_PRUNE_LOCATION,
    },
    {
        resource: 'rag_platform_quota_events',
        db: 'rag-base',
        kind: 'table',
        mode: 'ttl',
        ttl: '90d',
        timeColumn: 'created_at',
        pruneLocation: MAINTENANCE_PRUNE_LOCATION,
    },
    {
        resource: 'skill-versions',
        db: 'filesystem',
        kind: 'filesystem',
        mode: 'rolling-n',
        rollingN: 2,
        path: '.neurocenter-skill-versions',
        pruneLocation: 'server-side prune (story 8)',
    },
];

test('runRetentionPrune: порядок, счётчики, artifact-спецификация, изоляция ошибок per ресурс', async () => {
    const now = Date.now();
    const calls = [];
    const sha = (value) => value.repeat(64).slice(0, 64);
    const catalogQuery = async (statement) => {
        calls.push(['catalog', statement]);
        if (statement.includes('DELETE FROM bridge_runtime_artifacts')) return sha('1') + '\n' + sha('2');
        if (statement === 'SELECT sha256 FROM bridge_runtime_artifacts;') return sha('3');
        if (statement.includes('DELETE FROM ai_plugin_versions')) throw new Error('catalog failure');
        if (statement.includes('DELETE FROM security_events')) return '3';
        return '0';
    };
    const ragQuery = async (statement) => {
        calls.push(['rag', statement]);
        return '7';
    };
    const artifactCalls = [];
    const skillCalls = [];
    const logs = [];
    const report = await runRetentionPrune({
        resources: syntheticResources,
        catalogQuery,
        ragQuery,
        artifactStore: {
            remove: async (spec) => (
                artifactCalls.push(spec),
                { rowFiles: 2, orphanFiles: 1, orphans: [sha('9') + '.tar.gz'] }
            ),
        },
        skillsStore: { prune: async (value) => (skillCalls.push(value), { deleted: 4 }) },
        now: () => now,
        log: (message) => logs.push(message),
    });
    assert.deepEqual(
        report.resources.map((record) => record.resource),
        [
            'security_events',
            'ai_plugin_versions',
            'bridge_runtime_artifacts',
            'rag_platform_quota_events',
            'skill-versions',
        ],
    );
    assert.deepEqual(report.resources[0], { resource: 'security_events', deleted: 3 });
    assert.equal(report.resources[1].error, 'catalog failure');
    assert.ok(logs[0].startsWith('ai_plugin_versions: '));
    const artifacts = report.resources[2];
    assert.equal(artifacts.deleted, 2);
    assert.deepEqual(artifacts.files, { rowFiles: 2, orphanFiles: 1, orphans: [sha('9') + '.tar.gz'] });
    assert.deepEqual(artifactCalls, [
        { deleted: [sha('1'), sha('2')], existing: [sha('3')], cutoffMs: now - 30 * 86400000 },
    ]);
    assert.equal(report.resources[3].deleted, 7);
    assert.deepEqual(report.resources[4], { resource: 'skill-versions', deleted: 4 });
    assert.deepEqual(skillCalls, [{ path: '.neurocenter-skill-versions', rollingN: 2 }]);
    // catalog-вызовы раньше rag; artifact-строки раньше existing-снимка.
    const catalogTables = calls.filter(([db]) => db === 'catalog').map(([, statement]) => statement);
    assert.ok(
        catalogTables.findIndex((statement) => statement.includes('DELETE FROM security_events')) <
            catalogTables.findIndex((statement) => statement.includes('DELETE FROM bridge_runtime_artifacts')),
    );
    assert.ok(
        calls.findIndex(([, statement]) => statement === 'SELECT sha256 FROM bridge_runtime_artifacts;') >
            calls.findIndex(([, statement]) => statement.includes('DELETE FROM bridge_runtime_artifacts')),
    );
    // Все rag-вызовы — после всех catalog-вызовов (catalog-часть плана завершена до rag-части).
    const lastCatalog = calls.map(([db]) => db).lastIndexOf('catalog');
    const firstRag = calls.findIndex(([db]) => db === 'rag');
    assert.ok(lastCatalog >= 0 && firstRag > lastCatalog, 'catalog-вызовы должны предшествовать rag-вызовам');
});

test('runRetentionPrune: RAG-БД недоступна — catalog прошёл, ошибка изолирована, тик не падает', async () => {
    const report = await runRetentionPrune({
        resources: syntheticResources,
        catalogQuery: async () => '1',
        ragQuery: async () => {
            throw new Error('connection refused');
        },
        artifactStore: { remove: async () => ({ rowFiles: 0, orphanFiles: 0, orphans: [] }) },
        skillsStore: { prune: async () => ({ deleted: 0 }) },
    });
    assert.equal(report.resources.find((record) => record.resource === 'security_events').deleted, 1);
    assert.equal(
        report.resources.find((record) => record.resource === 'rag_platform_quota_events').error,
        'connection refused',
    );
});

test('runRetentionPrune: план останавливается на повреждённой таблице до выполнения удалений', async () => {
    const resources = [
        {
            resource: 'unknown_table',
            db: 'catalog',
            kind: 'table',
            mode: 'ttl',
            ttl: '30d',
            timeColumn: 'created_at',
            pruneLocation: MAINTENANCE_PRUNE_LOCATION,
        },
    ];
    let queried = 0;
    await assert.rejects(
        () =>
            runRetentionPrune({
                resources,
                catalogQuery: async () => {
                    queried += 1;
                    return '0';
                },
                ragQuery: async () => '0',
                artifactStore: { remove: async () => ({}) },
                skillsStore: { prune: async () => ({ deleted: 0 }) },
            }),
        /вне зафиксированного FK-порядка/,
    );
    assert.equal(queried, 0);
});
