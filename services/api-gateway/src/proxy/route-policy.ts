import { canonicalAccessRoute } from '../../../shared/access-route.cjs';
import { MODEL_CHAT_GATEWAY_TIMEOUT_MS } from '../../../shared/model-chat-deadline.cjs';
import { TOOL_IMPORT_GATEWAY_TIMEOUT_MS, TOOL_IMPORT_ROUTE } from '../../../shared/tool-import-deadline.cjs';
import {
    discussionAttachmentDownloadRoute,
    discussionAttachmentUploadRoute,
    DISCUSSION_ATTACHMENT_MAX_BYTES,
} from '../../../shared/discussion-attachment-route.cjs';
import { snapshotContentRoute, snapshotDownloadRoute } from '../../../shared/snapshot-content-route.cjs';
import {
    EMBEDDING_CLIENT_TIMEOUT_MS,
    EMBEDDING_UPSTREAM_TIMEOUT_MS,
} from '../../../shared/model-embedding-deadline.cjs';
import { SNAPSHOT_CHUNK_BYTES } from '../../../shared/project-snapshot.cjs';
import { sourceUploadContentRoute } from '../../../shared/source-upload-route.cjs';
import { ggufImportContentRoute } from '../../../shared/gguf-import-route.cjs';
import {
    assetSourceArchiveRoute,
    ASSET_SOURCE_ARCHIVE_MAX_BYTES,
} from '../../../shared/asset-source-archive-route.cjs';
import { CEILING } from '../../../shared/runtime-artifacts.cjs';

/**
 * AD-6: декларативная таблица роут-политики gateway. Таблица — данные, не логика:
 * прокси (ProxyService.forward + special-forward'ы) — чистый механизм, читает бюджеты
 * через matchPolicy(method, path).
 *
 * Два слоя строк:
 *  - kind 'route' — маршруты собранного NestJS-приложения (router.stack); паттерн в
 *    каноническом виде (без ведущего префикса `api/` — OQ3: один канонический паттерн
 *    покрывает и /bridge/*, и /api/bridge/*); postCreate — маршруты вне NestJS-модулей
 *    (Swagger /api/docs, socket.io — регистрируются после bootstrap);
 *  - kind 'proxy' — подмаршруты catch-all `api/{*path}`: special-forward'ы, которые
 *    диспетчер в ProxyService выбирает по supplyPath. Матчер — та же роут-функция, что
 *    и в диспетчере (services/shared/*.cjs), поэтому dispatch и политика не дрейфуют.
 *
 * AD-6: `maxResponseBytes`/`maxBodyBytes` обязаны быть конечными — Infinity и -1
 * запрещены (проверяется при загрузке модуля и static-тестом
 * scripts/test/route-policy-completeness.test.mjs).
 *
 * Значения — текущие (entry 9: лестницы из base+margins, embedding 110/115s):
 * 30s-default, 60s bridge-source/check, 85s tool-builds inspection, 610s/910s inference,
 * 540s tool-import, 300s tool-supply, 120s snapshot chunk, 110/115s embedding,
 * 64MB model-chats, 8MB inference/embedding, 50mb global body, 600KB device-channel,
 * 10MB discussion attachments, 1MiB/16MiB/256MiB supply, 64MiB chunks, 1GiB bridge.
 */

const KIB = 1024;
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

/** Методы маршрута из декораторов; ALL = @All, WS = WebSocket-маркер (бюджеты не применимы). */
export type TRouteMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'ALL' | 'WS';

/** Rate-limit окна (entry 9: PG-счётчики, multi-replica-safe; fail-closed 503 при PG-сбое). */
export interface IRouteRateLimit {
    max: number;
    windowMs: number;
}

export interface IRouteRow {
    kind: 'route' | 'proxy';
    /** route: Express-паттерн в каноническом виде; proxy: человекочитаемый ярлык подмаршрута. */
    path: string;
    allowed: TRouteMethod[];
    /** route: маршрут вне router.stack (регистрируется после bootstrap Nest-приложения). */
    postCreate?: boolean;
    /** proxy: матчер подмаршрута (method, rawPath) — та же роут-функция, что в диспетчере. */
    match?: (method: string, path: string) => unknown;
    /** Axios/client-дедлайн маршрута, мс. */
    timeoutMs?: number;
    /** Дедлайн вызова innermost upstream, мс; должен быть строго меньше timeoutMs
     *  (client-timer — внешний владелец «истёк», upstream падает первым с margin > 0). */
    upstreamTimeoutMs?: number;
    /** Лимит входящего тела, байты (express.json / axios maxBodyLength). */
    maxBodyBytes?: number;
    /** Бюджет ответа, байты (axios maxContentLength). AD-6: только конечные значения. */
    maxResponseBytes?: number;
    rateLimit?: IRouteRateLimit;
}

/** Default-строка (catch-all `api/{*path}`): finite maxResponseBytes ОБЯЗАТЕЛЕН (AD-6). */
export interface IDefaultRouteRow extends IRouteRow {
    maxResponseBytes: number;
}

/** Канонический вид маршрута: без ведущего префикса `api/` (OQ3). */
export function canonicalRoutePath(value: string | undefined): string | undefined {
    const route = canonicalAccessRoute(value);
    return route === undefined ? undefined : route.replace(/^\/api\//, '/');
}

/** Канал OpenCode: те же regex'ы, что в modelInferenceRoute (model-inference-forward.ts);
 *  расхождение ловит inventory-часть completeness-теста по sample-маршрутам. */
const MODEL_INFERENCE_CHAT = /^\/api\/model-chats\/[a-f0-9-]{36}\/(?:attachments|turns(?:\/[a-f0-9-]{36}\/retry)?)$/;
const MODEL_INFERENCE_OLLAMA =
    /^\/api\/models\/[^/]+\/ollama\/(?:api\/(?:chat|embed)|v1\/(?:chat\/completions|embeddings))$/;

const deviceChannelSuffix = (value: string | undefined): string | undefined => canonicalAccessRoute(value);

export const CATCH_ALL_PATH = '/{*path}';

/** Default-маршрут: остальной /api/* (axios 30s, global json 50mb, ответ finite). */
export const CATCH_ALL_ROW: IDefaultRouteRow = {
    kind: 'route',
    path: CATCH_ALL_PATH,
    allowed: ['ALL'],
    timeoutMs: 30000,
    // express.json limit был строкой '50mb' — в body-parser это десятичные 50*1000^2 байта
    // (тот же лимит, что и в skills-service), а не 50 MiB.
    maxBodyBytes: 50 * 1000 ** 2,
    maxResponseBytes: CEILING.unpackedBytes,
};

export const ROUTE_POLICY: readonly IRouteRow[] = [
    // --- Явные маршруты контроллеров (router.stack; канонический вид без /api/) ---
    { kind: 'route', path: '/ready', allowed: ['GET'] },
    { kind: 'route', path: '/ready/dependencies', allowed: ['GET'] },
    { kind: 'route', path: '/health', allowed: ['GET'] },
    // bridge: дедлайн маршрута 600s (bridgeRequest); конфиг — метаданные 128KB, runtime — пакет до 1GiB.
    { kind: 'route', path: '/bridge/config', allowed: ['GET'], timeoutMs: 600000, maxResponseBytes: 128 * KIB },
    { kind: 'route', path: '/bridge/install.sh', allowed: ['GET'], timeoutMs: 600000 },
    { kind: 'route', path: '/bridge/connect.sh', allowed: ['GET'], timeoutMs: 600000 },
    { kind: 'route', path: '/bridge/connect.ps1', allowed: ['GET'], timeoutMs: 600000 },
    { kind: 'route', path: '/bridge/install_opencode.sh', allowed: ['GET'], timeoutMs: 600000 },
    { kind: 'route', path: '/bridge/install.ps1', allowed: ['GET'], timeoutMs: 600000 },
    { kind: 'route', path: '/bridge/install_opencode.ps1', allowed: ['GET'], timeoutMs: 600000 },
    { kind: 'route', path: '/bridge/install_workspace.sh', allowed: ['GET'], timeoutMs: 600000 },
    { kind: 'route', path: '/bridge/install_workspace.ps1', allowed: ['GET'], timeoutMs: 600000 },
    { kind: 'route', path: '/bridge/opencode/:file', allowed: ['GET'] },
    { kind: 'route', path: '/bridge/runtime/:file', allowed: ['GET'], timeoutMs: 600000, maxResponseBytes: GIB },
    // Внутренние контроллеры: бюджеты зафиксированы декларативно (read — entry 9).
    { kind: 'route', path: '/internal/bridge/opencode-cli-supply/:target', allowed: ['GET'], timeoutMs: 20000 },
    { kind: 'route', path: '/mcp-host/connect', allowed: ['POST'], timeoutMs: 15000, maxBodyBytes: 4 * MIB },
    { kind: 'route', path: '/mcp-host/m/:ticket', allowed: ['ALL'] },
    { kind: 'route', path: '/internal/research-mcp/list', allowed: ['POST'], timeoutMs: 45000 },
    { kind: 'route', path: '/internal/research-mcp/call', allowed: ['POST'], timeoutMs: 45000 },
    { kind: 'route', path: '/internal/system-role-mcp/execute', allowed: ['POST'], timeoutMs: 45000, maxResponseBytes: 8 * MIB },
    { kind: 'route', path: '/internal/system-role-mcp/close', allowed: ['POST'] },
    { kind: 'route', path: '/internal/events', allowed: ['POST'] },
    // Пост-создание (вне NestJS-модулей): доки GET/HEAD only; socket.io — WS, бюджеты не применимы.
    { kind: 'route', path: '/docs', allowed: ['GET', 'HEAD'], postCreate: true },
    { kind: 'route', path: '/socket.io', allowed: ['WS'], postCreate: true },
    CATCH_ALL_ROW,

    // --- Подмаршруты catch-all: special-forward'ы (матчеры = роут-функции диспетчера) ---
    // ВНИМАНИЕ: порядок важен — конкретные строки раньше широких (model-chats, device-channel).
    {
        kind: 'proxy',
        path: '/api/model-chats/:id/turns',
        allowed: ['POST'],
        timeoutMs: MODEL_CHAT_GATEWAY_TIMEOUT_MS,
        maxResponseBytes: 64 * MIB,
        match: (m, p) => m === 'POST' && MODEL_INFERENCE_CHAT.test(deviceChannelSuffix(p) || ''),
    },
    {
        kind: 'proxy',
        path: '/api/models/:model/ollama/*',
        allowed: ['POST'],
        // Исторический 8 MiB текстовый ответ при JSON-эскейпинге может вырасти в шесть раз.
        timeoutMs: 610000,
        maxResponseBytes: 8 * MIB,
        match: (m, p) => m === 'POST' && MODEL_INFERENCE_OLLAMA.test(deviceChannelSuffix(p) || ''),
    },
    {
        kind: 'proxy',
        path: '/api/tool-builds/imports',
        allowed: ['POST'],
        timeoutMs: TOOL_IMPORT_GATEWAY_TIMEOUT_MS,
        match: (m, p) => m === 'POST' && deviceChannelSuffix(p) === TOOL_IMPORT_ROUTE,
    },
    {
        kind: 'proxy',
        path: '/api/tool-builds/:id/supply',
        allowed: ['GET', 'HEAD'],
        timeoutMs: 300000,
        maxResponseBytes: CEILING.unpackedBytes,
        match: (m, p) => ['GET', 'HEAD'].includes(m) && /^\/api\/tool-builds\/[a-fA-F0-9-]{36}\/supply$/.test(deviceChannelSuffix(p) || ''),
    },
    {
        kind: 'proxy',
        path: '/api/tool-builds/:id/asset',
        allowed: ['GET'],
        timeoutMs: 300000,
        maxResponseBytes: 16 * MIB,
        match: (m, p) => m === 'GET' && /^\/api\/tool-builds\/[a-fA-F0-9-]{36}\/asset$/.test(deviceChannelSuffix(p) || ''),
    },
    {
        kind: 'proxy',
        path: '/api/tool-builds/uploads/:id/content',
        allowed: ['PUT'],
        timeoutMs: 600000,
        maxBodyBytes: 256 * MIB,
        maxResponseBytes: MIB,
        match: sourceUploadContentRoute,
    },
    {
        // Лимит тела и таймаут владение квитанцией каталога (receipt), не таблицей.
        kind: 'proxy',
        path: '/api/models/gguf-imports/:id/content',
        allowed: ['PUT'],
        maxResponseBytes: MIB,
        match: ggufImportContentRoute,
    },
    {
        kind: 'proxy',
        path: '/api/discussions/attachments',
        allowed: ['POST'],
        timeoutMs: 600000,
        maxBodyBytes: DISCUSSION_ATTACHMENT_MAX_BYTES,
        maxResponseBytes: MIB,
        match: discussionAttachmentUploadRoute,
    },
    {
        kind: 'proxy',
        path: '/api/discussions/attachments/:id/content',
        allowed: ['GET', 'HEAD'],
        timeoutMs: 30000,
        maxResponseBytes: DISCUSSION_ATTACHMENT_MAX_BYTES,
        match: discussionAttachmentDownloadRoute,
    },
    {
        kind: 'proxy',
        path: '/api/projects/:key/snapshot-uploads/:id/blobs/:sha',
        allowed: ['PUT'],
        timeoutMs: 600000,
        maxBodyBytes: SNAPSHOT_CHUNK_BYTES,
        // Каталог отвечает на загрузку блока небольшим JSON-подтверждением (бюджет 1 MiB).
        maxResponseBytes: MIB,
        match: snapshotContentRoute,
    },
    {
        kind: 'proxy',
        path: '/api/asset-sources/archive',
        allowed: ['PUT'],
        timeoutMs: 600000,
        maxBodyBytes: ASSET_SOURCE_ARCHIVE_MAX_BYTES,
        maxResponseBytes: 64 * MIB,
        match: assetSourceArchiveRoute,
    },
    {
        kind: 'proxy',
        path: '/api/projects/:key/versions/:id/blobs/:sha',
        allowed: ['GET', 'HEAD'],
        timeoutMs: 120000,
        maxResponseBytes: SNAPSHOT_CHUNK_BYTES,
        match: snapshotDownloadRoute,
    },
    {
        kind: 'proxy',
        path: '/api/projects/:key/backups/:id/download',
        allowed: ['GET', 'HEAD'],
        timeoutMs: 30000,
        maxResponseBytes: CEILING.unpackedBytes,
        match: (m, p) => ['GET', 'HEAD'].includes(m) && /\/backups\/[^/]+\/download\/*$/.test(p || ''),
    },
    {
        kind: 'proxy',
        path: '/api/device-channel/jobs/:id/runtime/:sha',
        allowed: ['GET'],
        timeoutMs: 30000,
        maxResponseBytes: 256 * MIB,
        match: (m, p) => m === 'GET' && /^\/api\/device-channel\/jobs\/[a-f0-9-]{36}\/runtime\/[a-f0-9]{64}$/.test(deviceChannelSuffix(p) || ''),
    },
    {
        // Ladder (embedding, base 110s + margin 5s): upstream gives up at 110s,
        // client timer owns the 115s deadline — race 115==115 closed (entry 9).
        kind: 'proxy',
        path: '/api/device-channel/embedding',
        allowed: ['POST'],
        timeoutMs: EMBEDDING_CLIENT_TIMEOUT_MS,
        upstreamTimeoutMs: EMBEDDING_UPSTREAM_TIMEOUT_MS,
        maxResponseBytes: 8 * MIB,
        match: (m, p) => m === 'POST' && deviceChannelSuffix(p) === '/api/device-channel/embedding',
    },
    {
        kind: 'proxy',
        path: '/api/bridge-source/check',
        allowed: ['POST'],
        timeoutMs: 60000,
        match: (m, p) => m === 'POST' && deviceChannelSuffix(p) === '/api/bridge-source/check',
    },
    {
        // Source inspection chains external reads; leave time to return before the client's 90 s deadline.
        kind: 'proxy',
        path: '/api/tool-builds/repository|npm',
        allowed: ['GET'],
        timeoutMs: 85000,
        match: (m, p) => m === 'GET' && /^\/api\/tool-builds\/(?:repository|npm)$/.test(deviceChannelSuffix(p) || ''),
    },
    {
        kind: 'proxy',
        path: '/api/model-chats/*',
        allowed: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'],
        maxResponseBytes: 64 * MIB,
        match: (m, p) => /^\/api\/model-chats(?:\/|$)/.test(deviceChannelSuffix(p) || ''),
    },
    {
        // rateLimit — окно pair/start на адрес (полная лестница poll 6000/мин и per-code 60/мин
        // применяется диспетчером deviceChannel; PG-счётчики — entry 9, fail-closed 503).
        kind: 'proxy',
        path: '/api/device-channel/*',
        allowed: ['POST'],
        timeoutMs: 30000,
        maxBodyBytes: 600 * KIB,
        rateLimit: { max: 15, windowMs: 60000 },
        match: (m, p) => m === 'POST' && /^\/api\/device-channel\//.test(deviceChannelSuffix(p) || ''),
    },
];

const assertValidBudget = (row: IRouteRow): void => {
    for (const [name, value] of Object.entries({
        timeoutMs: row.timeoutMs,
        upstreamTimeoutMs: row.upstreamTimeoutMs,
        maxBodyBytes: row.maxBodyBytes,
        maxResponseBytes: row.maxResponseBytes,
    })) {
        if (value === undefined) continue;
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
            throw new Error(
                `route-policy: ${row.path} ${name} обязан быть конечным положительным числом (AD-6 запрещает Infinity и -1).`,
            );
        }
    }
    // Ladder invariant: upstream is innermost, so its deadline must be strictly
    // smaller than the client deadline it is wrapped by (margin > 0, entry 9).
    if (row.upstreamTimeoutMs !== undefined && row.timeoutMs !== undefined && row.upstreamTimeoutMs >= row.timeoutMs) {
        throw new Error(
            `route-policy: ${row.path} upstreamTimeoutMs обязан быть строго меньше timeoutMs (ladder: внешний > внутренний).`,
        );
    }
    if (
        row.rateLimit !== undefined &&
        (!Number.isInteger(row.rateLimit.max) || row.rateLimit.max <= 0 || !Number.isInteger(row.rateLimit.windowMs) || row.rateLimit.windowMs <= 0)
    ) {
        throw new Error(`route-policy: ${row.path} rateLimit обязан содержать положительные целые max и windowMs.`);
    }
};

for (const row of ROUTE_POLICY) assertValidBudget(row);

const routePatterns = new Map<string, RegExp>();
for (const row of ROUTE_POLICY) {
    if (row.kind !== 'route' || row.path === CATCH_ALL_PATH) continue;
    // Express-паттерн: ':param' — один сегмент, остальное — дословно.
    const source = row.path
        .split('/')
        .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('/');
    routePatterns.set(row.path, new RegExp('^' + source + '$'));
}

const methodAllowed = (row: IRouteRow, method: string): boolean =>
    row.allowed.includes(method as TRouteMethod) || row.allowed.includes('ALL');

/**
 * Политика для (method, path): сначала proxy-подмаршруты catch-all (та же логика выбора,
 * что и диспетчер), затем явные маршруты (канонический паттерн), иначе default-строка.
 */
export function matchPolicy(method: string, path: string): IRouteRow {
    const m = String(method || 'GET').toUpperCase();
    const p = typeof path === 'string' ? path : '';
    for (const row of ROUTE_POLICY) {
        // Роут-функции возвращают путь или undefined, боол-матчеры — true/false:
        // истинность единственная корректная проверка для обоих типов.
        if (row.kind === 'proxy' && row.match && row.match(m, p) && methodAllowed(row, m)) return row;
    }
    const canonical = canonicalRoutePath(p);
    if (canonical !== undefined) {
        for (const row of ROUTE_POLICY) {
            if (row.kind !== 'route' || row.path === CATCH_ALL_PATH || !methodAllowed(row, m)) continue;
            if (routePatterns.get(row.path)!.test(canonical)) return row;
        }
    }
    return CATCH_ALL_ROW;
}
