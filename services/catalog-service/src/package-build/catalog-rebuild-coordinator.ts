import { catalogRebuildRequestKey, type CatalogRebuildRequest } from '../../../shared/catalog-rebuild-request.cjs';
import {
    readCatalogRebuildRequest,
    sameCatalogRebuildRequest,
    writeCatalogRebuildState,
    type CatalogRebuildItem,
    type CatalogRebuildState,
} from './catalog-rebuild-state';
import type { BuildPublicationTarget } from './publication-target';

export interface RebuildPlan {
    id: string;
    kind: string;
    name: string;
    description: string;
    revision: string;
    delivery: string;
    catalogReady?: boolean;
    imported?: { id: string; name?: string; version: number; archived?: boolean; unavailable?: boolean };
}
interface Job {
    id: string;
    state: string;
    items?: Array<{ state: string; action: string }>;
}
interface Actor {
    email: string;
    activeRole: 'Главный админ';
}
export interface CatalogRebuildDependencies {
    file: string;
    actor: () => Actor;
    authorize: (actor: Actor) => Promise<void>;
    bundle: () => Promise<{ revision: string; commit: string; inlineIds: string[] }>;
    plans: () => Promise<RebuildPlan[]>;
    refresh: () => Promise<void>;
    target: (plan: RebuildPlan) => Promise<{ name: string; publication?: BuildPublicationTarget }>;
    build: {
        request: (actor: Actor, key: string) => Promise<Job>;
        create: (actor: Actor, input: unknown) => Promise<Job>;
    };
    inline: {
        request: (actor: Actor, key: string) => Promise<Job>;
        create: (actor: Actor, input: { requestKey: string; commit: string; ids: string[] }) => Promise<Job>;
    };
}
const missing = (error: unknown) => (error as { getStatus?: () => number })?.getStatus?.() === 404;
const ready = (job: Job) =>
    job.state === 'SUCCEEDED' && !job.items?.some((item) => item.action === 'conflict' || item.state === 'FAILED');
const pending = (job: Job) => ['QUEUED', 'RUNNING', 'CANCELLING'].includes(job.state);

/** Reuses accepted build/import requests; this coordinator never runs a producer or publishes a card itself. */
export class CatalogRebuildCoordinator {
    private running?: Promise<void>;
    private stopped = false;
    private settled?: CatalogRebuildRequest;
    constructor(private readonly dependencies: CatalogRebuildDependencies) {}
    tick(): Promise<void> {
        if (this.stopped) return Promise.resolve();
        return (this.running ??= this.run()
            .catch(() => undefined)
            .finally(() => {
                this.running = undefined;
            }));
    }
    async stop(): Promise<void> {
        this.stopped = true;
        await this.running;
    }
    private async current(request: CatalogRebuildRequest): Promise<boolean> {
        return (
            !this.stopped && sameCatalogRebuildRequest(await readCatalogRebuildRequest(this.dependencies.file), request)
        );
    }
    private async existingOrCreate(
        request: CatalogRebuildRequest,
        lookup: () => Promise<Job>,
        create: () => Promise<Job>,
    ): Promise<Job> {
        try {
            return await lookup();
        } catch (error) {
            if (!missing(error)) throw error;
        }
        if (!(await this.current(request))) throw Error('REBUILD_REQUEST_CHANGED');
        return create();
    }
    private item(id: string, name: string, job: Job, catalogId?: string): CatalogRebuildItem {
        return {
            id,
            name,
            state: ready(job) ? 'ready' : pending(job) ? 'pending' : 'attention',
            message: ready(job)
                ? 'Пакет опубликован и проверен.'
                : pending(job)
                  ? 'Подготовка в очереди операций.'
                  : 'Подготовка не завершена. Прежняя версия сохранена; откройте операцию.',
            operationId: job.id,
            ...(catalogId ? { catalogId } : {}),
        };
    }
    private async run(): Promise<void> {
        const d = this.dependencies,
            request = await readCatalogRebuildRequest(d.file);
        if (!request || sameCatalogRebuildRequest(this.settled, request)) return;
        const items: CatalogRebuildItem[] = [];
        let message: string | undefined,
            retry = false,
            settle = false;
        try {
            const bundle = await d.bundle();
            if (bundle.revision !== request.sourceRevision) throw Error('REBUILD_SOURCE_CHANGED');
            const actor = d.actor();
            await d.authorize(actor);
            // Inline metadata imports are separate from executable builds; no model or archive-only item is selected.
            for (let index = 0; index < bundle.inlineIds.length; index += 50) {
                if (!(await this.current(request))) return;
                const ids = bundle.inlineIds.slice(index, index + 50),
                    key = catalogRebuildRequestKey(request.requestId, 'inline:' + index);
                try {
                    const job = await this.existingOrCreate(
                        request,
                        () => d.inline.request(actor, key),
                        async () => {
                            await d.refresh();
                            if (!(await this.current(request))) throw Error('REBUILD_REQUEST_CHANGED');
                            return d.inline.create(actor, { requestKey: key, commit: bundle.commit, ids });
                        },
                    );
                    items.push(this.item('inline:' + index, 'Встроенные агенты и скиллы', job));
                } catch {
                    retry = true;
                    items.push({
                        id: 'inline:' + index,
                        name: 'Встроенные агенты и скиллы',
                        state: 'attention',
                        message: 'Подготовка не подтверждена. Проверьте права, флаги и сохранённый запрос.',
                    });
                }
            }
            const plans = await d.plans();
            for (const plan of plans) {
                if (!['mcp', 'plugin'].includes(plan.kind)) continue;
                if (!(await this.current(request))) return;
                if (!['prepared', 'local-project'].includes(plan.delivery)) {
                    items.push({
                        id: plan.id,
                        name: plan.name,
                        state: 'archive-required',
                        message: 'Для этого компонента нужен выбранный локальный архив.',
                    });
                    continue;
                }
                if (plan.revision !== request.sourceRevision) {
                    items.push({
                        id: plan.id,
                        name: plan.name,
                        state: 'attention',
                        message: 'Исходники изменились. Повторите пересборку.',
                    });
                    continue;
                }
                if (plan.catalogReady) {
                    items.push({
                        id: plan.id,
                        name: plan.name,
                        state: 'ready',
                        message: 'Пакет текущих исходников уже опубликован.',
                        catalogId: plan.imported?.id,
                    });
                    continue;
                }
                const key = catalogRebuildRequestKey(request.requestId, plan.id);
                try {
                    const job = await this.existingOrCreate(
                        request,
                        () => d.build.request(actor, key),
                        async () => {
                            const target = await d.target(plan);
                            if (!(await this.current(request))) throw Error('REBUILD_REQUEST_CHANGED');
                            return d.build.create(actor, {
                                requestKey: key,
                                kind: plan.kind,
                                name: target.name,
                                description: plan.description || plan.name,
                                source: { type: 'bundled', id: plan.id, revision: request.sourceRevision },
                                ...(target.publication ? { publication: target.publication } : {}),
                            });
                        },
                    );
                    const item = this.item(plan.id, plan.name, job, plan.imported?.id);
                    if (ready(job)) {
                        const current = (await d.plans()).find((value) => value.id === plan.id);
                        if (!current?.catalogReady) {
                            if (current) await d.target(current);
                            item.state = 'pending';
                            item.message = 'Публикация подтверждена. Перечитываем текущую версию каталога.';
                        }
                    }
                    items.push(item);
                } catch {
                    retry = true;
                    items.push({
                        id: plan.id,
                        name: plan.name,
                        state: 'attention',
                        catalogId: plan.imported?.id,
                        message: 'Пакет не обновлён. Проверьте права, флаги, конфликт карточки или сохранённый запрос.',
                    });
                }
            }
            settle = !retry && items.every((item) => item.state !== 'pending');
        } catch {
            message =
                'Актуализация не подтверждена. Проверьте текущие исходники и права настроенного администратора установки.';
        }
        const state: CatalogRebuildState = {
            requestId: request.requestId,
            sourceRevision: request.sourceRevision,
            requestedAt: request.requestedAt,
            updatedAt: new Date().toISOString(),
            state:
                message || items.some((item) => item.state === 'attention' || item.state === 'archive-required')
                    ? 'attention'
                    : items.some((item) => item.state === 'pending')
                      ? 'preparing'
                      : 'ready',
            items,
            ...(message ? { message } : {}),
        };
        await writeCatalogRebuildState(d.file, request, state);
        if (settle) this.settled = request;
    }
}
