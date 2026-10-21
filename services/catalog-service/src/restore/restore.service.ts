import {BadRequestException,ForbiddenException,Injectable,OnModuleDestroy,OnModuleInit,ServiceUnavailableException} from '@nestjs/common';
import {timingSafeEqual} from 'node:crypto';
import type {Request} from 'express';
import {AccessDb} from '../access/access-db';
import {readModelActor} from '../models/model-access';
import {createPool} from '../database/pool';
import {previewRequest,restoreRequest,runnerReport,previewResult,restoreReceipt,restoreFailureMessages,uuid} from '../../../shared/web-restore.cjs';
import {RestoreRepository} from './restore.repository';
import {restoreJobView} from './restore.types';

const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
/** HTTP фиксирует намерение; Docker и восстановление исполняются только отдельным host runner. */
@Injectable()
export class RestoreService implements OnModuleInit,OnModuleDestroy {
 readonly pool=createPool({connectionString:process.env.CATALOG_PG_URL||'postgresql://rag:rag@localhost:5432/catalog',max:4},'web-restore');
 readonly repository=new RestoreRepository(this.pool);private initialized?:Promise<void>;
 constructor(private readonly access:AccessDb){}
 ready(){return this.initialized??=(this.repository.setup());}
 async onModuleInit(){await this.ready();}
 async onModuleDestroy(){await this.pool.end();}
 async actor(req:Request){const actor=await readModelActor(req,this.access);if(actor.activeRole!=='Главный админ')throw new ForbiddenException('Восстановлением управляет главный администратор.');return actor.email;}
 private async authorized(actor:string){return (await this.access.claims(actor)).userRoles.includes('Главный админ');}
 private validate<T>(read:()=>T):T{try{return read();}catch(error){throw new BadRequestException((error as Error).message);}}
 async status(actor:string){await this.ready();const status=await this.repository.status(actor);return {...status,jobs:status.jobs.map(restoreJobView)};}
 async preview(actor:string,input:unknown){const checked=this.validate(()=>previewRequest(input));await this.ready();return restoreJobView(await this.repository.create(actor,'preview',checked));}
 async restore(actor:string,input:unknown){const checked=this.validate(()=>restoreRequest(input));await this.ready();return restoreJobView(await this.repository.create(actor,'restore',checked));}
 async get(actor:string,key:string,byRequest=false){if(!uuid(key))throw new BadRequestException('Некорректный идентификатор запроса.');await this.ready();return restoreJobView(await this.repository.get(actor,key,byRequest));}
 async cancel(actor:string,id:string){if(!uuid(id))throw new BadRequestException('Некорректный идентификатор запроса.');await this.ready();return restoreJobView(await this.repository.cancel(actor,id));}
 async cancelRequest(actor:string,key:string){if(!uuid(key))throw new BadRequestException('Некорректный ключ запроса.');await this.ready();return this.repository.cancelRequest(actor,key);}
 assertRunner(token:unknown){
  const expected=process.env.RESTORE_RUNNER_TOKEN;
  if(!expected||Buffer.byteLength(expected)<32)throw new ServiceUnavailableException('Исполнитель восстановления не настроен.');
  if(typeof token!=='string'||Buffer.byteLength(token)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(token),Buffer.from(expected)))throw new ForbiddenException('Нужна служебная идентичность исполнителя восстановления.');
 }
 async report(input:unknown){const checked=this.validate(()=>runnerReport(input));await this.ready();return this.repository.report(checked);}
 async claim(input:unknown){if(!record(input)||Object.keys(input).join(',')!=='runnerId'||!uuid(input.runnerId))throw new BadRequestException('Некорректная идентичность исполнителя.');await this.ready();return this.repository.claim(input.runnerId,actor=>this.authorized(actor));}
 private lease(input:unknown){
  if(!record(input)||!uuid(input.runnerId)||!uuid(input.leaseId))throw new BadRequestException('Некорректная аренда исполнителя.');return input as Record<string,unknown>&{runnerId:string;leaseId:string};
 }
 async pulse(id:string,input:unknown){
  const lease=this.lease(input);if(!uuid(id)||Object.keys(lease).some(key=>!['runnerId','leaseId','message'].includes(key))||typeof lease.message!=='string'||lease.message.length<1||lease.message.length>300||/[\x00-\x1f\x7f]/.test(lease.message))throw new BadRequestException('Некорректный статус исполнителя.');
  await this.ready();const job=(await this.pool.query<{actor:string}>('SELECT actor FROM web_restore_jobs WHERE id=$1 AND runner_id=$2 AND lease_id=$3',[id,lease.runnerId,lease.leaseId])).rows[0];
  if(!job||!await this.authorized(job.actor))throw new ForbiddenException('Права на восстановление отозваны. Следующая запись запрещена.');
  return this.repository.pulse(id,lease.runnerId,lease.leaseId,lease.message);
 }
 async complete(id:string,input:unknown){
  const lease=this.lease(input);if(!uuid(id)||Object.keys(lease).some(key=>!['runnerId','leaseId','state','preview','receipt','errorCode'].includes(key))||!['ready','succeeded','failed'].includes(String(lease.state))||lease.state!=='ready'&&lease.preview!==undefined||lease.state!=='succeeded'&&lease.receipt!==undefined||lease.errorCode!==undefined&&(lease.state!=='failed'||typeof lease.errorCode!=='string'||!Object.prototype.hasOwnProperty.call(restoreFailureMessages,lease.errorCode)))throw new BadRequestException('Некорректный результат исполнителя.');
  if(lease.state==='ready')this.validate(()=>previewResult(lease.preview));if(lease.state==='succeeded')this.validate(()=>restoreReceipt(lease.receipt));
  await this.ready();return restoreJobView(await this.repository.complete(id,lease.runnerId,lease.leaseId,{state:lease.state as 'ready'|'succeeded'|'failed',preview:lease.preview,receipt:lease.receipt,errorCode:lease.errorCode as string|undefined}));
 }
}
