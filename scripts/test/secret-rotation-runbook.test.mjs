/**
 * Secret rotation runbook (epic-dr 4.7, FR-1004, AD-OP-4, AD-OP-7.3):
 * офлайн-инвариант — runbook покрывает 100% инвентаря секретов.
 * Инвентарь = secrets в deploy/production/environment-model.json ∪
 * docker secrets compose.production.yml (+ tls_cert/tls_key из того же блока).
 * Каждый секрет обязан быть покрыт: секция `## <имя>` с тремя обязательными
 * блоками, либо (для *_url) внутри секции postgres_password, либо
 * (для tls_cert/tls_key) внутри секции edge-сертификата.
 * Новый секрет в инвентаре без секции = фэйл с именем (INVENTORY_DRIFT).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const DOC = 'docs/secret-rotation.md';
/** Три обязательных блока секции (FR-1004: процедура + последствия + проверка истечения). */
const MARKERS = ['Процедура ротации', 'Последствия', 'Проверка истечения'];

function collectSecrets(value, out) {
    if (Array.isArray(value)) {
        for (const entry of value) collectSecrets(entry, out);
        return;
    }
    if (value && typeof value === 'object')
        for (const [key, entry] of Object.entries(value)) {
            if (key === 'secrets' && Array.isArray(entry)) {
                for (const name of entry) if (typeof name === 'string') out.add(name);
            } else {
                collectSecrets(entry, out);
            }
        }
}

/** Топ-блок `secrets:` compose: имена `  <name>: {file: …}` до следующего ключа верхнего уровня. */
function composeSecrets(text) {
    const out = new Set();
    let inBlock = false;
    for (const line of text.split('\n')) {
        if (/^secrets:\s*$/.test(line)) {
            inBlock = true;
            continue;
        }
        if (!inBlock) continue;
        const match = line.match(/^  ([a-z0-9_]+): \{file:/);
        if (match) {
            out.add(match[1]);
            continue;
        }
        if (/^\S/.test(line)) break;
    }
    return out;
}

/** Тело секции `## <title>` (до следующего `## `); отсутствие заголовка = фэйл с именем. */
function section(doc, title) {
    const lines = doc.split('\n');
    const start = lines.findIndex((line) => line === '## ' + title);
    assert.ok(start >= 0, DOC + ': нет секции ' + title);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++)
        if (/^## /.test(lines[i])) {
            end = i;
            break;
        }
    return lines.slice(start, end).join('\n');
}

test('runbook покрывает 100% инвентаря: секция + 3 обязательных блока на каждый секрет', async () => {
    const model = JSON.parse(await fs.readFile(path.join(root, 'deploy/production/environment-model.json'), 'utf8'));
    const fromModel = new Set();
    collectSecrets(model, fromModel);
    const fromCompose = composeSecrets(await fs.readFile(path.join(root, 'compose.production.yml'), 'utf8'));
    const inventory = new Set([...fromModel, ...fromCompose]);
    assert.ok(inventory.size >= 15, 'инвентарь подозрительно мал: ' + inventory.size);

    const doc = await fs.readFile(path.join(root, DOC), 'utf8');
    const postgresSection = section(doc, 'postgres_password');
    const edgeSection = section(doc, 'edge-сертификат');

    for (const name of [...inventory].sort()) {
        if (name.endsWith('_url')) {
            assert.ok(
                postgresSection.includes(name),
                name + ': не покрыт процедурой postgres_password (4 файла *_url ротируются вместе с паролем PG)',
            );
        } else if (name === 'tls_cert' || name === 'tls_key') {
            assert.ok(
                edgeSection.includes(name),
                name + ': не покрыт секцией edge-сертификат (замена + пересоздание frontend)',
            );
        } else {
            const body = section(doc, name);
            for (const marker of MARKERS)
                assert.ok(body.includes(marker), name + ': в секции нет обязательного блока «' + marker + '»');
        }
    }
});

test('edge-сертификат: openssl x509 -checkend + ссылка на алерт days-to-expiry (ep6 entry 13)', () => {
    return fs.readFile(path.join(root, DOC), 'utf8').then((raw) => {
        const doc = String(raw);
        const edge = section(doc, 'edge-сертификат');
        assert.ok(edge.includes('openssl x509 -checkend'), 'edge: нет проверки openssl x509 -checkend');
        assert.ok(/ep6 entry 13/.test(edge), 'edge: нет ссылки на алерт days-to-expiry (ep6 entry 13)');
        // Алерт — ссылка, не механизм доставки (AD-O6).
        assert.ok(!/alertmanager\.yml/.test(edge), 'edge: механизм алертинга не дублируется (ep6 entry 13)');
    });
});

test('model_credential_key: явная запись, что новые ключи старые credentials не откроют (OQ3)', () => {
    return fs.readFile(path.join(root, DOC), 'utf8').then((raw) => {
        const body = section(String(raw), 'model_credential_key');
        assert.ok(
            /не откроют/i.test(body) && /ограничение/i.test(body),
            'model_credential_key: нет записи об ограничении (новые ключи старые credentials не откроют)',
        );
    });
});

test('runbook не содержит значений секретов (ни 64-хекс строк — формат всех генерируемых значений)', async () => {
    const doc = String(await fs.readFile(path.join(root, DOC), 'utf8'));
    assert.ok(!/[a-f0-9]{64}/.test(doc), DOC + ': строка в формате значения секрета (64 hex)');
});

test('postgres_password: 4 файла *_url + rollback-шаг частичной ротации', () => {
    return fs.readFile(path.join(root, DOC), 'utf8').then((raw) => {
        const body = section(String(raw), 'postgres_password');
        for (const name of ['catalog_url', 'rag_url', 'rag_provision_url', 'backup_url'])
            assert.ok(body.includes(name), 'postgres_password: не упомянут ' + name);
        assert.ok(
            /roll ?back/i.test(body) || /Rollback/.test(body),
            'postgres_password: нет rollback-шага частичной ротации',
        );
    });
});

test('sso_client_secret: порядок «сначала IdP — потом server-файл» (без окна отказа входа)', () => {
    return fs.readFile(path.join(root, DOC), 'utf8').then((raw) => {
        const body = section(String(raw), 'sso_client_secret');
        const procedure = body.slice(body.indexOf('Процедура ротации'));
        const idpStep = procedure.search(/Blitz/);
        const fileStep = procedure.search(/secrets\/sso_client_secret/);
        assert.ok(
            idpStep >= 0 && fileStep > idpStep,
            'sso_client_secret: порядок «сначала IdP — потом файл» не зафиксирован',
        );
    });
});
