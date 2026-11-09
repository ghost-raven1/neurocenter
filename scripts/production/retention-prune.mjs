/**
 * AD-D3 (entry 5.8): retention prune в maintenance tick.
 *
 * Таблица retention deploy/production/retention.json (entry 5.7) — единый источник:
 * ресурс → режим + TTL. Прунятся только ресурсы с pruneLocation
 * 'scripts/production/maintenance.mjs (story 8)'; project-scoped/none/manual — вне этого
 * прохода (story 11 / ручной режим). Значения TTL не дублируются в коде — читаются из таблицы.
 *
 * Порядок DELETE по FK (дети раньше родителей) и NOT EXISTS-гарды для детей, которые не
 * прунятся (ledgers/реестры с mode none/manual/project-scoped), зафиксированы в
 * CATALOG_PRUNE_ORDER и CATALOG_PRUNE_GUARDS — выведены из DDL каталога; порядок в записях
 * retention-таблицы (pruneLocation/reason «каскад с …») учитывается: ON DELETE CASCADE
 * ресурсы удаляются сами с родителем и в явном списке отсутствуют.
 *
 * Batched: один проход = не более batchLimit строк на таблицу (паттерн runnerLedger.prune);
 * остаток снимается следующим тиком. Ошибки изолированы per ресурс: один упавший ресурс не
 * роняет тик — счётчики/ошибки пишутся в maintenance_runs.receipt.retention.
 */
import { readdir, lstat, rm, readFile } from 'node:fs/promises';
import path from 'node:path';

export const MAINTENANCE_PRUNE_LOCATION = 'scripts/production/maintenance.mjs (story 8)';
export const RETENTION_BATCH_LIMIT = 1000;

/** '90d' → '90 days', '10m' → '10 minutes', '5h' → '5 hours' — литерал для SQL interval. */
export function ttlToInterval(ttl) {
    const match = /^(\d+)([dmh])$/.exec(ttl || '');
    if (!match) {
        throw new Error('Некорректный TTL retention-таблицы: ' + ttl);
    }
    return match[1] + ' ' + { d: 'days', m: 'minutes', h: 'hours' }[match[2]];
}

export function ttlToMs(ttl) {
    const match = /^(\d+)([dmh])$/.exec(ttl || '');
    if (!match) {
        throw new Error('Некорректный TTL retention-таблицы: ' + ttl);
    }
    return Number(match[1]) * { d: 86400000, m: 60000, h: 3600000 }[match[2]];
}

/** Загрузка и базовая валидация retention-таблицы (entry 5.7); fail-closed на неизвестную схему. */
export async function loadRetentionTable(file) {
    const table = JSON.parse(await readFile(file, 'utf8'));
    if (table?.schema !== 'neurocenter-retention-v1') {
        throw new Error('Неизвестная схема retention-таблицы');
    }
    if (!Array.isArray(table.resources) || table.resources.length === 0) {
        throw new Error('retention-таблица не содержит список ресурсов');
    }
    for (const item of table.resources) {
        if (item.mode === 'ttl' && (!item.ttl || !item.timeColumn)) {
            throw new Error('retention-таблица: ttl-ресурс без TTL/колонки: ' + item.resource);
        }
        if (item.mode === 'rolling-n' && (!Number.isInteger(item.rollingN) || item.rollingN < 1)) {
            throw new Error('retention-таблица: rolling-n без корректного rollingN: ' + item.resource);
        }
    }
    return table.resources;
}

/**
 * FK-порядок DELETE для catalog-таблиц: дети (NO ACTION-ссылки) раньше родителей.
 * Не входит в список — не прунится этим проходом:
 *  - bridge_job_requests, tool_build_agent_steps, tool_build_runtime_checks — ON DELETE CASCADE
 *    с родителем (5.7-таблица: «каскад с …»);
 *  - resource вне таблицы или с другим pruneLocation — не прунится (invariant story 7).
 * Новая таблица с pruneLocation maintenance tick обязана быть добавлена сюда (тест ловит).
 */
export const CATALOG_PRUNE_ORDER = [
    // дети bridge_jobs (NO ACTION) — до родителя; device_model_calls: 5.7 «prune вместе с bridge_jobs (FK job_id)»
    'bridge_instance_events',
    'device_model_calls',
    'bridge_local_change_plans',
    'bridge_jobs',
    'tool_build_jobs',
    // само-ссылка preview_id: restore-задачи сначала, потом непривязанные (два прохода)
    'web_restore_jobs',
    'security_events',
    'ai_plugin_versions',
    'bridge_runtime_artifacts',
    'bridge_source_checks',
    'asset_source_jobs',
    'asset_source_versions',
    'asset_source_snapshots',
    'legacy_retirement_previews',
    'asset_management_impacts',
    'browser_auth_sessions',
    'agent_catalog_versions',
    'maintenance_runs',
    'model_api_dispatch_slots',
    'model_catalog_versions',
    'model_hosting_jobs',
    'operation_action_requests',
    'model_gguf_uploads',
    'model_usage_calls',
    'skill_dependency_reservations',
    'retired_rag_previews',
    'tool_source_uploads',
];

/**
 * NOT EXISTS-гарды: любой ребёнок с NO ACTION блокирует удаление родителя. Сюда входят и дети
 * извне prune-набора (mode none/manual/project-scoped — story 11): родительская строка прунится,
 * только когда детей нет. Дети из prune-набора (bridge_instance_events и др.) стоят в порядке
 * раньше родителя и снимаются тем же тиком, если старые; свежие дети продолжают защищать родителя.
 * Полный набор выведен из DDL каталога: каждая входящая NO ACTION-ссылка на prune-таблицу
 * учтена (scripts/test/retention-prune.test.mjs: «входящие ссылки покрываются порядком или гардом»).
 */
export const CATALOG_PRUNE_GUARDS = {
    agent_catalog_versions:
        'NOT EXISTS (SELECT 1 FROM project_agents p WHERE (p.agent_id, p.version, p.manifest) = (agent_catalog_versions.agent_id, agent_catalog_versions.version, agent_catalog_versions.manifest))',
    legacy_retirement_previews:
        'NOT EXISTS (SELECT 1 FROM legacy_retirement_operations o WHERE o.id = legacy_retirement_previews.id)',
    asset_management_impacts:
        'NOT EXISTS (SELECT 1 FROM asset_management_operations o WHERE o.id = asset_management_impacts.id)',
    retired_rag_previews:
        'NOT EXISTS (SELECT 1 FROM retired_rag_purges r WHERE r.preview_id = retired_rag_previews.id)',
    bridge_jobs: [
        'NOT EXISTS (SELECT 1 FROM bridge_instance_events e WHERE e.id = bridge_jobs.id)',
        'NOT EXISTS (SELECT 1 FROM device_model_calls c WHERE c.job_id = bridge_jobs.id)',
        'NOT EXISTS (SELECT 1 FROM bridge_local_change_plans p WHERE p.preparation_job_id = bridge_jobs.id OR p.applied_job_id = bridge_jobs.id)',
        'NOT EXISTS (SELECT 1 FROM project_chat_method_workflows w WHERE w.job_id = bridge_jobs.id)',
        'NOT EXISTS (SELECT 1 FROM bridge_hosted_rag_grants g WHERE g.job_id = bridge_jobs.id)',
        'NOT EXISTS (SELECT 1 FROM plugin_auto_update_policies u WHERE u.job_id = bridge_jobs.id)',
    ].join(' AND '),
    model_gguf_uploads:
        'NOT EXISTS (SELECT 1 FROM model_gguf_runtime_intents i WHERE i.upload_id = model_gguf_uploads.id)',
};

/**
 * План прохода из retention-таблицы: catalog/rag — ttl-таблицы с pruneLocation maintenance tick
 * (порядок — CATALOG_PRUNE_ORDER), filesystem — rolling-n. Ресурс с maintenance-локацией вне
 * зафиксированного FK-порядка останавливает план: порядок обязан быть осознанным.
 */
export function buildRetentionPlan(resources) {
    const catalog = [];
    const rag = [];
    let skillVersions = null;
    for (const item of resources) {
        if (item.kind === 'table' && item.mode === 'ttl' && item.pruneLocation === MAINTENANCE_PRUNE_LOCATION) {
            const entry = {
                resource: item.resource,
                table: item.resource,
                column: item.timeColumn,
                ttl: item.ttl,
                interval: ttlToInterval(item.ttl),
                artifacts: item.resource === 'bridge_runtime_artifacts',
            };
            if (item.db === 'catalog') {
                catalog.push(entry);
            } else if (item.db === 'rag-base') {
                rag.push(entry);
            } else {
                throw new Error('retention-таблица: неизвестная БД ttl-ресурса: ' + item.resource);
            }
        } else if (item.kind === 'filesystem' && item.mode === 'rolling-n' && item.db === 'filesystem') {
            if (skillVersions) {
                throw new Error('retention-таблица: более одного filesystem rolling-n ресурса');
            }
            if (typeof item.path !== 'string' || !item.path || item.path.startsWith('/') || item.path.includes('..')) {
                throw new Error(
                    'retention-таблица: некорректный относительный path filesystem-ресурса: ' + item.resource,
                );
            }
            skillVersions = { resource: item.resource, path: item.path, rollingN: item.rollingN };
        }
    }
    const order = new Map(CATALOG_PRUNE_ORDER.map((table, index) => [table, index]));
    for (const entry of catalog) {
        if (!order.has(entry.table)) {
            throw new Error('Таблица ' + entry.table + ' вне зафиксированного FK-порядка retention prune');
        }
    }
    catalog.sort((a, b) => order.get(a.table) - order.get(b.table));
    return { catalog, rag, skillVersions };
}

const stalePredicate = (entry, extra) =>
    entry.column + " < now() - interval '" + entry.interval + "'" + (extra ? ' AND ' + extra : '');

/**
 * Batched-DELETE: не более batchLimit строк за тик. Обёртка RETURNING count даёт счётчик
 * одной строкой для psql -qAt. web_restore_jobs — два прохода (само-FK preview_id):
 * сначала старые restore-задачи, потом непривязанные.
 */
export function pruneStatements(entry, batchLimit = RETENTION_BATCH_LIMIT) {
    const table = entry.table;
    if (table === 'web_restore_jobs') {
        const child = stalePredicate(entry, 'preview_id IS NOT NULL');
        const unreferenced = stalePredicate(
            entry,
            'NOT EXISTS (SELECT 1 FROM web_restore_jobs c WHERE c.preview_id = web_restore_jobs.id)',
        );
        return [
            'WITH deleted AS (DELETE FROM ' +
                table +
                ' WHERE ' +
                child +
                ' AND ctid IN (SELECT ctid FROM ' +
                table +
                ' WHERE ' +
                child +
                ' LIMIT ' +
                batchLimit +
                ') RETURNING 1) SELECT count(*) FROM deleted;',
            'WITH deleted AS (DELETE FROM ' +
                table +
                ' WHERE ' +
                unreferenced +
                ' AND ctid IN (SELECT ctid FROM ' +
                table +
                ' WHERE ' +
                unreferenced +
                ' LIMIT ' +
                batchLimit +
                ') RETURNING 1) SELECT count(*) FROM deleted;',
        ];
    }
    const where = stalePredicate(entry, CATALOG_PRUNE_GUARDS[table]);
    return [
        'WITH deleted AS (DELETE FROM ' +
            table +
            ' WHERE ' +
            where +
            ' AND ctid IN (SELECT ctid FROM ' +
            table +
            ' WHERE ' +
            where +
            ' LIMIT ' +
            batchLimit +
            ') RETURNING 1) SELECT count(*) FROM deleted;',
    ];
}

/** bridge_runtime_artifacts: строки + список sha256 удалённых для FS-очистки (строки раньше файлов). */
export function artifactDeleteStatement(entry, batchLimit = RETENTION_BATCH_LIMIT) {
    const where = stalePredicate(entry);
    return (
        'DELETE FROM bridge_runtime_artifacts WHERE ' +
        where +
        ' AND ctid IN (SELECT ctid FROM bridge_runtime_artifacts WHERE ' +
        where +
        ' LIMIT ' +
        batchLimit +
        ') RETURNING sha256;'
    );
}

export const artifactExistingStatement = 'SELECT sha256 FROM bridge_runtime_artifacts;';

/**
 * Снимок rolling-N версий скилла. Самодостаточна (только readdir/lstat/rm/path): исходник
 * сериализуется в скрипт контейнера skills-service (skillVersionsPruneScript) без дублирования.
 * Группа = <root>/<hash(skillPath)>/<hash(generation)>/<version>.snapshot (skill-versions.ts).
 */
export async function skillVersionsPruneCore(root, keep) {
    if (!Number.isInteger(keep) || keep < 1) {
        throw new Error('rollingN должен быть целым положительным');
    }
    let skillEntries;
    try {
        skillEntries = await readdir(root);
    } catch (error) {
        if (error.code === 'ENOENT') return { deleted: 0 };
        throw error;
    }
    let deleted = 0;
    for (const skill of skillEntries) {
        const skillDirectory = path.join(root, skill);
        let skillInfo;
        try {
            skillInfo = await lstat(skillDirectory);
        } catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
        }
        if (!skillInfo.isDirectory() || skillInfo.isSymbolicLink()) continue;
        let generationEntries = await readdir(skillDirectory);
        for (const generation of generationEntries) {
            const generationDirectory = path.join(skillDirectory, generation);
            let generationInfo;
            try {
                generationInfo = await lstat(generationDirectory);
            } catch (error) {
                if (error.code === 'ENOENT') continue;
                throw error;
            }
            if (!generationInfo.isDirectory() || generationInfo.isSymbolicLink()) continue;
            const snapshots = [];
            for (const name of await readdir(generationDirectory)) {
                const match = /^(\d+)\.snapshot$/.exec(name);
                if (!match) continue;
                const file = path.join(generationDirectory, name);
                let info;
                try {
                    info = await lstat(file);
                } catch (error) {
                    if (error.code === 'ENOENT') continue;
                    throw error;
                }
                if (!info.isFile() || info.isSymbolicLink()) continue;
                snapshots.push({ version: Number(match[1]), file });
            }
            snapshots.sort((a, b) => b.version - a.version);
            for (const snapshot of snapshots.slice(keep)) {
                await rm(snapshot.file);
                deleted += 1;
            }
        }
    }
    return { deleted };
}

/** Скрипт контейнера skills-service: та же логика (исходник функции), корень и N из retention-таблицы. */
export function skillVersionsPruneScript(root, keep) {
    return [
        "const { readdir, lstat, rm } = require('node:fs/promises');",
        "const path = require('node:path');",
        skillVersionsPruneCore.toString(),
        '(async () => {',
        '    const result = await skillVersionsPruneCore(' + JSON.stringify(root) + ', ' + JSON.stringify(keep) + ');',
        '    process.stdout.write(JSON.stringify(result));',
        '})().catch((error) => {',
        '    process.stderr.write((error && error.message) || String(error));',
        '    process.exit(1);',
        '});',
    ].join('\n');
}

/**
 * FS-очистка runtime-artifacts (том catalog-service): <directory>/<sha256>.tar.gz
 * (runtime-artifacts.ts). spec = { deleted: [sha…], existing: [sha…], cutoffMs };
 * existing — снимок строк ПОСЛЕ DELETE:
 *  - deleted ∖ existing — строка снята этим тиком и за строкой снова не закрепилась
 *    (повторный импорт того же SHA между DELETE и снимком): файл удаляется независимо от возраста;
 *  - осиротевший файл (строки нет) с mtime старше TTL — GC (OQ-2: в том же prune, с логом);
 *  - прочее (частичные импорты, метаданные, чужие имена, закреплённые строки) не трогается.
 */
export async function runtimeArtifactRemoveCore(directory, spec) {
    if (!Array.isArray(spec?.deleted) || !Array.isArray(spec?.existing) || !Number.isFinite(spec.cutoffMs)) {
        throw new Error('Некорректная спецификация FS-очистки runtime-artifacts');
    }
    const deleted = new Set(spec.deleted);
    const existing = new Set(spec.existing);
    const result = { rowFiles: 0, orphanFiles: 0, orphans: [] };
    let entries;
    try {
        entries = await readdir(directory);
    } catch (error) {
        if (error.code === 'ENOENT') return result;
        throw error;
    }
    for (const name of entries) {
        if (!/^[a-f0-9]{64}\.tar\.gz$/.test(name)) continue;
        const file = path.join(directory, name);
        let info;
        try {
            info = await lstat(file);
        } catch (error) {
            if (error.code === 'ENOENT') continue;
            throw error;
        }
        if (!info.isFile() || info.isSymbolicLink()) continue;
        const sha = name.slice(0, -'.tar.gz'.length);
        if (deleted.has(sha) && !existing.has(sha)) {
            await rm(file);
            result.rowFiles += 1;
        } else if (!deleted.has(sha) && !existing.has(sha) && info.mtimeMs < spec.cutoffMs) {
            await rm(file);
            result.orphanFiles += 1;
            result.orphans.push(name);
        }
    }
    return result;
}

/** Скрипт контейнера catalog-service: та же логика, спецификация — через stdin (JSON). */
export function runtimeArtifactRemoveScript(directory) {
    return [
        "const { readdir, lstat, rm } = require('node:fs/promises');",
        "const path = require('node:path');",
        runtimeArtifactRemoveCore.toString(),
        '(async () => {',
        "    let data = '';",
        "    process.stdin.on('data', (chunk) => { data += chunk; });",
        "    process.stdin.on('end', () => {",
        '        runtimeArtifactRemoveCore(' + JSON.stringify(directory) + ', JSON.parse(data))',
        '            .then((result) => process.stdout.write(JSON.stringify(result)))',
        '            .catch((error) => { process.stderr.write((error && error.message) || String(error)); process.exit(1); });',
        '    });',
        '})().catch((error) => {',
        '    process.stderr.write((error && error.message) || String(error));',
        '    process.exit(1);',
        '});',
    ].join('\n');
}

/**
 * Один проход retention prune по retention-таблице. catalogQuery/ragQuery принимают SQL-текст
 * и возвращают text (psql -qAt: по строке на результат, одна колонка). artifactStore/skillsStore —
 * FS-адаптеры (в production — docker exec в контейнер владельца тома). Ошибки изолированы
 * per ресурс: результаты — массив { resource, deleted?, files?, error? }.
 */
export async function runRetentionPrune({
    resources,
    catalogQuery,
    ragQuery,
    artifactStore,
    skillsStore,
    batchLimit = RETENTION_BATCH_LIMIT,
    now = () => Date.now(),
    log = () => {},
}) {
    const plan = buildRetentionPlan(resources);
    const results = [];
    const runResource = async (record, action) => {
        try {
            Object.assign(record, await action());
        } catch (error) {
            record.error = String(error?.message || error).slice(0, 512);
            log(record.resource + ': ' + record.error);
        }
        results.push(record);
    };
    const countStatements = async (query, entry) => {
        let deleted = 0;
        for (const statement of pruneStatements(entry, batchLimit)) {
            deleted += Number((await query(statement)).trim() || 0);
        }
        return deleted;
    };
    for (const entry of plan.catalog) {
        const record = { resource: entry.resource };
        if (entry.artifacts) {
            await runResource(record, async () => {
                const shas = (await catalogQuery(artifactDeleteStatement(entry, batchLimit)))
                    .split('\n')
                    .map((value) => value.trim())
                    .filter(Boolean);
                if (!shas.every((value) => /^[a-f0-9]{64}$/.test(value))) {
                    throw new Error('неожидаемый результат prune: ' + entry.resource);
                }
                const files = await artifactStore.remove({
                    deleted: shas,
                    existing: (await catalogQuery(artifactExistingStatement))
                        .split('\n')
                        .map((value) => value.trim())
                        .filter(Boolean),
                    cutoffMs: now() - ttlToMs(entry.ttl),
                });
                return { deleted: shas.length, files };
            });
        } else {
            await runResource(record, async () => ({ deleted: await countStatements(catalogQuery, entry) }));
        }
    }
    for (const entry of plan.rag) {
        const record = { resource: entry.resource };
        await runResource(record, async () => ({ deleted: await countStatements(ragQuery, entry) }));
    }
    if (plan.skillVersions) {
        const record = { resource: plan.skillVersions.resource };
        await runResource(record, async () => {
            const result = await skillsStore.prune({
                path: plan.skillVersions.path,
                rollingN: plan.skillVersions.rollingN,
            });
            return { deleted: result.deleted };
        });
    }
    return { resources: results };
}
