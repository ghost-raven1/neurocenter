import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * AD-O4 (entry 9): единственная health-семантика — /ready; /health удалён; бюджеты
 * readiness — именованные константы в shared/readiness.cjs, сервисы их не знают.
 *
 * Инварианты:
 *  (a) shared/readiness.cjs экспортирует READINESS_CHECK_TIMEOUT_MS / HTTP_READY_TIMEOUT_MS /
 *      READY_BODY_LIMIT_BYTES с каноническими значениями (2500/2000/16384) И использует их
 *      в логике, а не хардкодит литералы внутри функций.
 *  (б) Ни один сервис в services/[service]/src не переопределяет эти имена констант;
 *      app.controller.ts каждого сервиса не содержит ни одного из числовых бюджетов (литералов) —
 *      бюджеты читаются только из shared.
 *  (в) grep '/health' в services/[service]/src + frontend/nginx*.conf = 0 (AD-O4: /health удалён).
 *
 * Числа бюджетов встречаются в репозитории как размеры/порты (OQ-4), поэтому (б) ограничен
 * app.controller.ts и переопределением имён констант — грубый grep по всем src даёт ложные
 * срабатывания.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const servicesRoot = path.join(repoRoot, 'services');
const frontendRoot = path.join(repoRoot, 'frontend');

/** Канонические бюджеты readiness (значения зафиксированы — меняться не должны). */
const EXPECTED = {
    READINESS_CHECK_TIMEOUT_MS: 2500,
    HTTP_READY_TIMEOUT_MS: 2000,
    READY_BODY_LIMIT_BYTES: 16384,
};

function walk(dir) {
    const files = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...walk(full));
        else files.push(full);
    }
    return files;
}

const readinessPath = path.join(servicesRoot, 'shared', 'readiness.cjs');
const readinessSource = fs.readFileSync(readinessPath, 'utf8');

// Позиционируем require относительно этого файла — createRequire резолвит cjs как commonjs.
const repoRequire = createRequire(import.meta.url);

test('(а) shared/readiness.cjs — бюджеты именованные константы, не литералы в логике', () => {
    const readiness = repoRequire(readinessPath);
    for (const [name, value] of Object.entries(EXPECTED)) {
        assert.equal(
            readiness[name],
            value,
            `shared/readiness.cjs обязан экспортировать ${name}=${value} (AD-O4: бюджеты-константы)`,
        );
        const occurrences = readinessSource.split(name).length - 1;
        assert.ok(
            occurrences >= 2,
            `${name} обязан быть ИСПОЛЬЗОВАН в логике (объявление + использование), найдено вхождений: ${occurrences}`,
        );
    }
    // Значения не менялись: литералы встречаются только в объявлениях констант, не в логике.
    const constPattern = /const\s+(READINESS_CHECK_TIMEOUT_MS|HTTP_READY_TIMEOUT_MS|READY_BODY_LIMIT_BYTES)\s*=\s*(\d+)\s*;/g;
    const declared = new Set();
    for (const match of readinessSource.matchAll(constPattern)) {
        declared.add(Number(match[2]));
    }
    assert.deepEqual(
        [...declared].sort((a, b) => a - b),
        [...Object.values(EXPECTED)].sort((a, b) => a - b),
        'readiness.cjs: объявленные значения констант обязаны быть каноническими',
    );
    // Логика не должна обращаться к числам напрямую: каждое каноническое значение встречается
    // ровно столько раз, сколько раз объявлено в const (т.е. без «сырых» литералов в вызовах).
    for (const value of Object.values(EXPECTED)) {
        const raw = readinessSource.split(String(value)).length - 1;
        const inConst = [...readinessSource.matchAll(constPattern)].filter((m) => Number(m[2]) === value).length;
        assert.ok(
            raw === inConst,
            `readiness.cjs: литерал ${value} встречается ${raw} раз, а объявлен ${inConst} — логика не должна хардкодить бюджеты`,
        );
    }
});

test('(б) сервисы не переопределяют имена бюджет-констант и не хардкодят их в app.controller.ts', () => {
    const srcFiles = walk(servicesRoot)
        .filter((file) => file.includes(`${path.sep}src${path.sep}`) && file.endsWith('.ts'))
        .filter((file) => !file.includes(`${path.sep}shared${path.sep}`));
    assert.ok(srcFiles.length > 0, 'services/*/src/*.ts не найден — структура изменилась');

    const constantNames = Object.keys(EXPECTED);
    const controllerFiles = [];
    for (const file of srcFiles) {
        const source = fs.readFileSync(file, 'utf8');
        // Переопределение имени константы (const X = / let X = / var X =) — фэйл.
        for (const name of constantNames) {
            const re = new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=`);
            assert.ok(
                !re.test(source),
                `${path.relative(repoRoot, file)}: сервис не вправе переопределять ${name} (бюджеты только из shared/readiness.cjs)`,
            );
        }
        if (basename(file) === 'app.controller.ts') {
            for (const value of Object.values(EXPECTED)) {
                const re = new RegExp(`(?<![\\w.])${value}(?![\\w.])`);
                assert.ok(
                    !re.test(source),
                    `${path.relative(repoRoot, file)}: app.controller.ts не вправе хардкодить бюджет ${value} (AD-O4: константы в shared)`,
                );
            }
            controllerFiles.push(file);
        }
    }
    assert.equal(controllerFiles.length, 6, 'должно быть ровно 6 app.controller.ts (по числу сервисов)');
});

test('(в) /health отсутствует в services/*/src и nginx-конфигах (AD-O4)', () => {
    const offenders = [];
    for (const file of walk(servicesRoot).filter((f) => f.includes(`${path.sep}src${path.sep}`) && f.endsWith('.ts'))) {
        const source = fs.readFileSync(file, 'utf8');
        if (source.includes('/health')) offenders.push(path.relative(repoRoot, file));
    }
    for (const template of ['nginx.production.conf.template', 'nginx.conf'].map((name) => path.join(frontendRoot, name))) {
        if (!fs.existsSync(template)) continue;
        if (fs.readFileSync(template, 'utf8').includes('/health')) offenders.push(path.relative(repoRoot, template));
    }
    assert.deepEqual(
        offenders,
        [],
        'AD-O4: /health удалён — в services/*/src и frontend/nginx*.conf не должно быть ни одного вхождения',
    );
});

function basename(file) {
    return path.basename(file);
}
