/**
 * AD-OP-6 (epic-res-obs, story 6.1): статический инварианс non-root-запуска всех 7 app-образов.
 *
 * Живая проверка (docker compose exec id, старт стека, bwrap smoke) — final gate; здесь —
 * Dockerfile/компонента-инвариансы: единый uid 1000, владельство writable-путей, отсутствие
 * привилегированных портов, cap/no-new-privileges без ослаблений, bwrap-системные вызовы
 * seccomp-профиля и nginx non-root master.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { load as loadYaml } from 'js-yaml';

const root = fileURLToPath(new URL('../..', import.meta.url));
const SERVICE_USER = 'node';
const SERVICE_UID = '1000';
/** 7 app-образов AD-OP-6 (6 Node + frontend); внешние образы (ollama/pgvector) вне скоупа. */
const APP_IMAGES = [
    ['api-gateway', 'services/api-gateway/Dockerfile'],
    ['catalog-service', 'services/catalog-service/Dockerfile'],
    ['feature-flags-service', 'services/feature-flags-service/Dockerfile'],
    ['oauth2-bridge', 'services/oauth2-bridge/Dockerfile'],
    ['rag-sync-service', 'services/rag-sync-service/Dockerfile'],
    ['skills-service', 'services/skills-service/Dockerfile'],
    ['frontend', 'frontend/Dockerfile'],
];

/** Логические инструкции Dockerfile: склейка продолжений, без комментариев. */
function logicalInstructions(source) {
    const out = [];
    let buffer = '';
    for (const rawLine of source.split('\n')) {
        const line = rawLine.replace(/\s+$/, '');
        if (!buffer && !line.trim()) continue;
        if (!buffer && line.trim().startsWith('#')) continue;
        if (line.endsWith('\\')) {
            buffer += line.slice(0, -1) + ' ';
            continue;
        }
        const logical = (buffer + line).trim();
        buffer = '';
        if (!logical) continue;
        const [instruction, ...rest] = logical.split(/\s+/);
        out.push([instruction, rest.join(' ')]);
    }
    return out;
}
/** Инструкции последней стадии (frontend — multi-stage; USER нужен только в финальной). */
function finalStage(instructions) {
    let lastFrom = -1;
    instructions.forEach(([name], index) => {
        if (name === 'FROM') lastFrom = index;
    });
    return instructions.slice(lastFrom + 1);
}
/** Пути, которые mkdir/chown в RUN-инструкциях стадии (цели владельства). */
function ownedTargets(instructions) {
    const targets = new Set();
    for (const [name, args] of instructions) {
        if (name !== 'RUN') continue;
        for (const segment of args.split('&&')) {
            const trimmed = segment.trim();
            if (!/^mkdir -p /.test(trimmed) && !/^chown -R /.test(trimmed)) continue;
            for (const token of trimmed.split(/\s+/)) if (token.startsWith('/')) targets.add(token);
        }
    }
    return targets;
}
const covered = (targets, mount) => [...targets].some((target) => mount === target || mount.startsWith(target + '/'));

let compose;
const composeServices = () => {
    compose ??= loadYaml(fsSync.readFileSync(path.join(root, 'compose.production.yml'), 'utf8'));
    return compose.services;
};

test('все 7 app-образов: единый non-root uid 1000 и USER после всех build-шагов', async () => {
    for (const [service, file] of APP_IMAGES) {
        const source = await fs.readFile(path.join(root, file), 'utf8');
        const stage = finalStage(logicalInstructions(source));
        const users = stage.filter(([name]) => name === 'USER');
        assert.ok(users.length, `${service} (${file}): нет USER в финальной стадии`);
        const userEntry = users.at(-1);
        // Литерал или $SERVICE_USER (ARG-константа ниже): оба закрепляют единый uid.
        assert.ok(
            [SERVICE_USER, '$SERVICE_USER'].includes(userEntry[1]),
            `${file}: USER должен быть единой константой ${SERVICE_USER} (или $SERVICE_USER)`,
        );
        const userIndex = stage.lastIndexOf(userEntry);
        const argUser = stage.some(([name, args]) => name === 'ARG' && args === 'SERVICE_USER=' + SERVICE_USER);
        const argUid = stage.some(([name, args]) => name === 'ARG' && args === 'SERVICE_UID=' + SERVICE_UID);
        assert.ok(
            argUser && argUid,
            `${file}: нужны ARG SERVICE_USER=${SERVICE_USER} и ARG SERVICE_UID=${SERVICE_UID}`,
        );
        // Build-time guard: uid константы сверяется с фактическим uid пользователя в образе.
        const guarded = stage.some(
            ([name, args]) =>
                name === 'RUN' && args.includes('id -u "$SERVICE_USER"') && args.includes('grep -qx "$SERVICE_UID"'),
        );
        assert.ok(guarded, `${file}: нужен build-time guard uid (id -u | grep -qx $SERVICE_UID)`);
        // После USER не должно быть build-шагов (RUN/COPY/ADD) — сборка root'ом, запуск non-root.
        for (const [name] of stage.slice(userIndex + 1)) {
            assert.ok(!['RUN', 'COPY', 'ADD'].includes(name), `${file}: build-шаг после USER (${name})`);
        }
    }
});

test('writable-точки монтирования named volumes принадлежат service-user (первый mount наследует owner из образа)', async () => {
    const services = composeServices();
    for (const [service, file] of APP_IMAGES) {
        const source = await fs.readFile(path.join(root, file), 'utf8');
        const targets = ownedTargets(finalStage(logicalInstructions(source)));
        for (const volume of services[service].volumes ?? []) {
            const parts = String(volume).split(':');
            const containerPath = parts.length >= 2 ? parts[1] : null;
            const mode = parts.at(-1);
            if (!containerPath || mode === 'ro') continue;
            assert.ok(
                covered(targets, containerPath),
                `${service}: writable-монтирование ${containerPath} не покрыто mkdir/chown в ${file}`,
            );
        }
    }
});

test('нет привилегированных портов (<1024) у non-root app-контейнеров', async () => {
    const services = composeServices();
    for (const [service, file] of APP_IMAGES) {
        for (const port of services[service].ports ?? []) {
            const parts = String(port).split(':');
            const containerPort = Number(parts.length >= 3 ? parts[1] : parts.at(-1));
            assert.ok(
                Number.isFinite(containerPort) && containerPort > 1024,
                `${service}: контейнерный порт ${port} привилегированный (non-root)`,
            );
        }
        const source = await fs.readFile(path.join(root, file), 'utf8');
        for (const [name, args] of finalStage(logicalInstructions(source))) {
            if (name !== 'EXPOSE') continue;
            for (const value of args.split(/\s+/)) {
                const port = Number(value);
                assert.ok(
                    Number.isFinite(port) && port > 1024,
                    `${service}: EXPOSE ${port} привилегированный (non-root)`,
                );
            }
        }
    }
});

test('cap_drop/no-new-privileges/seccomp не ослаблены: non-root не требует cap_add', async () => {
    const services = composeServices();
    assert.ok(
        compose['x-service']?.security_opt?.includes('no-new-privileges:true'),
        'x-service: no-new-privileges обязателен',
    );
    // Все потребители catalog-образа и app-сервисы работают без cap_add.
    for (const service of [
        'api-gateway',
        'catalog-service',
        'feature-flags-service',
        'oauth2-bridge',
        'rag-sync-service',
        'skills-service',
        'frontend',
        'background-agent',
        'database-init',
        'bootstrap-admin',
    ]) {
        assert.ok(
            !services[service].cap_add?.length,
            `${service}: cap_add появился — AD-OP-6 запрещает добавлять cap_add ради non-root`,
        );
    }
    // Единственное исключение — capacity-collector (DAC_OVERRIDE под read-only statfs), не трогать.
    assert.deepEqual(services['capacity-collector'].cap_add, ['DAC_OVERRIDE']);
    assert.deepEqual(services['catalog-service'].cap_drop, ['ALL']);
    assert.ok(services['catalog-service'].security_opt?.includes('seccomp:./docker/seccomp/catalog-packager.json'));
    assert.deepEqual(services['api-gateway'].cap_drop, ['ALL']);
    assert.deepEqual(services['model-runtime'].cap_drop, ['ALL']);
});

test('seccomp-профиль продолжает разрешать bwrap-неймспейсы (non-root бьёт в те же unprivileged user namespaces)', async () => {
    const profile = JSON.parse(await fs.readFile(path.join(root, 'docker/seccomp/catalog-packager.json'), 'utf8'));
    const allowedExactly = (names) =>
        profile.syscalls.some(
            (entry) =>
                entry.action === 'SCMP_ACT_ALLOW' &&
                Array.isArray(entry.names) &&
                entry.names.length === names.length &&
                names.every((name) => entry.names.includes(name)),
        );
    assert.ok(
        profile.syscalls.some(
            (entry) => entry.names.includes('clone') && String(entry.comment ?? '').includes('bwrap'),
        ),
        'clone bwrap-правило',
    );
    assert.ok(
        profile.syscalls.some((entry) => entry.names.includes('unshare') && entry.action === 'SCMP_ACT_ALLOW'),
        'unshare',
    );
    assert.ok(allowedExactly(['mount', 'umount2', 'pivot_root']), 'mount/umount2/pivot_root');
    assert.ok(
        profile.syscalls.some((entry) => entry.names.includes('setns') && entry.action === 'SCMP_ACT_ALLOW'),
        'setns (переход в user-namespace)',
    );
});

test('nginx: master non-root, порты >1024, pid вне tmpfs, конф-каталог writable для envsubst', async () => {
    const source = await fs.readFile(path.join(root, 'frontend/Dockerfile'), 'utf8');
    const targets = ownedTargets(finalStage(logicalInstructions(source)));
    for (const required of ['/var/cache/nginx', '/var/log/nginx', '/etc/nginx/conf.d']) {
        assert.ok(targets.has(required), `frontend: ${required} должен быть chowned (nginx non-root)`);
    }
    // pid-файл: /var/run — tmpfs, не наследует owner из образа; уведён в /var/cache/nginx со страховкой.
    assert.ok(
        source.includes('sed -i') && source.includes('/var/cache/nginx/nginx.pid'),
        'frontend: pid override в /var/cache/nginx',
    );
    for (const file of ['frontend/nginx.conf', 'frontend/nginx.production.conf.template']) {
        const config = await fs.readFile(path.join(root, file), 'utf8');
        for (const line of config.split('\n')) {
            const match = line.match(/^\s*listen\s+(\S+);/);
            if (!match) continue;
            const port = Number(match[1].split(':').at(-1));
            assert.ok(
                Number.isFinite(port) && port > 1024,
                `${file}: listen ${port} привилегированный (nginx non-root)`,
            );
        }
    }
});

test('внешние образы (ollama/pgvector) зафиксированы вне non-root-скоупа', async () => {
    const services = composeServices();
    assert.ok(services['model-runtime'].image.startsWith('ollama/ollama'));
    assert.ok(!services['model-runtime'].build, 'model-runtime — внешний образ, не app-сборка');
    assert.ok(services.postgres.image.startsWith('pgvector/pgvector'));
    assert.ok(!services.postgres.build, 'postgres — внешний образ, не app-сборка');
});

test('решения AD-OP-6 зафиксированы в операторской документации', async () => {
    const doc = await fs.readFile(path.join(root, 'docs/production-setup.md'), 'utf8');
    assert.ok(doc.includes('AD-OP-6'), 'docs/production-setup.md: раздел AD-OP-6');
    assert.ok(doc.includes('uid 1000'), 'docs: зафиксирован единый uid 1000');
    assert.ok(doc.includes('ollama') && doc.includes('pgvector'), 'docs: внешние образы вне скоупа');
    assert.ok(/backup|restore/.test(doc.slice(doc.indexOf('AD-OP-6'))), 'docs: действие при старом root-owned томе');
});
