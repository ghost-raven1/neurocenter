import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { validModelScan } from '../../../shared/opencode-model-scan.cjs';
import { DeviceStore, type Device } from '../devices/device-store';
import { managedBinding } from '../devices/device-compatibility';
import { projectLevel } from '../access/access.model';
import { ModelsService } from './models.service';
import { canStoreModelCredential } from './remote-model-secret';
import { notifyModelCatalogChange } from './model-events';
import { OpenCodeModelSyncRepository } from './opencode-model-sync.repository';
import { requireFeaturesEnabled } from '../features/require-feature-enabled';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Consent is checked for every snapshot; discovery never probes a provider or modifies local OpenCode files. */
@Injectable()
export class OpenCodeModelSyncService {
    readonly repository: OpenCodeModelSyncRepository;
    constructor(private readonly models: ModelsService, private readonly devices: DeviceStore) { this.repository = new OpenCodeModelSyncRepository(models.pool); }
    private async allowed(device: Device): Promise<void> {
        if (device.role !== 'Главный админ' || !(await this.devices.access.claims(device.email)).userRoles.includes('Главный админ')) throw new ForbiddenException('Общий каталог моделей синхронизирует компьютер главного администратора.');
        if(!Array.isArray(device.report.capabilities)||!device.report.capabilities.includes('opencode-model-sync-v2'))throw new ConflictException('Для общей и проектной конфигурации OpenCode обновите мост.');
    }
    async read(request: Request, id: string) {
        if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) throw new BadRequestException('Некорректный компьютер.');
        const email = await this.models.requireMain(request); await this.devices.owned({ email, activeRole: 'Главный админ' }, id);
        const settings = await this.repository.settings(id), sources = await this.repository.sources(id);
        await this.models.requireMain(request);
        return { ...settings, canTransferCredentials: canStoreModelCredential(), sources };
    }
    async configure(request: Request, id: string, value: unknown) {
        const email = await this.models.requireMain(request); await this.devices.owned({ email, activeRole: 'Главный админ' }, id);
        if (!object(value) || Object.keys(value).some(key => !['expectedRevision', 'enabled', 'transferCredentials'].includes(key)) || !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 0 || typeof value.enabled !== 'boolean' || typeof value.transferCredentials !== 'boolean') throw new BadRequestException('Укажите актуальную ревизию и настройки синхронизации.');
        if (value.transferCredentials && !canStoreModelCredential()) throw new ConflictException('На сервере ещё не настроено шифрование ключей моделей.');
        const db = await this.models.pool.connect();
        try {
            await db.query('BEGIN');
            if (!(await db.query('SELECT id FROM bridge_devices WHERE id=$1 AND email=$2 AND NOT revoked AND expires_at>now() FOR UPDATE', [id, email])).rowCount) throw new ConflictException('Компьютер отключён во время изменения настроек.');
            await this.models.requireMain(request);
            const previous = await this.repository.settings(id, db);
            if (previous.revision !== value.expectedRevision) throw new ConflictException('Настройка изменена в другом окне. Обновите данные.');
            if(value.enabled&&(!previous.enabled||value.transferCredentials&&!previous.transferCredentials))await requireFeaturesEnabled(['opencode_model_sync']);
            await db.query(`INSERT INTO opencode_model_sync_settings(device_id,revision,enabled,transfer_credentials) VALUES($1,$2,$3,$4)
                ON CONFLICT(device_id) DO UPDATE SET revision=EXCLUDED.revision,enabled=EXCLUDED.enabled,transfer_credentials=EXCLUDED.transfer_credentials,updated_at=now()`, [id, previous.revision + 1, value.enabled, value.transferCredentials]);
            await db.query('COMMIT');
        } catch (cause) { await db.query('ROLLBACK').catch(() => undefined); throw cause; } finally { db.release(); }
        return this.read(request, id);
    }
    async context(device: Device) {
        await this.allowed(device);
        await requireFeaturesEnabled(['opencode_model_sync']);
        const settings = await this.repository.settings(device.id), claims = await this.devices.access.claims(device.email);
        const bindings = Array.isArray(device.report.bindings) ? device.report.bindings.filter(object).filter(binding => {
            try { return typeof binding.projectId === 'string' && !!managedBinding(device.report, binding.projectId) && typeof binding.instanceId === 'string' && projectLevel(claims, device.role, binding.projectId) >= 1; } catch { return false; }
        }) : [];
        const ids = bindings.map(binding => binding.projectId as string);
        const projects = (await this.models.pool.query<{ id: string }>('SELECT id FROM projects WHERE id=ANY($1::text[])', [ids])).rows.map(row => row.id);
        return { schemaVersion:2,global:{deviceId:device.id},...settings, transferCredentials: settings.transferCredentials && canStoreModelCredential(), bindings: settings.enabled ? bindings.filter(binding => projects.includes(String(binding.projectId))).map(binding => ({ projectId: binding.projectId, bindingId: binding.bindingId, instanceId: binding.instanceId })) : [] };
    }
    async sync(device: Device, value: unknown, authorize: () => Promise<Device>) {
        await this.allowed(device);
        await requireFeaturesEnabled(['opencode_model_sync']);
        if (!object(value) || Object.keys(value).some(key => !['settingsRevision', 'scan', 'credentials'].includes(key)) || !Number.isSafeInteger(value.settingsRevision) || !object(value.credentials) || Buffer.byteLength(JSON.stringify(value)) > 1048576) throw new BadRequestException('Некорректный снимок синхронизации OpenCode.');
        const settings = await this.repository.settings(device.id);
        if (!settings.enabled || settings.revision !== value.settingsRevision) throw new ConflictException('Настройки синхронизации изменились. Повторите чтение OpenCode.');
        const scan = value.scan;
        if (!object(scan) || !['global','project'].includes(String(scan.scope))) throw new BadRequestException('Укажите источник снимка OpenCode.');
        if(scan.scope==='project'&&typeof scan.projectId!=='string')throw new BadRequestException('Нужен проект снимка OpenCode.');
        const binding = scan.scope==='project'&&Array.isArray(device.report.bindings) ? device.report.bindings.find(item => object(item) && item.projectId === scan.projectId) : undefined;
        const source = scan.scope==='global'?{scope:'global',deviceId:device.id}:{scope:'project',projectId:scan.projectId,bindingId:managedBinding(device.report,scan.projectId as string),instanceId:object(binding)?binding.instanceId:undefined};
        if (!validModelScan(scan, source) || Date.parse(scan.expiresAt) <= Date.now() || Date.parse(scan.checkedAt) > Date.now() + 60000) throw new ConflictException('Источник или снимок OpenCode изменились. Повторите чтение.');
        const credentials: Record<string, string> = {};
        const sourceKeys = scan.candidates.map(candidate => JSON.stringify([candidate.provider, candidate.configKey ?? candidate.model]));
        if (new Set(sourceKeys).size !== sourceKeys.length) throw new BadRequestException('Снимок содержит повторяющиеся записи OpenCode.');
        if (Object.keys(value.credentials).length && (!settings.transferCredentials || !canStoreModelCredential())) throw new ForbiddenException('Перенос ключей с этого компьютера не разрешён.');
        for (const [id, key] of Object.entries(value.credentials)) {
            if (!scan.candidates.some(candidate => candidate.candidateId === id && !candidate.blocker && candidate.hasKey) || typeof key !== 'string' || !key || key.length > 8192 || /[\x00-\x20\x7f]/.test(key)) throw new BadRequestException('Ключ не соответствует поддерживаемой записи снимка.');
            credentials[id] = key;
        }
        const assert = async (db: PoolClient): Promise<void> => {
            const fresh = await authorize(); await this.allowed(fresh);
            await requireFeaturesEnabled(['opencode_model_sync']);
            const current = (await db.query<{ report: Record<string, unknown> }>(`SELECT report FROM bridge_devices WHERE id=$1 AND email=$2 AND role='Главный админ' AND NOT revoked AND expires_at>now() FOR SHARE`, [device.id, device.email])).rows[0];
            if(!current)throw new ConflictException('Компьютер изменился во время синхронизации.');
            if(scan.scope==='project'){
                const currentBinding = Array.isArray(current.report.bindings) ? current.report.bindings.find(item => object(item) && item.projectId === scan.projectId) : undefined;
                if (managedBinding(current.report, scan.projectId) !== scan.bindingId || !object(currentBinding) || currentBinding.instanceId !== scan.instanceId || !(await db.query('SELECT id FROM projects WHERE id=$1 FOR SHARE', [scan.projectId])).rowCount) throw new ConflictException('Папка изменилась во время синхронизации.');
            }
        };
        const result = await this.repository.sync(device, scan, settings, credentials, assert);
        if (result.changed) await notifyModelCatalogChange();
        return result;
    }
}
