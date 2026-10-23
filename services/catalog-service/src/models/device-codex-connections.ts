import {deviceCodexIdentityDigest,deviceCodexConflict} from './device-codex-identity';
import { BadRequestException, ConflictException, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { DEVICE_CODEX_CAPABILITY, type DeviceCodexSource, type DeviceCodexRequest } from '../../../shared/device-codex-inference.cjs';
import type { IOpenCodeModelCandidate } from '../../../shared/opencode-model-scan.cjs';
import { projectLevel, type IAccessActor } from '../access/access.model';
import { DeviceStore, type Device } from '../devices/device-store';
import { DeviceArtifacts } from '../devices/device-artifacts';
import { assertManagedBridge, managedBinding, assertPackageBridge } from '../devices/device-compatibility';
import { assertLocalFeature } from '../devices/local-change-jobs';
import { trustedCodexConnector } from '../devices/opencode-provider-jobs';
import { requireFeaturesEnabled } from '../features/require-feature-enabled';
import { securityEvent } from '../access/security-events';
import type { IPackage } from '../catalog/bundle-package';
import { ModelsService } from './models.service';
import { modelFromRow, saveModelVersion, type IModelRow } from './model-history';
import { projectEmbeddingPin } from './project-embedding.validation';
import type { IModel } from './model.types';
type Db = Pick<PoolClient, 'query'>;
export interface DeviceCodexConnection {
    model_id: string;
    device_id: string;
    owner_email: string;
    revision: number;
    source: DeviceCodexSource;
    expected_candidate: unknown;
    connector_package: IPackage;
    semantic_sha: string;
    options: DeviceCodexRequest['options'];
    revoked_at: unknown;
}
/** Owns immutable device/model identity and non-inference availability checks. */
export class DeviceCodexConnections {
    constructor(private readonly models: ModelsService, private readonly devices: DeviceStore, private readonly artifacts: DeviceArtifacts) { }
    async read(id: string, db: Db = this.models.pool): Promise<DeviceCodexConnection> {
        const row = (await db.query<DeviceCodexConnection>('SELECT * FROM model_device_connections WHERE model_id=$1 AND revoked_at IS NULL', [id])).rows[0];
        if (!row)
            throw new ConflictException('Подключение Codex отсутствует или отозвано. Импортируйте его с компьютера заново.');
        return row;
    }
    async assertCurrent(connection: DeviceCodexConnection, actor: IAccessActor, projectId: string | null, model: IModel, db: Db = this.models.pool): Promise<Device> {
        if (connection.owner_email !== actor.email)
            throw new ForbiddenException('Codex доступен только владельцу авторизации на подключённом компьютере.');
        const claims = await this.devices.access.claims(actor.email);
        if (!claims.userRoles.includes(actor.activeRole) || !projectId && actor.activeRole !== 'Главный админ' || projectId && projectLevel(claims, actor.activeRole, projectId) < 2)
            throw new ForbiddenException('Текущая роль не разрешает запрос Codex в этом проекте.');
        const account = (await db.query<{
            enabled: boolean;
            is_main_admin: boolean;
        }>('SELECT enabled,is_main_admin FROM platform_users WHERE email=$1 FOR SHARE', [actor.email])).rows[0];
        const grant = projectId ? (await db.query<{
            role: string;
        }>('SELECT role FROM project_members WHERE project_id=$1 AND lower(principal_name)=$2 FOR SHARE', [projectId, actor.email])).rows[0] : undefined;
        if (!account?.enabled || actor.activeRole === 'Главный админ' && !account.is_main_admin || actor.activeRole !== 'Главный админ' && (!grant || !['Админ проекта', 'Разработчик'].includes(grant.role)))
            throw new ForbiddenException('Назначение роли изменилось перед запросом Codex.');
        if (projectId && !(await db.query('SELECT p.id FROM projects p JOIN project_models pm ON pm.project_id=p.id WHERE p.id=$1 AND pm.model_id=$2 FOR SHARE OF p,pm', [projectId, model.id])).rows.length)
            throw new ConflictException('Модель больше не назначена проекту.');
        const device = (await db.query<Device>(`SELECT * FROM bridge_devices WHERE id=$1 AND email=$2 AND NOT revoked AND expires_at>clock_timestamp()
   AND (paused_until IS NULL OR paused_until<clock_timestamp()) AND last_seen>clock_timestamp()-interval '2 minutes' FOR SHARE`, [connection.device_id, actor.email])).rows[0];
        if (!device || !claims.userRoles.includes(device.role) || device.role === 'Главный админ' && !account.is_main_admin || projectId && projectLevel(claims, device.role, projectId) < 2)
            throw new ServiceUnavailableException('Компьютер Codex недоступен или его роль отозвана. Запустите мост на выбранном компьютере.');
        assertManagedBridge(device.report);
        assertLocalFeature(device.report, DEVICE_CODEX_CAPABILITY);
        assertPackageBridge(device.report, connection.connector_package);
        if (connection.source.scope === 'project') {
            const source = connection.source, binding = (device.report.bindings as Array<{
                projectId: string;
                instanceId?: string;
            }> | undefined)?.find(b => b.projectId === source.projectId);
            if (projectId !== source.projectId || managedBinding(device.report, projectId) !== source.bindingId || binding?.instanceId !== source.instanceId)
                deviceCodexConflict();
        }
        const head = (await db.query<IModelRow>('SELECT * FROM model_catalog WHERE id=$1 AND archived_at IS NULL FOR SHARE', [model.id])).rows[0];
        if (!head || projectEmbeddingPin(modelFromRow(head)) !== projectEmbeddingPin(model) || model.runtime !== 'device-codex' || connection.semantic_sha !== model.verificationSha256)
            deviceCodexConflict();
        const trusted = await trustedCodexConnector(this.devices, this.artifacts);
        if (trusted.manifest.sha256 !== connection.connector_package.manifest.sha256)
            deviceCodexConflict();
        return device;
    }
    async importModel(req: Request, device: Device, candidate: IOpenCodeModelCandidate, source: DeviceCodexSource, projectId: string | null, name: string, expiresAt: string) {
        await requireFeaturesEnabled(['opencode_model_sync', 'device_codex_inference']);
        const owner = await this.models.requireMain(req);
        if (candidate.blocker !== 'codex-local-auth' || candidate.runtime !== 'remote-openai' || candidate.parameterIssues?.length)
            throw new ConflictException('Проверьте конфигурацию Codex на компьютере и повторите чтение OpenCode.');
        const supplied = candidate.options ?? {};
        if (Object.keys(supplied).some(k => !['apiFormat', 'reasoningEffort', 'store','contextWindow'].includes(k)) || supplied.apiFormat !== undefined && supplied.apiFormat !== 'responses' || supplied.store === true)
            throw new BadRequestException('Codex не поддерживает перенос температуры, topP и лимита ответа. Удалите эти параметры в OpenCode и прочитайте конфигурацию заново.');
        const options: DeviceCodexRequest['options'] = { store: false, ...(supplied.reasoningEffort === undefined ? {} : { reasoningEffort: supplied.reasoningEffort }) };
        assertManagedBridge(device.report);
        assertLocalFeature(device.report, DEVICE_CODEX_CAPABILITY);
        const connector = await trustedCodexConnector(this.devices, this.artifacts);
        assertPackageBridge(device.report, connector);
        const expectedCandidate = { provider: candidate.provider, ...(candidate.configKey === undefined ? {} : { configKey: candidate.configKey }), model: candidate.model, modelVersion: candidate.modelVersion, capability: candidate.capability, baseUrl: candidate.baseUrl, ...(candidate.options === undefined ? {} : { options: candidate.options }) };
        const identity = deviceCodexIdentityDigest([owner, device.id, source, expectedCandidate, options, connector.manifest.sha256]);
        const id = 'model-device-codex-' + identity.slice(0, 40), semantic = deviceCodexIdentityDigest([id, device.id, source, connector.manifest.sha256, options]);
        const db = await this.models.pool.connect();
        try {
            await db.query('BEGIN');
            await db.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:device-codex:'||$1,0))", [id]);
            const existing = (await db.query<IModelRow>('SELECT * FROM model_catalog WHERE id=$1 FOR UPDATE', [id])).rows[0];
            if (existing?.archived_at)
                throw new ConflictException('Модель находится в архиве. Восстановите карточку перед повторным подключением.');
            if (!existing && Date.parse(expiresAt) <= Date.now())
                deviceCodexConflict();
            if (!existing && (await db.query('SELECT 1 FROM model_catalog WHERE lower(name)=lower($1)', [name])).rows.length)
                name = name.slice(0, 110) + ' · ' + id.slice(-8);
            const descriptor = { description: 'Codex через личный компьютер. Авторизация остаётся на устройстве.', capability: candidate.capability, runtime: 'device-codex', model: candidate.model, modelVersion: candidate.modelVersion, dimension: null, source: 'custom', manifestSha256: null, verificationSha256: semantic };
            const saved = existing ?? (await db.query<IModelRow>('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,$3::jsonb) RETURNING *', [id, name, JSON.stringify(descriptor)])).rows[0];
            await db.query(`INSERT INTO model_device_connections(model_id,device_id,owner_email,source,expected_candidate,connector_package,semantic_sha,options)
    VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$8::jsonb) ON CONFLICT(model_id) DO NOTHING`, [id, device.id, owner, JSON.stringify(source), JSON.stringify(expectedCandidate), JSON.stringify(connector), semantic, JSON.stringify(options)]);
            if (projectId) {
                await this.models.resolveProject(req, projectId, 3);
                await db.query('INSERT INTO project_models(project_id,model_id,added_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING', [projectId, id, owner]);
            }
            await this.assertCurrent(await this.read(id, db), { email: owner, activeRole: 'Главный админ' }, projectId, modelFromRow(saved), db);
            await this.models.requireMain(req);
            await requireFeaturesEnabled(['opencode_model_sync', 'device_codex_inference']);
            if (!existing) {
                await saveModelVersion(db, saved);
                await securityEvent(db, { actor: owner, action: 'model.import.opencode', resourceId: id, before: null, after: { provider: candidate.provider, model: candidate.model, runtime: 'device-codex', deviceId: device.id, source } });
            }
            await db.query('COMMIT');
            return { model: modelFromRow(saved), localDeviceConnection: { deviceId: device.id, deviceName: device.name, scope: source.scope, ...(source.scope === 'project' ? { projectId: source.projectId } : {}), connectionRevision: 1, status: 'unverified' as const, message: 'Подключение сохранено; запрос модели ещё не проверялся.' }, hasKeyOnComputer: true, repeated: !!existing };
        }
        catch (e) {
            await db.query('ROLLBACK').catch(() => undefined);
            throw e;
        }
        finally {
            db.release();
        }
    }
    async status(model: IModel, actor?: IAccessActor) {
        const connection = await this.read(model.id);
        if (actor && actor.email !== connection.owner_email)
            throw new ForbiddenException('Состояние личного Codex доступно владельцу подключения.');
        const savedDevice = (await this.models.pool.query<{
            name: string;
        }>('SELECT name FROM bridge_devices WHERE id=$1 AND email=$2', [connection.device_id, connection.owner_email])).rows[0];
        const metadata = { deviceName: savedDevice?.name ?? 'Подключённый компьютер', deviceId: connection.device_id, scope: connection.source.scope, ...(connection.source.scope === 'project' ? { projectId: connection.source.projectId } : {}), connectionRevision: connection.revision, status: 'unverified' as const, checkedAt: null };
        const latest = (await this.models.pool.query<{
            completed_at: Date;
        }>('SELECT completed_at FROM device_model_calls WHERE model_id=$1 AND completed_at IS NOT NULL AND result ? \'response\' ORDER BY completed_at DESC LIMIT 1', [model.id])).rows[0];
        try {
            const device = await this.assertCurrent(connection, actor ?? { email: connection.owner_email, activeRole: 'Главный админ' }, connection.source.scope === 'project' ? connection.source.projectId : null, model);
            return { ...metadata, deviceName: device.name, state: 'ready' as const, message: 'Компьютер доступен. Ответ модели этим статусом не проверяется.', lastInferenceAt: latest?.completed_at?.toISOString() ?? null };
        }
        catch (e) {
            return { ...metadata, state: 'unavailable' as const, message: e instanceof Error ? e.message : 'Компьютер Codex недоступен.', lastInferenceAt: latest?.completed_at?.toISOString() ?? null };
        }
    }
}
