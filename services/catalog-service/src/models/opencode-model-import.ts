import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { Request } from 'express';
import { validModelScan } from '../../../shared/opencode-model-scan.cjs';
import { DeviceStore } from '../devices/device-store';
import { managedBinding } from '../devices/device-compatibility';
import { securityEvent } from '../access/security-events';
import { ModelsService } from './models.service';
import { modelFromRow, saveModelVersion, type IModelRow } from './model-history';
import { validateModelCreate } from './model-validation';
import { remoteModelBaseUrl } from './remote-model-validation';
import { openCodeCardMetadata } from './opencode-model-sync.repository';
import {resolveOpenCodeIdentity,saveOpenCodeIdentity} from './opencode-model-identity';

/** Импортирует только выбранную metadata запись из собственной завершённой очереди и текущей папки. */
@Injectable()
export class OpenCodeModelImport {
    constructor(private readonly models: ModelsService, private readonly devices: DeviceStore) {}
    async import(request: Request, value: unknown) {
        const actor = await this.models.requireMain(request);
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Выберите модель из отчёта OpenCode.');
        const body = value as Record<string, unknown>;
        if (Object.keys(body).some(key => !['deviceId', 'jobId', 'candidateId', 'name'].includes(key))
            || ['deviceId', 'jobId', 'candidateId'].some(key => typeof body[key] !== 'string' || !/^[a-f0-9-]{36}$/.test(String(body[key])))) throw new BadRequestException('Нужны компьютер, отчёт и выбранная модель.');
        const device = await this.devices.owned({ email: actor, activeRole: 'Главный админ' }, String(body.deviceId));
        const result = await this.models.pool.query<{ project_id: string|null; result: unknown; payload: Record<string, unknown> }>(`SELECT project_id,result,payload FROM bridge_jobs
            WHERE id=$1 AND device_id=$2 AND email=$3 AND role='Главный админ' AND kind='scan-opencode-models' AND state='succeeded'`, [body.jobId, device.id, actor]);
        const job = result.rows[0];
        if (!job) throw new NotFoundException('Отчёт не найден в вашем профиле или ещё не готов.');
        if(job.payload.scope==='global'?job.project_id!==null:job.payload.scope!=='project'||!job.project_id)throw new ConflictException('Источник отчёта OpenCode устарел. Прочитайте конфигурацию заново.');
        if(job.project_id)await this.models.resolveProject(request, job.project_id, 1);
        if(device.role!=='Главный админ')throw new ConflictException('Подключение компьютера должно принадлежать главному администратору.');
        const binding = Array.isArray(device.report.bindings) ? device.report.bindings.find(item => item.projectId === job.project_id) : undefined;
        const context = job.payload.scope==='global'&&!job.project_id?{scope:'global',deviceId:device.id}:{scope:'project',projectId:job.project_id,bindingId:managedBinding(device.report,job.project_id??undefined),instanceId:binding?.instanceId};
        if (!validModelScan(job.result, context)) throw new ConflictException('Компьютер, папка или отчёт изменились. Повторите чтение OpenCode.');
        const candidate = job.result.candidates.find(item => item.candidateId === body.candidateId);
        if (!candidate || candidate.blocker || !candidate.runtime || !candidate.baseUrl) throw new ConflictException('Это подключение нельзя импортировать автоматически. Укажите поддерживаемый API вручную.');
        const baseUrl = remoteModelBaseUrl(candidate.baseUrl);
        const metadata=openCodeCardMetadata(candidate,job.result.scope);
        let { name, ...native } = validateModelCreate({ name: body.name ?? metadata.name,
            description:metadata.description, runtime: candidate.runtime, model: candidate.model, modelVersion: candidate.modelVersion, capability: candidate.capability });
        const db = await this.models.pool.connect();
        try {
            await db.query('BEGIN');const id=await resolveOpenCodeIdentity(db,candidate);await db.query("SELECT pg_advisory_xact_lock(hashtextextended('neurocenter:model-name:'||lower($1),0))", [name]);
            const live = (await db.query<{ report: Record<string, unknown> }>("SELECT report FROM bridge_devices WHERE id=$1 AND email=$2 AND role='Главный админ' AND NOT revoked AND expires_at>now() FOR SHARE", [device.id, actor])).rows[0];
            const liveBinding = Array.isArray(live?.report.bindings) ? live.report.bindings.find(item => item?.projectId === job.project_id) : undefined;
            if (!live || context.scope==='project'&&(managedBinding(live.report, job.project_id??undefined) !== context.bindingId || liveBinding?.instanceId !== context.instanceId)) throw new ConflictException('Компьютер или папка изменились во время импорта.');
            if(job.project_id){
                if (!(await db.query('SELECT id FROM projects WHERE id=$1 FOR SHARE', [job.project_id])).rows.length) throw new ConflictException('Проект удалён во время импорта.');
                await this.models.resolveProject(request, job.project_id, 1);
            }
            await this.models.requireMain(request);
            const previous = await db.query<IModelRow>('SELECT * FROM model_catalog WHERE id=$1 FOR UPDATE', [id]);
            if (previous.rows[0]?.archived_at) throw new ConflictException('Эта модель находится в архиве. Восстановите карточку или добавьте другое подключение.');
            if (!previous.rows[0] && Date.parse(job.result.expiresAt) <= Date.now()) throw new ConflictException('Отчёт OpenCode истёк. Прочитайте конфигурацию заново.');
            if(!previous.rows[0]&&body.name===undefined&&(await db.query('SELECT 1 FROM model_catalog WHERE lower(name)=lower($1)',[name])).rowCount)name=name.slice(0,115)+' · '+id.slice(-8);
            const saved = previous.rows[0] ?? (await db.query<IModelRow>('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,$3::jsonb) RETURNING *',
                [id, name, JSON.stringify({ ...native, source: 'custom', manifestSha256: null, verificationSha256: null })])).rows[0];
            if (!previous.rows[0]) {
                await saveModelVersion(db, saved);
                await securityEvent(db, { actor, action: 'model.import.opencode', resourceId: id, before: null, after: { provider: candidate.provider, model: candidate.model, runtime: candidate.runtime } });
            }
            await saveOpenCodeIdentity(db,candidate,id);
            await db.query('COMMIT');
            return { model: modelFromRow(saved), baseUrl, hasKeyOnComputer: candidate.hasKey, repeated: !!previous.rows[0],
                ...(candidate.options === undefined ? {} : { options: candidate.options }),
                ...(candidate.timeoutMs === undefined ? {} : { timeoutMs: candidate.timeoutMs }) };
        } catch (cause) {
            await db.query('ROLLBACK').catch(() => undefined);
            if ((cause as { code?: string }).code === '23505') throw new ConflictException('Карточка с таким названием уже есть. Укажите другое название.');
            throw cause;
        } finally { db.release(); }
    }
}
