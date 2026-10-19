import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IAccessActor } from '../access/access.model';
import { projectLevel } from '../access/access.model';
import { securityEvent } from '../access/security-events';
import type { IPackage } from '../catalog/bundle-package';
import { DeviceArtifacts } from './device-artifacts';
import { DeviceStore } from './device-store';
import { assertDeviceCatalogAsset } from './device-catalog-access';
import { installPlanView, type InstallPlanInput, type InstallPlanRow } from './install-plan.model';
import { assertInstallablePackage, packageDependencies, resolveInstallationSet, verifyInstallationSet } from './installation-set';

/** Неизменяемый пакет и отдельное одобрение его хэша внутри проекта. */
@Injectable()
export class InstallPlans {
    constructor(private readonly store: DeviceStore, private readonly artifacts: DeviceArtifacts) {}

    private async permission(actor: IAccessActor, projectId: string, level: number) {
        const claims = await this.store.access.claims(actor.email);
        if (projectLevel(claims, actor.activeRole, projectId) < level) {
            throw new ForbiddenException(level === 3 ? 'Одобрять версии может админ этого проекта.' : 'Недостаточно прав в выбранном проекте.');
        }
        if (!(await this.store.pool.query('SELECT 1 FROM projects WHERE id=$1', [projectId])).rowCount) {
            throw new NotFoundException('Проект удалён.');
        }
    }

    async prepare(actor: IAccessActor, input: InstallPlanInput) {
        if (!input || typeof input.projectId !== 'string' || !input.projectId || input.projectId.length > 240) {
            throw new BadRequestException('Выберите серверный проект.');
        }
        await this.permission(actor, input.projectId, 2);
        await assertDeviceCatalogAsset(this.store.pool, input.projectId, input.assetKind, input.assetId);
        const pkg = await this.artifacts.build(input.assetKind, input.assetId, input.version);
        const set = await resolveInstallationSet(this.store.pool,input.projectId,pkg,(kind,id,version) => this.artifacts.build(kind,id,version));
        const { rows } = await this.store.pool.query<InstallPlanRow>(`INSERT INTO device_install_plans
            (id,project_id,asset_kind,asset_id,version,manifest,package,created_by,installation_set) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
            ON CONFLICT(project_id,asset_kind,asset_id,version,manifest) DO UPDATE SET manifest=EXCLUDED.manifest RETURNING *`,
        [randomUUID(), input.projectId, input.assetKind, input.assetId, input.version, set?.manifest ?? pkg.manifest.sha256, pkg, actor.email, set ?? null]);
        this.assertRow(rows[0]);
        return installPlanView(rows[0]);
    }

    async view(actor: IAccessActor, id: string) {
        const row = await this.read(id);
        await this.permission(actor, row.project_id, 1);
        this.assertRow(row);
        return installPlanView(row);
    }

    async decide(actor: IAccessActor, id: string, input: { expectedManifest: string; expectedRevision: number }, status: 'approved' | 'revoked') {
        this.validId(id);
        if (!input || typeof input.expectedManifest !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedManifest) || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
            throw new BadRequestException('Нужны хэш и ревизия просмотренного плана.');
        }
        const initial = await this.read(id);
        await this.permission(actor, initial.project_id, 3);
        this.assertRow(initial);
        if (status === 'approved') { await this.catalog(initial); }
        const client = await this.store.pool.connect();
        try {
            await client.query('BEGIN');
            const { rows } = await client.query<InstallPlanRow>('SELECT * FROM device_install_plans WHERE id=$1 FOR UPDATE', [id]);
            const row = rows[0];
            if (!row) { throw new NotFoundException('План установки удалён.'); }
            this.assertRow(row);
            if (row.manifest !== input.expectedManifest || row.revision !== input.expectedRevision) {
                throw new ConflictException('Решение по версии уже изменилось. Откройте план заново.');
            }
            if (row.status === status) { await client.query('COMMIT'); return installPlanView(row); }
            const saved = await client.query<InstallPlanRow>(`UPDATE device_install_plans SET status=$2,revision=revision+1,
                approved_by=CASE WHEN $2='approved' THEN $3 ELSE approved_by END,
                approved_at=CASE WHEN $2='approved' THEN now() ELSE approved_at END,
                revoked_by=CASE WHEN $2='revoked' THEN $3 ELSE NULL END,
                revoked_at=CASE WHEN $2='revoked' THEN now() ELSE NULL END,updated_at=now() WHERE id=$1 RETURNING *`, [id, status, actor.email]);
            const summary = (value: InstallPlanRow) => ({ projectId: value.project_id, assetKind: value.asset_kind, assetId: value.asset_id,
                version: value.version, manifest: value.manifest, status: value.status, revision: value.revision });
            await securityEvent(client, { actor: actor.email, action: 'installation.' + status, resourceId: id, before: summary(row), after: summary(saved.rows[0]) });
            await client.query('COMMIT');
            return installPlanView(saved.rows[0]);
        } catch (error) { await client.query('ROLLBACK').catch(() => undefined); throw error; }
        finally { client.release(); }
    }

    /** Выдаёт только сохранённый пакет; head каталога не участвует в повторе установки. */
    async package(id: unknown, projectId: string, kind: unknown, assetId: unknown, version: unknown, expectedRevision: unknown, expectedManifest?: unknown): Promise<IPackage> {
        return (await this.delivery(id,projectId,kind,assetId,version,expectedRevision,expectedManifest)).package;
    }
    async delivery(id: unknown, projectId: string, kind: unknown, assetId: unknown, version: unknown, expectedRevision: unknown, expectedManifest?: unknown) {
        if (typeof id !== 'string' || !id) { throw new ConflictException('Сначала подготовьте план и получите одобрение версии у админа проекта.'); }
        const row = await this.read(id);
        this.assertRow(row);
        if (row.project_id !== projectId || row.asset_kind !== kind || row.asset_id !== assetId || row.version !== version || row.revision !== expectedRevision ||
            expectedManifest !== undefined && row.manifest !== expectedManifest) {
            throw new ConflictException('План не соответствует инструменту, версии или проекту.');
        }
        if (row.status !== 'approved') { throw new ConflictException('Эта версия ещё не одобрена или её одобрение отозвано админом проекта.'); }
        await this.catalog(row);
        return {package: row.package, ...(row.installation_set ? { installSet: row.installation_set } : {})};
    }

    /** Повторная проверка и восстановление используют действующее одобрение именно установленного SHA. */
    async approvedInstalled(projectId: string, pkg: IPackage) {
        const { rows } = await this.store.pool.query<InstallPlanRow>(`SELECT * FROM device_install_plans
            WHERE project_id=$1 AND asset_kind=$2 AND asset_id=$3 AND version=$4 AND package->'manifest'->>'sha256'=$5
                AND status='approved' ORDER BY updated_at DESC,id LIMIT 1`,
        [projectId,pkg.plugin.kind,pkg.plugin.id,pkg.plugin.version,pkg.manifest.sha256]);
        const row = rows[0];
        if (!row) { throw new ConflictException('Для этой установленной версии нужно действующее одобрение админа проекта. Откройте план установки и одобрите точный SHA.'); }
        this.assertRow(row);
        await this.catalog(row);
        return { planId:row.id,planRevision:row.revision,package:row.package,
            ...(row.installation_set ? {installSet:row.installation_set} : {}) };
    }

    /** Настройка зависимости сохраняет одобрение исходного графа, не создавая отдельного разрешения для leaf. */
    async approvedConfiguration(projectId:string,pkg:IPackage) {
        const {rows}=await this.store.pool.query<InstallPlanRow>(`SELECT * FROM device_install_plans p WHERE project_id=$1 AND status='approved'
            AND ((asset_kind=$2 AND asset_id=$3 AND version=$4 AND package->'manifest'->>'sha256'=$5)
                OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(p.installation_set->'packages','[]'::jsonb)) member
                    WHERE member->'plugin'->>'kind'=$2 AND member->'plugin'->>'id'=$3 AND member->'plugin'->>'version'=$4::text
                        AND member->'manifest'->>'sha256'=$5)) ORDER BY updated_at DESC,id DESC LIMIT 1`,
        [projectId,pkg.plugin.kind,pkg.plugin.id,pkg.plugin.version,pkg.manifest.sha256]);
        const row=rows[0];if(!row)throw new ConflictException('Получите действующее одобрение комплекта с установленной версией MCP.');
        this.assertRow(row);await this.catalog(row);
        return {planId:row.id,planRevision:row.revision,package:pkg,approvalManifest:row.manifest,
            approvalRoot:{kind:row.asset_kind,id:row.asset_id,version:row.version},...(row.installation_set?{installSet:row.installation_set}:{})};
    }

    private async read(id: string) {
        this.validId(id);
        const { rows } = await this.store.pool.query<InstallPlanRow>('SELECT * FROM device_install_plans WHERE id=$1', [id]);
        if (!rows[0]) { throw new NotFoundException('План установки не найден.'); }
        return rows[0];
    }
    private validId(id: string) { if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) { throw new BadRequestException('Некорректный идентификатор плана.'); } }
    private assertRow(row: InstallPlanRow) {
        assertInstallablePackage(row.package);
        if (row.installation_set ? !verifyInstallationSet(row.installation_set) || row.installation_set.manifest !== row.manifest
                || row.installation_set.root.manifest !== row.package.manifest.sha256 || row.installation_set.root.id !== row.asset_id
                || row.installation_set.root.kind !== row.asset_kind || row.installation_set.root.version !== row.version
            : row.package.manifest.sha256 !== row.manifest || packageDependencies(row.package).length > 0) {
            throw new ConflictException('Состав зависимостей не соответствует одобренному плану. Установка остановлена.');
        }
        if (row.package.plugin.id !== row.asset_id || row.package.plugin.kind !== row.asset_kind || row.package.plugin.version !== row.version) {
            throw new ConflictException('Сохранённый пакет не соответствует плану. Установка остановлена.');
        }
    }
    private async catalog(row: InstallPlanRow) {
        for (const pkg of row.installation_set?.packages ?? [row.package]) {
            await assertDeviceCatalogAsset(this.store.pool,row.project_id,pkg.plugin.kind,pkg.plugin.id);
        }
    }
}
