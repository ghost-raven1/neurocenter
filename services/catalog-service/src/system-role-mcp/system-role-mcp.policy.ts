import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { SYSTEM_ROLE_MCP_CAPABILITY, roleMcpProducer, type RoleMcpTarget } from '../../../shared/system-role-mcp.cjs';
import { normalizeRuntimeArtifacts } from '../../../shared/runtime-artifacts.cjs';
import { projectAssetColumns, checkedProjectPackage, type IProjectPinRow } from '../catalog/project-asset-pins';
import type { IPackage } from '../catalog/bundle-package';
import { DeviceStore, type Device } from '../devices/device-store';
import { DeviceInstallations } from '../devices/device-installations';
import { InstallPlans } from '../devices/install-plans';
import { assertManagedBridge, managedBinding } from '../devices/device-compatibility';
import { hasDeviceJobPermission } from '../devices/device-job-access';
import { assertLocalFeature } from '../devices/local-change-jobs';
import { configurationRevisionsForProbe } from '../devices/mcp-config-status';
import { runtimeArtifactTarget } from '../devices/runtime-host-target';
import { ModelsService } from '../models/models.service';
import type { IModelActor } from '../models/model-access';
import { SystemRolePolicy } from '../system-roles/system-role.policy';
import type { IInstallationSet } from '../devices/installation-set';

/** Runtime authority resolves only immutable assigned packages and the current owner's exact local binding. */
export class SystemRoleMcpPolicy {
    readonly roles: SystemRolePolicy;
    constructor(
        readonly models: ModelsService,
        readonly devices: DeviceStore,
        readonly installations: DeviceInstallations,
        readonly plans: InstallPlans,
    ) {
        this.roles = new SystemRolePolicy(models);
    }
    project(value: unknown): string {
        if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value))
            throw new BadRequestException('Выберите проект для доступа к его инструментам.');
        return value;
    }
    async package(
        project: string,
        target: Pick<RoleMcpTarget, 'assetId' | 'assetKind' | 'version' | 'manifest'>,
        db: Pick<PoolClient, 'query'> = this.models.pool,
    ): Promise<IPackage> {
        const row = (
            await db.query<IProjectPinRow>(
                `SELECT ${projectAssetColumns} FROM project_assets WHERE project_id=$1 AND asset_kind=$3 AND asset_id=$2 FOR SHARE`,
                [project, target.assetId, target.assetKind ?? 'mcp'],
            )
        ).rows[0];
        if (!row) throw new ForbiddenException('MCP больше не назначен проекту.');
        const pkg = checkedProjectPackage(row);
        if (pkg.plugin.version !== target.version || pkg.manifest.sha256 !== target.manifest || !roleMcpProducer(pkg))
            throw new ConflictException(
                'Версия или MCP-возможности назначения изменились. Выберите актуальное назначение.',
            );
        return pkg;
    }
    async server(pkg: IPackage, db: Pick<PoolClient, 'query'> = this.models.pool): Promise<void> {
        const config = pkg.config;
        if (!config || config.extra?.localConfiguration)
            throw new ConflictException(
                'Настройте этот MCP на компьютере: серверные локальные параметры ещё не заданы.',
            );
        if (config.transport === 'remote') {
            let url: URL;
            try {
                url = new URL(config.url!);
            } catch {
                throw new ConflictException('Задайте адрес удалённого MCP в закреплённом пакете.');
            }
            if (
                !['https:', 'http:'].includes(url.protocol) ||
                url.username ||
                url.password ||
                url.hash ||
                Object.entries(config.headers ?? {}).some(
                    ([key, value]) =>
                        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) ||
                        /authorization|cookie|api.?key|token|secret|credential/i.test(key) ||
                        typeof value !== 'string' ||
                        Buffer.byteLength(value) > 8192 ||
                        /[\r\n]|\$\{|\{env:/.test(value),
                )
            )
                throw new ConflictException(
                    'Проверьте адрес и публичные заголовки MCP. Секреты требуют отдельной серверной настройки.',
                );
            return;
        }
        const producer = roleMcpProducer(pkg),
            args = producer?.args ?? [];
        if (
            (config.extra?.hostedMcp !== true && producer?.assetKind !== 'plugin') ||
            Object.keys(config.env ?? {}).length ||
            args.length > 64 ||
            args.some((value) => typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > 8192)
        )
            throw new ConflictException(
                'Для сервера нужен проверенный runtime и ограниченные параметры; секреты задаются отдельно.',
            );
        const artifact = normalizeRuntimeArtifacts(config.extra?.runtimeArtifacts).find(
            (value) => value.target === runtimeArtifactTarget(),
        );
        if (
            !artifact ||
            !(
                await db.query(
                    'SELECT sha256 FROM bridge_runtime_artifacts WHERE sha256=$1 AND compressed_bytes=$2 AND unpacked_bytes=$3 AND files_count=$4 FOR SHARE',
                    [artifact.sha256, artifact.compressedBytes, artifact.unpackedBytes, artifact.filesCount],
                )
            ).rowCount
        )
            throw new ConflictException(
                'Нет готового runtime MCP для платформы сервера. Добавьте проверенную поставку.',
            );
    }
    async target(
        req: Request,
        project: string,
        target: RoleMcpTarget,
        db: Pick<PoolClient, 'query'> = this.models.pool,
    ): Promise<{ package: IPackage; installSet?: IInstallationSet }> {
        return this.targetForActor(await this.roles.actor(req, project), project, target, db);
    }
    /** Internal callers separate core role authority from optional tool availability failures. */
    async targetForActor(
        actor: IModelActor,
        project: string,
        target: RoleMcpTarget,
        db: Pick<PoolClient, 'query'> = this.models.pool,
    ): Promise<{ package: IPackage; installSet?: IInstallationSet }> {
        const pkg = await this.package(project, target, db);
        if (target.runtime === 'server') {
            await this.server(pkg, db);
            return { package: pkg };
        }
        const device = (
            await db.query<Device>(
                `SELECT id,email,role,name,fingerprint,last_seen,report,revoked FROM bridge_devices
            WHERE id=$1 AND email=$2 AND NOT revoked AND expires_at>clock_timestamp() FOR SHARE`,
                [target.deviceId, actor.email],
            )
        ).rows[0];
        if (!device) throw new ForbiddenException('Компьютер больше не подключён к вашему профилю.');
        const account = (
            await db.query<{ enabled: boolean; is_main_admin: boolean }>(
                'SELECT enabled,is_main_admin FROM platform_users WHERE email=$1 FOR SHARE',
                [actor.email],
            )
        ).rows[0];
        const projects = (
            await db.query<{ projectId: string; projectName: string; role: string }>(
                `SELECT pm.project_id AS "projectId",p.name AS "projectName",pm.role
            FROM project_members pm JOIN projects p ON p.id=pm.project_id WHERE lower(pm.principal_name)=$1 FOR SHARE OF pm`,
                [actor.email],
            )
        ).rows;
        const claims = {
            ...actor.claims,
            projects,
            userRoles: [
                ...new Set([
                    ...(account?.is_main_admin ? ['Главный админ'] : []),
                    ...projects.map((value) => value.role),
                ]),
            ],
        };
        if (!account?.enabled || !hasDeviceJobPermission(claims, actor.activeRole, device.role, project, 2))
            throw new ForbiddenException('Подключение компьютера больше не имеет доступа к проекту.');
        assertManagedBridge(device.report);
        assertLocalFeature(device.report, SYSTEM_ROLE_MCP_CAPABILITY);
        const binding = (device.report.bindings as Array<{ projectId: string; instanceId: string }> | undefined)?.find(
            (value) => value.projectId === project,
        );
        if (managedBinding(device.report, project) !== target.bindingId || binding?.instanceId !== target.instanceId)
            throw new ConflictException('Папка проекта или её экземпляр изменились. Выберите компьютер заново.');
        // Existing configuration forms must finish their permit update before a new immutable dispatch is admitted.
        await db.query(
            `SELECT id FROM bridge_jobs WHERE email=$1 AND device_id=$2 AND project_id=$3
            AND kind='open-mcp-configuration' AND payload->>'bindingId'=$4 AND payload->>'instanceId'=$5 FOR SHARE`,
            [actor.email, target.deviceId, project, target.bindingId, target.instanceId],
        );
        const installed = await this.installations.inspectionDelivery(
            actor,
            {
                deviceId: target.deviceId,
                projectId: project,
                assetId: target.assetId,
                assetKind: target.assetKind ?? 'mcp',
                expectedManifest: target.manifest,
                bindingId: target.bindingId,
            },
            db,
        );
        if (installed.package.plugin.version !== target.version)
            throw new ConflictException('Установленная версия MCP изменилась.');
        const approved = await this.plans.approvedInstalled(project, installed.package, db);
        const revisions = await configurationRevisionsForProbe(db, actor.email, {
            deviceId: target.deviceId,
            projectId: project,
            bindingId: target.bindingId,
            instanceId: target.instanceId,
            packages: (installed.installSet ?? approved.installSet)?.packages ?? [installed.package],
        });
        const order = <T extends { assetId: string }>(values: T[]): T[] =>
            [...values].sort((a, b) => (a.assetId < b.assetId ? -1 : a.assetId > b.assetId ? 1 : 0));
        if (!isDeepStrictEqual(order(revisions), order(target.configurationRevisions)))
            throw new ConflictException(
                'Локальная настройка MCP изменилась. Обновите её состояние и выберите инструменты заново.',
            );
        return {
            package: installed.package,
            ...(installed.installSet
                ? { installSet: installed.installSet }
                : approved.installSet
                  ? { installSet: approved.installSet }
                  : {}),
        };
    }
}
