import {ConflictException,Injectable, type OnModuleInit} from '@nestjs/common';
import {isDeepStrictEqual} from 'node:util';
import {DeviceStore,type Device} from '../devices/device-store';
import {DeviceInstallations} from '../devices/device-installations';
import {InstallPlans} from '../devices/install-plans';
import {assertRagInstallation} from '../devices/rag-installation-authority';
import {readHostedRagGrant} from '../devices/hosted-rag-grants';
import {backfillHostedRagGrants} from '../devices/hosted-rag-grant-backfill';
import type {PoolClient} from 'pg';
import type {Job} from '../devices/device-job.model';
import {ProjectEmbeddingService} from './project-embedding.service';
import {readPinnedModel} from './model-history';
import {assertProjectEmbeddingModel} from './project-embedding.validation';
import type {IConfiguredProjectEmbedding,IDeviceEmbeddingContext} from './project-embedding.types';

/** Разрешение current и historical использует один путь с живыми проверками каждого batch. */
@Injectable()
export class HostedRagGrantService implements OnModuleInit{
    private initialization?:Promise<void>;
    constructor(private readonly devices:DeviceStore,private readonly installations:DeviceInstallations,private readonly plans:InstallPlans,private readonly selection:ProjectEmbeddingService){}
    ready():Promise<void>{return this.initialization??=(async()=>{await Promise.all([this.devices.ready(),this.selection.ready(),this.devices.access.ready()]);await backfillHostedRagGrants(this.devices.pool,(job,db)=>this.validateMigration(job,db));})();}
    /** Использует ту же транзакцию: DDL блокировки не ждут чтения через второй pool connection. */
    async validateMigration(job:Job,db:Pick<PoolClient,'query'>):Promise<void>{
        const device=(await db.query<Device>('SELECT * FROM bridge_devices WHERE id=$1 AND email=$2 AND NOT revoked AND expires_at>now()',[job.device_id,job.email])).rows[0];
        if(!device)throw new ConflictException('Компьютер прежнего подключения отозван.');
        const account=(await db.query<{enabled:boolean;is_main_admin:boolean}>('SELECT enabled,is_main_admin FROM platform_users WHERE email=$1',[job.email])).rows[0];
        const members=await db.query<{role:string}>('SELECT role FROM project_members WHERE project_id=$1 AND lower(principal_name)=lower($2)',[job.project_id,job.email]);
        if(device.role!==job.role||!account?.enabled||(job.role==='Главный админ'?!account.is_main_admin:!['Разработчик','Админ проекта'].includes(job.role)||!members.rows.some(row=>row.role===job.role)))throw new ConflictException('Права прежнего подключения отозваны.');
        await assertRagInstallation(this.installations,this.plans,device,{project_id:job.project_id,payload:job.payload},'core',db);
    }
    async onModuleInit(){await this.ready();}
    async require(device:Device,input:IDeviceEmbeddingContext):Promise<IConfiguredProjectEmbedding>{
        await this.ready();
        const grant=await readHostedRagGrant(this.devices.pool,device,input);
        await assertRagInstallation(this.installations,this.plans,device,{project_id:input.projectId,payload:grant.payload},'core');
        const model=await readPinnedModel(this.devices.pool,grant.model_id,grant.model_pin);
        const saved=grant.payload.embedding as IConfiguredProjectEmbedding;
        if(!model||!saved||!isDeepStrictEqual(saved.profile,{provider:'openai',model:`neurocenter/${model.id}/sha256/${grant.model_pin}`,dimension:model.dimension}))throw new ConflictException('Исторический профиль модели недоступен. Подключите модель повторно.');
        assertProjectEmbeddingModel(model,Number(model.dimension));
        if((await readHostedRagGrant(this.devices.pool,device,input)).id!==grant.id)throw new ConflictException('Подключение изменилось во время проверки.');
        return {...saved,model,modelPin:grant.model_pin,revision:Number(grant.selection_revision),expectedDimension:Number(model.dimension)};
    }
}
