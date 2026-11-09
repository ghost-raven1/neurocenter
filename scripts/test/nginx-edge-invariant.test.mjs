import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

/**
 * Nginx-кромка vs gateway-дедлайны (AD-6, entry 2.9): кромка обязана держать
 * каждый gateway-дедлайн — proxy_read_timeout >= timeoutMs строки route-policy
 * (shared /api/-кромка 600s — равенство допустимо; dedicated-локации
 * (model-chats 915s, ollama 615s, archive 605s) — margin >= 5s).
 *
 * Body-цепочка nginx → gateway → catalog не «растёт к центру»:
 * номинальные MB монотонно не растут, 40MiB-тело проходит все три предела,
 * gateway <= catalog в байтах (иначе opaque-413 со стороны каталога).
 *
 * Требует свежей сборки gateway (dist/proxy/route-policy.js).
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const gatewayRequire = createRequire(new URL('../../services/api-gateway/package.json', import.meta.url));
const { ROUTE_POLICY, CATCH_ALL_ROW, CATCH_ALL_PATH, matchPolicy } = gatewayRequire('./dist/proxy/route-policy.js');

const nginxTemplate = fs.readFileSync(path.join(repoRoot, 'frontend/nginx.production.conf.template'), 'utf8');

/** Нginx-размер ('50m', '8g', '512k', '1024') → байты (к = 1024). */
function nginxBytes(size) {
    const match = String(size).trim().match(/^(\d+(?:\.\d+)?)\s*([kmg]?)$/i);
    assert.ok(match, 'nginx: неразборчивый размер ' + size);
    const factor = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 }[match[2].toLowerCase()];
    return Math.round(Number(match[1]) * factor);
}

/** Локации template'а: kind exact/prefix-caret/regex/prefix + таймауты прокси. */
function parseNginxLocations(source) {
    const locations = [];
    const re = /location\s+(=\s*|~\^?\s*|\^~\s*)?("?)([^{\s"]+)\2\s*\{/g;
    let match;
    while ((match = re.exec(source))) {
        const modifier = (match[1] || '').trim();
        const matcher = match[3];
        let depth = 0;
        let end = -1;
        for (let i = re.lastIndex - 1; i < source.length; i++) {
            if (source[i] === '{') depth++;
            else if (source[i] === '}') {
                depth--;
                if (depth === 0) {
                    end = i;
                    break;
                }
            }
        }
        assert.ok(end > 0, 'nginx: незакрытый блок location ' + matcher);
        const body = source.slice(re.lastIndex - 1, end);
        const readTimeout = body.match(/proxy_read_timeout\s+(\d+(?:\.\d+)?)s;/);
        const sendTimeout = body.match(/proxy_send_timeout\s+(\d+(?:\.\d+)?)s;/);
        const bodySize = body.match(/client_max_body_size\s+([^\s;]+);/);
        locations.push({
            kind: modifier === '=' ? 'exact' : modifier === '^~' ? 'prefix-caret' : modifier.startsWith('~') ? 'regex' : 'prefix',
            matcher,
            readMs: readTimeout ? Math.round(Number(readTimeout[1]) * 1000) : 60000,
            sendMs: sendTimeout ? Math.round(Number(sendTimeout[1]) * 1000) : null,
            bodyBytes: bodySize ? nginxBytes(bodySize[1]) : null,
        });
    }
    assert.ok(locations.length >= 8, 'nginx: ожидается не менее 8 location, найдено ' + locations.length);
    return locations;
}

/** Nginx-прецедент: exact > longest ^~ > regex (порядок конфига) > longest prefix. */
function coverLocation(locations, uri) {
    let bestCaret = null;
    let bestPrefix = null;
    let firstRegex = null;
    for (const location of locations) {
        if (location.kind === 'exact') {
            if (location.matcher === uri) return location;
        } else if (location.kind === 'prefix-caret') {
            if (uri.startsWith(location.matcher) && (!bestCaret || location.matcher.length > bestCaret.matcher.length))
                bestCaret = location;
        } else if (location.kind === 'regex') {
            if (!firstRegex && new RegExp(location.matcher).test(uri)) firstRegex = location;
        } else if (uri.startsWith(location.matcher) && (!bestPrefix || location.matcher.length > bestPrefix.matcher.length)) {
            bestPrefix = location;
        }
    }
    if (bestCaret) return bestCaret;
    if (firstRegex) return firstRegex;
    return bestPrefix;
}

const locations = parseNginxLocations(nginxTemplate);
const sharedApi = locations.find((location) => location.kind === 'prefix' && location.matcher === '/api/');
assert.ok(sharedApi && sharedApi.readMs === 600000, 'nginx: shared location /api/ 600s обязательна (инвариант 2.9)');

const UUID = '11111111-2222-4333-8444-555555555555';
const SHA = 'a'.repeat(64);

/** (метод, клиентский путь через nginx) → ожидаемая строка route-policy и её gateway-дедлайн. */
const SAMPLES = [
    { method: 'POST', path: `/api/model-chats/${UUID}/turns`, row: '/api/model-chats/:id/turns', timeoutMs: 910000 },
    // 64MB-ответ: dedicated 915s-кромка обязана не рвать его (не опускаться на 600s shared).
    { method: 'POST', path: `/api/model-chats/${UUID}/attachments`, row: '/api/model-chats/:id/turns', timeoutMs: 910000 },
    { method: 'POST', path: '/api/models/gpt-4/ollama/api/chat', row: '/api/models/:model/ollama/*', timeoutMs: 610000 },
    { method: 'POST', path: '/api/models/gpt-4/ollama/v1/embeddings', row: '/api/models/:model/ollama/*', timeoutMs: 610000 },
    { method: 'POST', path: '/api/tool-builds/imports', row: '/api/tool-builds/imports', timeoutMs: 540000 },
    { method: 'GET', path: `/api/tool-builds/${UUID}/supply`, row: '/api/tool-builds/:id/supply', timeoutMs: 300000 },
    { method: 'GET', path: `/api/tool-builds/${UUID}/asset`, row: '/api/tool-builds/:id/asset', timeoutMs: 300000 },
    { method: 'PUT', path: `/api/tool-builds/uploads/${UUID}/content`, row: '/api/tool-builds/uploads/:id/content', timeoutMs: 600000 },
    { method: 'POST', path: '/api/discussions/attachments', row: '/api/discussions/attachments', timeoutMs: 600000 },
    { method: 'GET', path: `/api/discussions/attachments/${UUID}/content`, row: '/api/discussions/attachments/:id/content', timeoutMs: 30000 },
    { method: 'PUT', path: `/api/projects/project-1/snapshot-uploads/${UUID}/blobs/${SHA}`, row: '/api/projects/:key/snapshot-uploads/:id/blobs/:sha', timeoutMs: 600000 },
    { method: 'PUT', path: '/api/asset-sources/archive', row: '/api/asset-sources/archive', timeoutMs: 600000 },
    { method: 'GET', path: `/api/projects/project-1/versions/${UUID}/blobs/${SHA}`, row: '/api/projects/:key/versions/:id/blobs/:sha', timeoutMs: 120000 },
    { method: 'GET', path: '/api/projects/project-1/backups/backup-1/download', row: '/api/projects/:key/backups/:id/download', timeoutMs: 30000 },
    { method: 'GET', path: `/api/device-channel/jobs/${UUID}/runtime/${SHA}`, row: '/api/device-channel/jobs/:id/runtime/:sha', timeoutMs: 30000 },
    { method: 'POST', path: '/api/device-channel/embedding', row: '/api/device-channel/embedding', timeoutMs: 115000 },
    { method: 'POST', path: '/api/device-channel/identity', row: '/api/device-channel/*', timeoutMs: 30000 },
    { method: 'POST', path: '/api/bridge-source/check', row: '/api/bridge-source/check', timeoutMs: 60000 },
    { method: 'GET', path: '/api/tool-builds/repository', row: '/api/tool-builds/repository|npm', timeoutMs: 85000 },
    { method: 'GET', path: '/api/bridge/config', row: '/bridge/config', timeoutMs: 600000 },
    { method: 'GET', path: '/api/bridge/runtime/neurocenter-asset-sync-linux-x64-1.2.3.tgz', row: '/bridge/runtime/:file', timeoutMs: 600000 },
    { method: 'POST', path: '/api/internal/research-mcp/list', row: '/internal/research-mcp/list', timeoutMs: 45000 },
    { method: 'POST', path: '/api/mcp-host/connect', row: '/mcp-host/connect', timeoutMs: 15000 },
    // 10MiB-вложение проходит shared /api/-кромку (600s) — равенство budget/edge допустимо.
    { method: 'GET', path: '/api/other-route', row: CATCH_ALL_PATH, timeoutMs: 30000 },
];

test('Каждый gateway-дедлайн держится nginx-кромкой (dedicated: margin >= 5s)', () => {
    for (const sample of SAMPLES) {
        const row = matchPolicy(sample.method, sample.path);
        assert.equal(
            row.path,
            sample.row,
            `${sample.method} ${sample.path}: matchPolicy вернул ${row.path}, ожидаемо ${sample.row}`,
        );
        assert.equal(row.timeoutMs, sample.timeoutMs, `${sample.method} ${sample.path}: деадлайн строки дрейфнул`);
        const location = coverLocation(locations, sample.path);
        assert.ok(location, `${sample.path}: nginx не покрывает путь ни одним location`);
        const dedicated = !(location.kind === 'prefix' && (location.matcher === '/api/' || location.matcher === '/'));
        const edge = location.readMs;
        assert.ok(
            edge >= sample.timeoutMs,
            `${sample.path}: nginx ${location.matcher} read ${edge}ms < gateway ${sample.timeoutMs}ms — кромка рвёт деадлайн первой`,
        );
        assert.ok(
            !dedicated || edge >= sample.timeoutMs + 5000,
            `${sample.path}: dedicated-кромка ${location.matcher} ${edge}ms < gateway ${sample.timeoutMs}ms + 5s margin`,
        );
    }
});

test('Dedicated-локации 2.9 присутствуют: model-chats 915s, ollama 615s, archive 605s (read+send)', () => {
    const byMatcher = new Map(locations.map((location) => [location.matcher, location]));
    const chats = byMatcher.get('/api/model-chats/');
    assert.ok(chats && chats.kind === 'prefix-caret' && chats.readMs === 915000, 'nginx: ^~ /api/model-chats/ 915s');
    const ollama = byMatcher.get('^/api/models/[^/]+/ollama/');
    assert.ok(ollama && ollama.kind === 'regex' && ollama.readMs === 615000, 'nginx: ollama-regex 615s');
    const archive = byMatcher.get('/api/asset-sources/archive');
    assert.ok(
        archive && archive.kind === 'exact' && archive.readMs === 605000 && archive.sendMs === 605000,
        'nginx: /api/asset-sources/archive 605s read+send (proxy_request_buffering off)',
    );
});

test('Token-exchange: отдельная nginx-зона на /auth/callback (OQ3)', () => {
    assert.ok(
        /limit_req_zone\s+\$binary_remote_addr\s+zone=neurocenter_token_exchange:\d+m\s+rate=10r\/m;/.test(nginxTemplate),
        'nginx: limit_req_zone neurocenter_token_exchange 10r/m',
    );
    const callback = locations.find((location) => location.kind === 'exact' && location.matcher === '/auth/callback');
    assert.ok(callback, 'nginx: location = /auth/callback');
});

test('Body-цепочка nginx → gateway → catalog не растёт к центру; 40MiB проходит всю цепь', () => {
    // nginx: server-level client_max_body_size (dedicated 8g на archive — только шире).
    const serverBody = nginxTemplate.match(/client_max_body_size\s+([^\s;]+);\s*\n/);
    assert.ok(serverBody, 'nginx: server-level client_max_body_size');
    const nginxNominal = Number(serverBody[1].replace(/[kmg]$/i, '')); // '50m' → 50
    const nginxLimit = nginxBytes(serverBody[1]); // 50m = 52 428 800 B
    // gateway: global json-лимит default-строки (десятичные 50*1000^2, body-parser).
    const gatewayLimit = CATCH_ALL_ROW.maxBodyBytes;
    const gatewayNominal = Math.round(gatewayLimit / 1000 ** 2);
    // catalog: express.json limit — та же десятичная семантика body-parser ('mb' = 10^6 B).
    const catalogMain = fs.readFileSync(path.join(repoRoot, 'services/catalog-service/src/main.ts'), 'utf8');
    const catalogLimitMatch = catalogMain.match(/limit:\s*'(\d+)mb'/);
    assert.ok(catalogLimitMatch, 'catalog: express.json limit в main.ts');
    const catalogNominal = Number(catalogLimitMatch[1]); // '50mb' → 50
    const catalogLimit = catalogNominal * 1000 ** 2;

    assert.ok(
        nginxNominal >= gatewayNominal && gatewayNominal >= catalogNominal,
        `body «растёт к центру»: nginx ${nginxNominal} / gateway ${gatewayNominal} / catalog ${catalogNominal}`,
    );
    const fortyMiB = 40 * 1024 ** 2; // OQ2: 40MB catalog-json обязан пройти цепь
    assert.ok(fortyMiB <= nginxLimit, `nginx ${nginxLimit}B < 40MiB — кромка режет тело до gateway`);
    assert.ok(fortyMiB <= gatewayLimit, `gateway ${gatewayLimit}B < 40MiB`);
    assert.ok(fortyMiB <= catalogLimit, `catalog ${catalogLimit}B < 40MiB`);
    assert.ok(
        gatewayLimit <= catalogLimit,
        `gateway ${gatewayLimit}B > catalog ${catalogLimit}B — opaque 413 со стороны каталога`,
    );
});
