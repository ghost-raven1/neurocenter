import type { PoolClient } from 'pg';
import {
    ConflictException,
    ForbiddenException,
    HttpException,
    Injectable,
    Logger,
    type OnModuleDestroy,
    type OnModuleInit,
} from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import type { IPackage } from '../catalog/bundle-package';
import { normalizeRuntimeArtifacts } from '../../../shared/runtime-artifacts.cjs';
import { randomUUID } from 'node:crypto';
import type { IAccessActor } from '../access/access.model';
import { projectLevel } from '../access/access.model';
import { DeviceStore, type Device } from '../devices/device-store';
import { DeviceInstallations } from '../devices/device-installations';
import { DeviceJobs } from '../devices/device-jobs';
import { InstallPlans } from '../devices/install-plans';
import { checkedProjectPackage, type IProjectPinRow } from '../catalog/project-asset-pins';
import { managedBinding } from '../devices/device-compatibility';
import { requireFeatureEnabled } from '../features/require-feature-enabled';
import {
    isManagedCodexConnectorPackage,
    CODEX_MANAGED_INSTALL_MESSAGE,
} from '../../../shared/codex-connector-source.cjs';
import { PluginAutoUpdateRepository } from './auto-update.repository';
import { autoUpdateMutation, autoUpdateTarget, pendingAutoUpdate } from './auto-update.validation';
import { autoUpdateView, type AutoUpdateRow, type AutoUpdateStatus, type AutoUpdateTarget } from './auto-update.types';

/** Only archive byte inventory varies on a normal runtime release; launch/settings contracts stay exact. */
function updateSettings(config: IPackage['config']): unknown {
    if (config?.extra?.runtimeArtifacts === undefined) return config ?? null;
    const runtimeArtifacts = normalizeRuntimeArtifacts(config.extra.runtimeArtifacts).map(
        ({ sha256: _sha, compressedBytes: _compressed, unpackedBytes: _unpacked, filesCount: _count, ...settings }) =>
            settings,
    );
    return { ...config, extra: { ...config.extra, runtimeArtifacts } };
}

class UpdateBlocked extends Error {
    constructor(
        readonly status: AutoUpdateStatus,
        message: string,
        readonly delay: number | null,
    ) {
        super(message);
    }
}
/** Opt-in automation chooses only the project's exact approved package; it never moves a project pin. */
@Injectable()
export class PluginAutoUpdateService implements OnModuleInit, OnModuleDestroy {
    readonly repository: PluginAutoUpdateRepository;
    private timer?: ReturnType<typeof setInterval>;
    private active?: Promise<void>;
    private stopped = false;
    private readonly logger = new Logger('PluginAutoUpdates');
    constructor(
        private readonly store: DeviceStore,
        private readonly installations: DeviceInstallations,
        private readonly plans: InstallPlans,
        private readonly jobs: DeviceJobs,
    ) {
        this.repository = new PluginAutoUpdateRepository(store.pool);
    }
    async onModuleInit(): Promise<void> {
        await this.store.ready();
        this.timer = setInterval(() => {
            void this.wake();
        }, 60000);
        this.timer.unref();
        void this.wake();
    }
    async onModuleDestroy(): Promise<void> {
        this.stopped = true;
        if (this.timer) clearInterval(this.timer);
        await this.active;
    }
    async read(actor: IAccessActor, raw: unknown) {
        const input = autoUpdateTarget(raw);
        await this.permission(actor, input, 1);
        const row = await this.repository.read(actor, input);
        return { policy: row ? autoUpdateView(row) : null };
    }
    async save(actor: IAccessActor, raw: unknown) {
        const input = autoUpdateMutation(raw);
        const authorize = async (db: PoolClient, previous: AutoUpdateRow | undefined) => {
            if (input.enabled) {
                const device = await this.permission(actor, input, 2, db);
                await requireFeatureEnabled('plugin_auto_updates');
                await this.installed(actor, input, device, db);
            } else {
                // Stopping one's own policy remains possible after project demotion or feature OFF.
                const claims = await this.store.access.claims(actor.email);
                if (!claims.userRoles.includes(actor.activeRole))
                    throw new ForbiddenException('Активная роль отозвана.');
                if (!previous) {
                    await this.permission(actor, input, 1, db);
                }
            }
        };
        const row = await this.repository.save(actor, input, authorize);
        void this.wake();
        return { policy: autoUpdateView(row) };
    }
    private async permission(
        actor: IAccessActor,
        target: AutoUpdateTarget,
        level: number,
        db?: PoolClient,
    ): Promise<Device> {
        const claims = await this.store.access.claims(actor.email),
            device = await this.store.owned(actor, target.deviceId, level === 1, db);
        if (
            projectLevel(claims, actor.activeRole, target.projectId) < level ||
            (level >= 2 && projectLevel(claims, device.role, target.projectId) < level)
        )
            throw new ForbiddenException('Недостаточно прав для автообновления плагина в выбранном проекте.');
        return device;
    }
    private async installed(actor: IAccessActor, target: AutoUpdateTarget, device: Device, db?: PoolClient) {
        if (managedBinding(device.report, target.projectId) !== target.bindingId)
            throw new ConflictException('Привязка папки изменилась. Выберите текущую установку.');
        const packages = await this.installations.workspacePackages(
            actor.email,
            target.deviceId,
            target.projectId,
            target.bindingId,
            db,
        );
        const pkg = packages.find((item) => item.plugin.kind === 'plugin' && item.plugin.id === target.assetId);
        if (!pkg) throw new ConflictException('Плагин больше не установлен в выбранной папке.');
        if (isManagedCodexConnectorPackage(pkg)) throw new ConflictException(CODEX_MANAGED_INSTALL_MESSAGE);
        return pkg;
    }
    /** One local worker plus database leases prevent repeated timers/restarts from making another request key. */
    wake(): Promise<void> {
        if (this.stopped) return Promise.resolve();
        if (!this.active)
            this.active = this.tick()
                .catch(() => {
                    this.logger.warn(
                        'Проверка автообновлений прервана; сохранённые ключи запросов остаются для сверки.',
                    );
                })
                .finally(() => {
                    this.active = undefined;
                });
        return this.active;
    }
    async tick(): Promise<void> {
        for (const row of await this.repository.claim()) {
            if (this.stopped) break;
            await this.process(row);
        }
    }
    async process(row: AutoUpdateRow): Promise<void> {
        const actor = { email: row.owner_email, activeRole: row.actor_role },
            target = {
                deviceId: row.device_id,
                projectId: row.project_id,
                bindingId: row.binding_id,
                assetId: row.asset_id,
            };
        try {
            let input = row.pending_input ? pendingAutoUpdate(row) : undefined;
            if (input) {
                const receipt = await this.repository.receipt(row, input);
                if (receipt) {
                    if (['queued', 'running', 'reconciling'].includes(receipt.state)) {
                        await this.repository.finish(
                            row,
                            'queued',
                            'Обновление передано мосту. Ход и отмена доступны в операциях.',
                            30,
                            receipt.id,
                        );
                        return;
                    }
                    if (receipt.state === 'succeeded') {
                        await this.repository.finish(
                            row,
                            'succeeded',
                            'Одобренная версия установлена. Следующая проверка — через час.',
                            3600,
                            receipt.id,
                            true,
                        );
                        return;
                    }
                    await this.repository.finish(
                        row,
                        'attention',
                        'Обновление не завершено. Прежнюю установку не заменяем повторно автоматически. Проверьте операцию и нажмите «Проверить сейчас».',
                        null,
                        receipt.id,
                    );
                    return;
                }
            }
            await requireFeatureEnabled('plugin_auto_updates');
            const device = await this.permission(actor, target, 2),
                installed = await this.installed(actor, target, device);
            if (input && row.pending_role !== row.actor_role)
                throw new UpdateBlocked(
                    'attention',
                    'Роль политики изменилась до подтверждения запроса. Нажмите «Проверить сейчас» для актуальной проверки.',
                    null,
                );
            if (!device.last_seen || Date.now() - Date.parse(device.last_seen) > 40000)
                throw new UpdateBlocked(
                    'waiting',
                    'Компьютер не в сети. Обновление продолжится после подключения.',
                    300,
                );
            const selected = (
                await this.store.pool.query<IProjectPinRow>(
                    "SELECT * FROM project_assets WHERE project_id=$1 AND asset_id=$2 AND asset_kind='plugin'",
                    [target.projectId, target.assetId],
                )
            ).rows[0];
            if (!selected)
                throw new UpdateBlocked(
                    'attention',
                    'Плагин убран из проекта. Автообновление не устанавливает его заново.',
                    null,
                );
            const pkg = checkedProjectPackage(selected);
            if (isManagedCodexConnectorPackage(pkg))
                throw new UpdateBlocked('attention', CODEX_MANAGED_INSTALL_MESSAGE, null);
            if (pkg.plugin.version <= installed.plugin.version) {
                const head = (
                    await this.store.pool.query<{ version: number }>(
                        "SELECT version FROM ai_plugins WHERE id=$1 AND kind='plugin' AND archived_at IS NULL",
                        [target.assetId],
                    )
                ).rows[0];
                if (head && Number(head.version) > installed.plugin.version)
                    throw new UpdateBlocked(
                        'waiting',
                        'В каталоге есть новая версия. Админ проекта должен выбрать её и одобрить план установки.',
                        3600,
                    );
                if (pkg.plugin.version < installed.plugin.version || pkg.manifest.sha256 !== installed.manifest.sha256)
                    throw new UpdateBlocked(
                        'attention',
                        'Закрепление проекта отличается от установленной версии. Автоматический откат не выполняется.',
                        null,
                    );
                await this.repository.finish(
                    row,
                    'up-to-date',
                    'Установлена актуальная одобренная версия проекта. Проверяем новые назначения каждый час.',
                    3600,
                    undefined,
                    true,
                );
                return;
            }
            if (!isDeepStrictEqual(updateSettings(pkg.config), updateSettings(installed.config)))
                throw new UpdateBlocked(
                    'attention',
                    'Новая версия меняет настройки или зависимости. Обновите её вручную через план установки; прежняя версия сохранена.',
                    null,
                );
            let approved: Awaited<ReturnType<InstallPlans['approvedInstalled']>>;
            try {
                approved = await this.plans.approvedInstalled(target.projectId, pkg);
            } catch (error) {
                if (error instanceof ConflictException)
                    throw new UpdateBlocked(
                        'waiting',
                        'Новая версия закреплена, но план ещё не одобрен. Откройте план установки в каталоге проекта.',
                        3600,
                    );
                throw error;
            }
            const candidate = {
                deviceId: target.deviceId,
                projectId: target.projectId,
                kind: 'install',
                requestKey: input?.requestKey ?? randomUUID(),
                assetId: target.assetId,
                assetKind: 'plugin',
                version: pkg.plugin.version,
                expectedBindingId: target.bindingId,
                expectedManifest: approved.installSet?.manifest ?? pkg.manifest.sha256,
                planId: approved.planId,
                planRevision: approved.planRevision,
            };
            if (input && !isDeepStrictEqual(input, candidate))
                throw new UpdateBlocked(
                    'attention',
                    'План или закреплённая версия изменились до подтверждения запроса. Нажмите «Проверить сейчас» для актуальной проверки.',
                    null,
                );
            if (!input) {
                const prepared = await this.repository.prepare(row, candidate);
                if (!prepared) return;
                row = prepared;
                input = pendingAutoUpdate(row);
            }
            const job = await this.jobs.create(actor, input, async (db) => {
                await requireFeatureEnabled('plugin_auto_updates');
                await this.repository.admit(db, row, input!);
            });
            await this.repository.finish(
                row,
                'queued',
                'Обновление передано мосту. Ход и отмена доступны в операциях.',
                30,
                String(job.id),
            );
        } catch (error) {
            if (error instanceof UpdateBlocked) {
                await this.repository.finish(row, error.status, error.message, error.delay);
                return;
            }
            const status = error instanceof HttpException ? error.getStatus() : 0;
            if (status === 403) {
                await this.repository.finish(
                    row,
                    'waiting',
                    'Автообновление приостановлено: доступ к проекту, компьютеру или функции изменился.',
                    300,
                );
                return;
            }
            if (status === 400 || status === 409) {
                await this.repository.finish(
                    row,
                    'attention',
                    (error as HttpException).message.slice(0, 1000) +
                        ' Перечитайте состояние и запустите проверку заново.',
                    null,
                );
                return;
            }
            await this.repository.finish(
                row,
                'waiting',
                row.pending_input
                    ? 'Подтверждение установки пока недоступно. Сверим сохранённый ключ; новое задание не создаём.'
                    : 'Не удалось проверить состояние. Повторим проверку после восстановления связи.',
                30,
            );
        }
    }
}
