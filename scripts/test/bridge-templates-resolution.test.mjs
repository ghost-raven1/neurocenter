import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadEnvironmentModel, loadProductionCompose } from '../production/environment-model.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const DOCKERFILE = 'services/api-gateway/Dockerfile';
const TSCONFIG = 'services/api-gateway/tsconfig.json';
const CONTROLLER = 'services/api-gateway/src/bridge/bridge.controller.ts';

/**
 * H5 (BRIDGE_TEMPLATES_DIR) — регресс резолва шаблонов из собранного образа без
 * docker-сборки (D5): layout извлечён из Dockerfile и tsconfig, арифметика
 * fallback — ровно из выражения bridge.controller.ts:18, кросс-сверка —
 * модель = цель COPY = production compose.
 *
 * Явное ограничение: «bridge-endpoints отвечают 200, не 404, на развёрнутом
 * production-стеке» принимается e2e-линией entry 1.13 (REL-01) на чистом
 * хосте; здесь — статическая гарантия, что в развёрнутом стеке env-ветка
 * выражения `process.env.BRIDGE_TEMPLATES_DIR || fallback` всегда побеждает.
 */

/** Image-layout api-gateway: WORKDIR, цель COPY bridge-dist/, каталог скомпилированного контроллера. */
async function imageLayout() {
    const dockerfile = await fs.readFile(path.join(root, DOCKERFILE), 'utf8');
    const workdirs = [...dockerfile.matchAll(/^WORKDIR\s+(\S+)\s*$/gm)].map((match) => match[1]);
    if (!workdirs.length) throw new Error('WORKDIR не найден в ' + DOCKERFILE);
    const workdir = workdirs.at(-1);
    const bridgeCopy = dockerfile.match(/^COPY\s+bridge-dist\/\s+(\S+)\s*$/m);
    if (!bridgeCopy) throw new Error('COPY bridge-dist/ не найден в ' + DOCKERFILE);
    const templatesDir = bridgeCopy[1].replace(/\/+$/, '');
    if (!/^COPY\s+services\/api-gateway\/\s+\.\s*$/m.test(dockerfile)) {
        throw new Error('COPY services/api-gateway/ . не найден в ' + DOCKERFILE);
    }
    const tsconfig = JSON.parse(await fs.readFile(path.join(root, TSCONFIG), 'utf8'));
    const outDir = String(tsconfig.compilerOptions?.outDir ?? '').replace(/^\.\//, '');
    if (!outDir) throw new Error('outDir не найден в tsconfig api-gateway');
    // tsconfig: include src/**/* + outDir ⇒ src/bridge → <outDir>/bridge внутри WORKDIR.
    return { workdir, templatesDir, controllerDir: path.posix.join(workdir, outDir, 'bridge') };
}

test('image layout api-gateway: WORKDIR /app, шаблоны в /app/bridge-dist, контроллер в /app/dist/bridge', async () => {
    const { workdir, templatesDir, controllerDir } = await imageLayout();
    assert.equal(workdir, '/app');
    assert.equal(templatesDir, '/app/bridge-dist');
    assert.equal(controllerDir, '/app/dist/bridge');
});

test('fallback из bridge.controller.ts:18 в production-образе даёт /bridge-dist, а не /app/bridge-dist (H5)', async () => {
    const { templatesDir, controllerDir } = await imageLayout();
    const source = await fs.readFile(path.join(root, CONTROLLER), 'utf8');
    const line = source.split('\n').find((text) => text.includes('process.env.BRIDGE_TEMPLATES_DIR'));
    assert.ok(line, 'строка с process.env.BRIDGE_TEMPLATES_DIR не найдена в ' + CONTROLLER);
    // static-guard: выражение изменилось — тест падает, перепроверить арифметику fallback.
    assert.match(
        line,
        /process\.env\.BRIDGE_TEMPLATES_DIR \|\| path\.resolve\(__dirname, '\.\.', '\.\.', '\.\.', '\.\.', 'bridge-dist'\)/,
    );
    // Арифметика ровно как в :18 на __dirname скомпилированного контроллера.
    const fallback = path.posix.resolve(controllerDir, '..', '..', '..', '..', 'bridge-dist');
    assert.equal(fallback, '/bridge-dist');
    assert.notEqual(fallback, templatesDir, 'fallback совпал с целью COPY — H5 не воспроизводится, пересмотреть тест');
    // Каталог fallback не создаётся ни одной инструкцией Dockerfile.
    const dockerfile = await fs.readFile(path.join(root, DOCKERFILE), 'utf8');
    for (const copy of dockerfile.matchAll(/^COPY\s+.*\s(\S+)\s*$/gm)) {
        assert.notEqual(copy[1].replace(/\/+$/, ''), fallback, 'Dockerfile начал создавать каталог fallback');
    }
    assert.ok(!/^WORKDIR\s+\/bridge-dist\s*$/m.test(dockerfile));
});

test('модель = Dockerfile = production compose: в развёрнутом стеке fallback не выполняется', async () => {
    const model = await loadEnvironmentModel(root);
    const services = await loadProductionCompose(root, model);
    const { templatesDir } = await imageLayout();
    const spec = model.services['api-gateway'];
    assert.equal(spec.env.BRIDGE_TEMPLATES_DIR, templatesDir, 'значение модели разошлось с целью COPY в Dockerfile');
    assert.equal(
        services['api-gateway'].env.BRIDGE_TEMPLATES_DIR,
        templatesDir,
        'production compose разошёлся с целью COPY в Dockerfile',
    );
    // consumedBy-семантика (D4): причина явно называет потребителя (код api-gateway).
    const reason = spec.requiredEnv.BRIDGE_TEMPLATES_DIR;
    assert.equal(typeof reason, 'string');
    assert.match(reason, /bridge\.controller/);
    // BRIDGE_DIST — мёртвая переменная: в модели не появляется нигде;
    // возврат в compose ловится dead-env (направление 1.2).
    for (const [name, service] of Object.entries(model.services)) {
        for (const field of ['env', 'requiredEnv', 'envNotes']) {
            assert.ok(!Object.hasOwn(service[field] ?? {}, 'BRIDGE_DIST'), `${name}.${field}.BRIDGE_DIST`);
        }
    }
});
