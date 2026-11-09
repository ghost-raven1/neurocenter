import {
    discussionAttachmentUploadRoute,
    discussionAttachmentDownloadRoute,
} from '../../../shared/discussion-attachment-route.cjs';
import { forwardDiscussionAttachment } from './discussion-attachment-download';
import {
    snapshotContentRoute,
    snapshotDownloadRoute,
    snapshotPublicationRoute,
} from '../../../shared/snapshot-content-route.cjs';
import { forwardSnapshotChunk } from './snapshot-stream';
import { sourceUploadContentRoute } from '../../../shared/source-upload-route.cjs';
import { ggufImportContentRoute } from '../../../shared/gguf-import-route.cjs';
import { forwardGgufImport } from './gguf-import-stream';
import { forwardSourceUpload } from './source-upload-stream';
import { assetSourceArchiveRoute } from '../../../shared/asset-source-archive-route.cjs';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { deviceCredentialTransport } from '../security/device-credential-transport';

import { filterResponse, IResourceClaims } from './access-response';
import { AuthGuardService, IAuthPayload } from '../auth/auth-guard.service';
import { LiveService } from '../live/live.service';
import { forwardRuntimeArtifact } from './runtime-artifact-stream';
import { forwardBackupDownload } from './backup-download-stream';
import { forwardToolAssetDocument, forwardToolSupply } from './tool-supply-stream';
import { featureFlagsFailure, requiredFeatureFlags } from '../features/feature-flag-gate';
import { awaitEmbedding } from './embedding-deadline';
import { canonicalAccessRoute } from '../../../shared/access-route.cjs';
import { forwardModelInference, modelInferenceRoute } from './model-inference-forward';
import { publicAppearance } from '../features/public-appearance';
import { forwardToolImport } from './tool-import-forward';
import { TOOL_IMPORT_ROUTE } from '../../../shared/tool-import-deadline.cjs';
import { CATCH_ALL_ROW, matchPolicy } from './route-policy';
import { RateLimitStore, TRateLimitScope } from '../rate-limit/rate-limit-store';

type THttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

const STRIP_HEADERS = new Set([
    'x-neurocenter-internal',
    'x-neurocenter-device-id',
    'host',
    'content-length',
    'accept-encoding',
    'connection',
    'transfer-encoding',
]);

/**
 * Прокси-логика gateway: auth-guard, затем маршрутизация подпотоков
 * `/api/skills/**` → skills-service, остальное → catalog-service.
 * Инжект identity: x-bridge-user-id / x-bridge-roles / x-bridge-policies.
 */
@Injectable()
export class ProxyService {
    private readonly catalogUrl: string;
    private readonly skillsUrl: string;
    private readonly ragUrl: string;
    private readonly featureFlagsUrl: string;
    private readonly http: AxiosInstance;
    private rateLimitStore?: RateLimitStore;

    constructor(
        private readonly configService: ConfigService,
        private readonly authGuard: AuthGuardService,
        private readonly live: LiveService,
    ) {
        this.catalogUrl = (configService.get<string>('CATALOG_SERVICE_URL') || 'http://localhost:4100').replace(
            /\/+$/,
            '',
        );
        this.skillsUrl = (configService.get<string>('SKILLS_SERVICE_URL') || 'http://localhost:4200').replace(
            /\/+$/,
            '',
        );
        this.ragUrl = (configService.get<string>('RAG_SERVICE_URL') || 'http://localhost:4300').replace(/\/+$/, '');
        this.featureFlagsUrl = (
            configService.get<string>('FEATURE_FLAGS_SERVICE_URL') || 'http://localhost:4400'
        ).replace(/\/+$/, '');
        // Базовый клиент: дефолтный деадлайн и ответный бюджет — из default-строки route-policy (AD-6).
        this.http = axios.create({ timeout: CATCH_ALL_ROW.timeoutMs, validateStatus: () => true });
    }

    /** PG-счётчики pairing-окон (entry 9, AD-6): ленивый пул, URL — CATALOG_PG_URL без fallback. */
    private get rateLimit(): RateLimitStore {
        if (!this.rateLimitStore) {
            this.rateLimitStore = new RateLimitStore(this.configService.get<string>('CATALOG_PG_URL'));
        }
        return this.rateLimitStore;
    }

    /**
     * Проверяет сессию, выбирает upstream (skills/catalog), пересылает запрос и копирует ответ.
     *
     * @param {Request} req - входящий
     * @param {Response} res - исходящий
     * @returns {Promise<void>}
     */
    public async forward(req: Request, res: Response): Promise<void> {
        // Private chat history and missing receipts must stay fresh across session and commit changes.
        if (
            /^\/api\/(?:device-jobs\/requests|system-role-chats|agent-tools)(?:\/|$)/.test(
                canonicalAccessRoute(req.path) || '',
            )
        )
            res.setHeader('Cache-Control', 'no-store');
        if (req.method === 'GET' && req.path === '/api/ui/appearance') {
            res.setHeader('Cache-Control', 'no-store');
            res.json(await publicAppearance(this.http, this.featureFlagsUrl));
            return;
        }
        if (req.path.startsWith('/api/device-channel/')) {
            await this.deviceChannel(req, res);
            return;
        }
        const inference = modelInferenceRoute((req.method || 'GET').toUpperCase(), canonicalAccessRoute(req.path));
        const inferenceOpen = () => !inference || (!req.aborted && !res.destroyed && !res.writableEnded);
        if (!inferenceOpen()) return;
        const auth = await this.authGuard.authenticate(req);
        if (!inferenceOpen()) return;

        if (!auth) {
            res.status(401).json({ error: 'unauthorized' });
            return;
        }

        const path = req.path;
        const method = (req.method || 'GET').toUpperCase() as THttpMethod;
        const coordinatedRagSync = method === 'POST' && canonicalAccessRoute(path) === '/api/rag/sync';
        const upstreamBase = /^\/api\/feature-flags(?:\/|$)/.test(path)
            ? this.featureFlagsUrl
            : coordinatedRagSync
              ? this.catalogUrl
              : path.startsWith('/api/rag')
                ? this.ragUrl
                : path.startsWith('/api/skills')
                  ? this.skillsUrl
                  : this.catalogUrl;
        const snapshotPublication = snapshotPublicationRoute(method, path);
        const canonicalPath = canonicalAccessRoute(path);
        if (
            /^\/api\/(?:chat-system-roles|model-chats|chat-presence|help|discussions|catalog-reactions)(?:\/|$)/.test(
                canonicalPath || '',
            )
        )
            res.setHeader('Cache-Control', 'no-store');
        const learningRoute = /^\/api\/projects\/[^/]+\/learning(?:[/%]|$)/.test(canonicalPath || '');
        const agentTrialRoute =
            /^\/api\/projects\/[^/]+\/agents\/(?:readiness(?:[/%]|$)|.*\/readiness-trials(?:[/%]|$))/.test(
                canonicalPath || '',
            );
        const projectChatRoute = /^\/api\/projects\/[^/]+\/(?:team-chat|chat-search)(?:[/%]|$)/.test(
            canonicalPath || '',
        );
        if (learningRoute || agentTrialRoute || projectChatRoute) res.setHeader('Cache-Control', 'no-store');
        if (auth.deviceId && (canonicalPath === undefined || learningRoute || agentTrialRoute || projectChatRoute)) {
            res.status(403).json({
                message: projectChatRoute
                    ? 'Командный чат доступен пользователям через интерфейс проекта.'
                    : agentTrialRoute
                      ? 'Испытания агента доступны только пользователю через интерфейс проекта.'
                      : 'Проектное обучение доступно мосту только через проверенную привязку папки.',
            });
            return;
        }
        if (
            auth.deviceId &&
            !(
                (!!snapshotPublication &&
                    !!req.headers['x-neurocenter-job-id'] &&
                    !!req.headers['x-neurocenter-job-lease']) ||
                (['GET', 'HEAD'].includes(method) && /^\/api\/(projects|ai-plugins|skills|rag)(\/|$)/.test(path)) ||
                (method === 'POST' && ['/api/skills/sync', '/api/rag/sync'].includes(path))
            )
        ) {
            res.status(403).json({
                message: 'Подключение MCP не даёт прав управления пользователями, каталогом или настройками сервера.',
            });
            return;
        }

        try {
            const payload = req.body as Record<string, unknown> | undefined;
            if (auth.deviceId && (req.headers['x-neurocenter-job-id'] || req.headers['x-neurocenter-job-lease'])) {
                const jobId = String(req.headers['x-neurocenter-job-id'] || '');
                const lease = String(req.headers['x-neurocenter-job-lease'] || '');
                if (!/^[a-f0-9-]{36}$/.test(jobId) || !/^[a-f0-9-]{36}$/.test(lease)) {
                    res.status(403).json({ message: 'Некорректная аренда задания.' });
                    return;
                }
                const snapshotReceipt =
                    !!snapshotPublication &&
                    ((/\/snapshot-uploads\/[^/]+\/status$/.test(canonicalPath || '') && method === 'GET') ||
                        (/\/snapshot-uploads\/[^/]+\/complete$/.test(canonicalPath || '') && method === 'POST'));
                const job = await this.http.post(
                    `${this.catalogUrl}/internal/device-channel/jobs/${jobId}/authorize${snapshotReceipt ? '?phase=snapshot-receipt' : ''}`,
                    { lease },
                    {
                        headers: {
                            authorization: req.headers.authorization,
                            'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN || '',
                        },
                    },
                );
                if (
                    job.status < 200 ||
                    job.status >= 300 ||
                    !(snapshotPublication
                        ? job.data.projectId === snapshotPublication.projectId &&
                          job.data.snapshotId === snapshotPublication.snapshotId &&
                          job.data.snapshotProtocol === 'project-snapshots-v1'
                        : path.startsWith('/api/rag/') &&
                          job.data.projectId === String(payload?.projectKey || req.query.projectKey || ''))
                ) {
                    res.status(403).json({ message: 'Доступ задания к проекту отозван или его аренда истекла.' });
                    return;
                }
                auth.activeRole = String(job.data.role);
            }
            const decision = await this.http.post<{ allowed: boolean; claims: IResourceClaims }>(
                `${this.catalogUrl}/internal/access/authorize`,
                {
                    email: auth.email,
                    activeRole: auth.activeRole,
                    method,
                    path,
                    query: req.query,
                    body: payload
                        ? {
                              projectKey: payload.projectKey,
                              projectName: payload.projectName,
                              path: payload.path,
                              role: payload.role,
                          }
                        : {},
                },
                { headers: { 'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN || '' } },
            );
            if (!inferenceOpen()) return;
            if (decision.status !== 201 && decision.status !== 200) {
                res.status(decision.status === 403 ? 403 : 503).json({
                    message: 'Не удалось проверить доступ к ресурсу.',
                });
                return;
            }
            if (!decision.data.allowed) {
                res.status(403).json({ message: 'Активная роль не разрешает это действие в данном проекте.' });
                return;
            }
            const flags = requiredFeatureFlags(method, path, req.body);
            if (flags.length) {
                const failure = await featureFlagsFailure(this.http, this.featureFlagsUrl, flags);
                if (!inferenceOpen()) return;
                if (failure) {
                    res.setHeader('Cache-Control', 'no-store');
                    res.status(failure.status).json(failure);
                    return;
                }
            }
            if (/^\/api\/feature-flags(?:\/|$)/.test(path)) res.setHeader('Cache-Control', 'no-store');
            const ggufUpload = ggufImportContentRoute(method, path);
            if (ggufUpload) {
                await forwardGgufImport(
                    this.http,
                    `${this.catalogUrl}${ggufUpload}`,
                    this.buildHeaders(req.headers, auth),
                    req,
                    res,
                );
                return;
            }
            const discussionUpload = discussionAttachmentUploadRoute(method, path);
            if (discussionUpload) {
                const query = new URLSearchParams();
                for (const key of ['targetType', 'targetId'])
                    if (typeof req.query[key] === 'string') query.set(key, req.query[key] as string);
                if (!req.headers['content-length']) {
                    res.status(411).json({ message: 'Укажите размер прикрепляемого файла.' });
                    return;
                }
                // Лимиты тела/ответа/дедлайн загрузок — из route-политики (строка /api/discussions/attachments).
                await forwardSourceUpload(
                    this.http,
                    `${this.catalogUrl}${discussionUpload}?${query}`,
                    this.buildHeaders(req.headers, auth),
                    req,
                    res,
                    'POST',
                );
                return;
            }
            const discussionDownload = discussionAttachmentDownloadRoute(method, path);
            if (discussionDownload) {
                await forwardDiscussionAttachment(
                    this.http,
                    `${this.catalogUrl}${discussionDownload}`,
                    this.buildHeaders(req.headers, auth),
                    req,
                    res,
                );
                return;
            }
            const archiveRoute = assetSourceArchiveRoute(method, path);
            const uploadRoute =
                sourceUploadContentRoute(method, path) || snapshotContentRoute(method, path) || archiveRoute;
            if (uploadRoute) {
                // source/snapshot/archive: лимиты тела/ответа/дедлайн — из route-политики
                // (строка подмаршрута выбирается тем же роут-матчером, что и загрузка).
                await forwardSourceUpload(
                    this.http,
                    `${this.catalogUrl}${uploadRoute}`,
                    this.buildHeaders(req.headers, auth),
                    req,
                    res,
                );
                return;
            }
            const snapshotDownload = snapshotDownloadRoute(method, path);
            if (snapshotDownload) {
                await forwardSnapshotChunk(
                    this.http,
                    `${this.catalogUrl}${snapshotDownload}`,
                    this.buildHeaders(req.headers, auth),
                    req,
                    res,
                );
                return;
            }
            const supplyPath = canonicalAccessRoute(path);
            if (
                ['GET', 'HEAD'].includes(method) &&
                /^\/api\/tool-builds\/[a-fA-F0-9-]{36}\/supply$/.test(supplyPath || '')
            ) {
                await forwardToolSupply(
                    this.http,
                    `${this.catalogUrl}${supplyPath}`,
                    this.buildHeaders(req.headers, auth),
                    req,
                    res,
                );
                return;
            }
            if (method === 'GET' && /^\/api\/tool-builds\/[a-fA-F0-9-]{36}\/asset$/.test(supplyPath || '')) {
                await forwardToolAssetDocument(
                    this.http,
                    `${this.catalogUrl}${supplyPath}`,
                    this.buildHeaders(req.headers, auth),
                    req,
                    res,
                );
                return;
            }
            if (['GET', 'HEAD'].includes(method) && /\/backups\/[^/]+\/download\/*$/.test(path)) {
                await forwardBackupDownload(
                    this.http,
                    `${upstreamBase}${path}`,
                    this.buildHeaders(req.headers, auth),
                    req,
                    res,
                );
                return;
            }
            // AD-6: бюджеты запроса (дедлайн/ответ) — из декларативной route-политики;
            // дефолт — default-строка catch-all (та же 30 s, что и у базового клиента).
            const policy = matchPolicy(method, path);
            const upstreamRequest = {
                method,
                ...(policy.timeoutMs !== undefined && policy.timeoutMs !== CATCH_ALL_ROW.timeoutMs
                    ? { timeout: policy.timeoutMs }
                    : {}),
                ...(policy.maxResponseBytes !== undefined ? { maxContentLength: policy.maxResponseBytes } : {}),
                responseType: 'json' as const,
                url: `${upstreamBase}${coordinatedRagSync ? '/api/rag/sync' : path}`,
                headers: this.buildHeaders(req.headers, auth),
                params: req.query,
                data: req.body,
            };
            const upstream = inference
                ? await forwardModelInference(this.http, upstreamRequest, req, res)
                : method === 'POST' && supplyPath === TOOL_IMPORT_ROUTE
                  ? await forwardToolImport(this.http, upstreamRequest, req, res)
                  : await this.http.request(upstreamRequest);
            if (!upstream) return;

            res.status(upstream.status);
            if (typeof upstream.headers['content-disposition'] === 'string') {
                res.setHeader('content-disposition', upstream.headers['content-disposition']);
            }
            const contentType = upstream.headers['content-type'];

            if (typeof contentType === 'string') {
                res.setHeader('Content-Type', contentType);
            }

            const body = filterResponse(upstream.data, decision.data.claims, auth.activeRole, path);
            // Express send(null) means no body; an explicit JSON null is a valid empty selection.
            if (
                body === null &&
                typeof contentType === 'string' &&
                /^application\/(?:[a-z0-9.+_-]+\+)?json(?:\s*;|$)/i.test(contentType)
            )
                res.json(null);
            else res.send(body);
            if (
                upstream.status >= 200 &&
                upstream.status < 300 &&
                !['GET', 'HEAD', 'OPTIONS'].includes(method) &&
                !/^\/api\/(?:models\/[^/]+\/ollama\/|model-chats(?:\/|$))/.test(path)
            ) {
                this.live.mutation(path, auth.email, upstream.data as Record<string, unknown>, method);
            }
        } catch (error) {
            if (!inferenceOpen()) return;
            console.error(
                '[api-gateway] proxy error:',
                error instanceof Error ? error.message : 'upstream-unavailable',
            );
            res.status(502).json({ error: 'upstream-unavailable' });
        }
    }

    /** Устройство имеет узкий канал; произвольные internal-маршруты не проксируются. */
    private async deviceChannel(req: Request, res: Response): Promise<void> {
        const suffix = req.path.slice('/api/device-channel/'.length);
        const personalKeyTransfer = /^opencode-personal-key\/(?:context|save|receipt)$/.test(suffix);
        if (req.method === 'GET' && /^jobs\/[a-f0-9-]{36}\/runtime\/[a-f0-9]{64}$/.test(suffix)) {
            const identity = await this.authGuard.authenticate({
                headers: { authorization: req.headers.authorization },
            } as Request);
            if (!identity?.deviceId) {
                res.status(401).json({ message: 'MCP не подключён или доступ отозван.' });
                return;
            }
            await forwardRuntimeArtifact(this.http, this.catalogUrl, suffix, req, res);
            return;
        }
        const publicPair = /^pair\/(start|poll)$/.test(suffix);
        if (
            req.method !== 'POST' ||
            (!publicPair &&
                !/^(identity|heartbeat|presence|configuration-authorize|project-configuration\/authorize|opencode-provider\/authorize|opencode-global-providers\/authorize|opencode-personal-key\/(context|save|receipt)|embedding(?:\/context)?|codex-inference\/(context|dispatch)|system-role-mcp\/(claim|authorize|context|next|dispatch|result|complete)|opencode-models\/(context|sync)|agents\/compile|learning-quirks\/import|learning-memory\/context|learning\/(context|record|propose|observe)|worker\/(pause|resume|update-cleanup\/authorize)|jobs\/claim|jobs\/[a-f0-9-]{36}\/(authorize|progress|complete))$/.test(
                    suffix,
                ))
        ) {
            res.status(404).json({ message: 'Маршрут MCP не найден.' });
            return;
        }
        if (
            (suffix === 'opencode-personal-key/save' ||
                (suffix === 'opencode-models/sync' &&
                    req.body?.credentials &&
                    Object.keys(req.body.credentials).length)) &&
            !deviceCredentialTransport(req)
        ) {
            res.status(403).json({
                message:
                    'Перенос ключей OpenCode требует HTTPS. Для TLS-прокси настройте доверенные адреса на API Gateway.',
            });
            return;
        }
        if (publicPair) {
            const isStart = suffix === 'pair/start';
            const address = String(req.socket.remoteAddress);
            // PG-счётчики общие для всех реплик (entry 9, AD-6); 401 за некорректный код —
            // до записи в окно. Устройства за одним прокси не расходуют чужое per-code окно;
            // общий адресный предел сохраняется.
            let windows: Array<[TRateLimitScope, string]>;
            if (isStart) {
                windows = [['pair-start', address]];
            } else {
                const candidate = (req.body as { deviceCode?: unknown } | null)?.deviceCode;
                if (typeof candidate !== 'string' || !/^[a-f0-9]{64}$/.test(candidate)) {
                    res.status(401).json({ message: 'Некорректный код подключения.' });
                    return;
                }
                windows = [
                    ['pair-poll', address],
                    ['pair-poll-code', address + ':' + createHash('sha256').update(candidate).digest('hex')],
                ];
            }
            try {
                for (const [scope, key] of windows) {
                    if (await this.rateLimit.record(scope, key)) {
                        res.status(429).json({ message: 'Слишком много попыток подключения. Повторите через минуту.' });
                        return;
                    }
                }
            } catch {
                // Fail-closed: PG недоступен — pairing не пускаем (AD-19: фикс. сообщение, без passthrough).
                res.status(503).json({ message: 'Не удалось проверить частоты подключений. Повторите позже.' });
                return;
            }
        }
        if (suffix === 'embedding') {
            await this.deviceEmbedding(req, res);
            return;
        }
        // Catalog checks the retained key for queue maintenance, even after normal device access was revoked.
        const maintenance = /^worker\/(pause|resume)$/.test(suffix);
        const auth =
            publicPair || maintenance
                ? null
                : await this.authGuard.authenticate({
                      headers: { authorization: req.headers.authorization },
                  } as Request);
        // Catalog accepts only the already-dispatched call's exact retained token, job and lease.
        const codexReceipt =
            /^jobs\/[a-f0-9-]{36}\/complete$/.test(suffix) &&
            req.body?.result?.protocol === 'device-codex-inference-v1';
        const mcpReceipt = /^system-role-mcp\/(result|complete)$/.test(suffix);
        if (!publicPair && !maintenance && !codexReceipt && !mcpReceipt && !auth?.deviceId) {
            res.status(401).json({ message: 'MCP не подключён или доступ отозван.' });
            return;
        }
        const failure = await featureFlagsFailure(
            this.http,
            this.featureFlagsUrl,
            requiredFeatureFlags(req.method, req.path, req.body),
        );
        if (failure) {
            res.setHeader('Cache-Control', 'no-store');
            res.status(failure.status).json(failure);
            return;
        }
        try {
            const response = await this.http.post(`${this.catalogUrl}/internal/device-channel/${suffix}`, req.body, {
                ...(personalKeyTransfer ? { maxRedirects: 0, proxy: false as const } : {}),
                headers: {
                    'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN || '',
                    ...(!publicPair || suffix === 'pair/start' ? { authorization: req.headers.authorization } : {}),
                },
            });
            if (personalKeyTransfer && (response.status < 200 || response.status >= 300)) {
                res.status(response.status >= 400 && response.status < 600 ? response.status : 502).json({
                    message: 'Перенос ключа не подтверждён. Проверьте сохранённую квитанцию перед повтором.',
                });
                return;
            }
            res.status(response.status).json(response.data === '' ? null : response.data);
            if (response.status >= 200 && response.status < 300 && auth && !suffix.startsWith('embedding')) {
                this.live.bridge(auth.email, auth.deviceId, /^jobs\//.test(suffix) ? suffix.split('/')[1] : undefined);
            }
            if (response.status >= 200 && response.status < 300 && /^learning\/(record|propose|observe)$/.test(suffix))
                this.live.sections(['projects', 'audit']);
            if (
                response.status >= 200 &&
                response.status < 300 &&
                suffix === 'opencode-models/sync' &&
                response.data?.changed
            )
                this.live.sections(['catalog', 'projects', 'audit']);
            if (
                response.status >= 200 &&
                response.status < 300 &&
                /\/(progress|complete)$/.test(suffix) &&
                ['succeeded', 'failed'].includes(String((req.body as { state?: unknown })?.state))
            ) {
                this.live.sections(['knowledge', 'projects', 'operations', 'audit']);
            }
        } catch {
            res.status(502).json({ message: 'Сервис подключений недоступен.' });
        }
    }

    /** Закрытие клиента отменяет только его embedding, включая ожидание проверки Bearer. */
    private async deviceEmbedding(req: Request, res: Response): Promise<void> {
        // AD-6: лестница embedding (base 110s + margin 5s) — из строки /api/device-channel/embedding:
        // client-timer 115s — внешний владелец «истёк», upstream 110s падает первым (race 115==115 закрыт,
        // entry 9); инвентарь completeness-теста держит совпадение со значениями строки.
        const policy = matchPolicy('POST', '/api/device-channel/embedding');
        let timedOut = false;
        const abort = new AbortController(),
            disconnected = () => abort.abort();
        const timer = setTimeout(() => {
            timedOut = true;
            abort.abort();
        }, policy.timeoutMs!);
        const closed = () => {
            if (!res.writableEnded) abort.abort();
        };
        const connected = () => !req.aborted && !res.destroyed && !res.writableEnded;
        const open = () => !abort.signal.aborted && connected();
        const timeoutReply = () => {
            if (timedOut && connected())
                res.status(504).json({
                    code: 'EMBEDDING_TIMEOUT',
                    message: 'Модель не ответила вовремя. Проверьте хостинг и повторите действие.',
                });
        };
        req.on('aborted', disconnected);
        res.on('close', closed);
        try {
            if (req.aborted || res.destroyed) abort.abort();
            if (!open()) return;
            let auth: IAuthPayload | null;
            try {
                auth = await awaitEmbedding(
                    this.authGuard.authenticate({ headers: { authorization: req.headers.authorization } } as Request),
                    abort.signal,
                );
            } catch (error) {
                if (!open()) {
                    timeoutReply();
                    return;
                }
                throw error;
            }
            if (!open()) {
                timeoutReply();
                return;
            }
            if (!auth?.deviceId) {
                res.status(401).json({ message: 'MCP не подключён или доступ отозван.' });
                return;
            }
            let failure: Awaited<ReturnType<typeof featureFlagsFailure>>;
            try {
                failure = await awaitEmbedding(
                    featureFlagsFailure(this.http, this.featureFlagsUrl, ['model_hosting']),
                    abort.signal,
                );
            } catch (error) {
                if (!open()) {
                    timeoutReply();
                    return;
                }
                throw error;
            }
            if (!open()) {
                timeoutReply();
                return;
            }
            if (failure) {
                res.setHeader('Cache-Control', 'no-store');
                res.status(failure.status).json(failure);
                return;
            }
            try {
                const response = await awaitEmbedding(
                    this.http.post(`${this.catalogUrl}/internal/device-channel/embedding`, req.body, {
                        timeout: policy.upstreamTimeoutMs ?? policy.timeoutMs,
                        maxContentLength: policy.maxResponseBytes,
                        signal: abort.signal,
                        headers: {
                            'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN || '',
                            authorization: req.headers.authorization,
                        },
                    }),
                    abort.signal,
                );
                if (open()) res.status(response.status).json(response.data === '' ? null : response.data);
            } catch {
                if (open()) res.status(502).json({ message: 'Сервис подключений недоступен.' });
                else timeoutReply();
            }
        } finally {
            clearTimeout(timer);
            req.removeListener('aborted', disconnected);
            res.removeListener('close', closed);
        }
    }

    private buildHeaders(headers: Record<string, unknown>, auth: IAuthPayload): Record<string, string> {
        const result: Record<string, string> = {};

        for (const [key, value] of Object.entries(headers)) {
            const lowerKey = key.toLowerCase();
            // identity-заголовки отдаём только из валидной сессии (защита от спуфинга клиентом;
            // в т.ч. другие регистры — x-bridge-* вырезаем case-insensitive)
            if (STRIP_HEADERS.has(lowerKey) || lowerKey.startsWith('x-bridge-') || typeof value !== 'string') {
                continue;
            }

            result[lowerKey] = value;
        }

        result['x-bridge-user-id'] = auth.userId;
        result['x-bridge-principal'] = auth.principalName;
        result['x-bridge-roles'] = encodeURIComponent(auth.activeRole);
        result['x-bridge-actor'] = encodeURIComponent(
            JSON.stringify({ email: auth.email, activeRole: auth.activeRole }),
        );
        result['x-neurocenter-internal'] = process.env.NEUROCENTER_INTERNAL_TOKEN || '';
        if (auth.deviceId) result['x-neurocenter-device-id'] = auth.deviceId;
        result['x-bridge-policies'] = encodeURIComponent(JSON.stringify(auth.policies));

        return result;
    }
}
