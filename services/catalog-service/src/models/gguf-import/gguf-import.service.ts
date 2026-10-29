import {BadRequestException,ConflictException,ForbiddenException,HttpException,Injectable,NotFoundException,type OnModuleDestroy,type OnModuleInit} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import type {Pool,PoolClient} from 'pg';
import type {Readable} from 'node:stream';
import {DEFAULT_GGUF_IMPORT_POLICY,configuredGgufImportPolicy,ggufImportPolicy,type GgufImportPolicy} from '../../../../shared/gguf-import-policy.cjs';
import {CapacityError,reserveCapacity} from '../../../../shared/capacity.cjs';
import {AccessDb} from '../../access/access-db';
import {normalizeEmail,type IAccessActor} from '../../access/access.model';
import {createPool} from '../../database/pool';
import {ensureCatalogSchema} from '../../database/catalog-schema';
import {requireFeaturesEnabled} from '../../features/require-feature-enabled';
import {runtimeArtifactDirectory} from '../../runtime-artifacts/runtime-artifacts';
import {SourceUploadAvailability} from '../../source-upload/source-upload.availability';
import {RuntimeLimitsService} from '../../runtime-limits/runtime-limits.service';
import {RUNTIME_LIMIT_CEILINGS} from '../../../../shared/runtime-limits.cjs';
import {assertGgufCapacity} from './gguf-import.capacity';
import {GgufImportFiles} from './gguf-import.files';
import {GgufImportRepository,ggufFingerprint,ggufRequestHash,type GgufDatabase} from './gguf-import.repository';
import {ggufAcceptance,ggufImportId,ggufIntent,ggufReceipt,type GgufUploadRow} from './gguf-import.model';
import {inspectGguf} from './gguf-inspection';

/** Durable GGUF admission; the policy is frozen per request while authorization stays fresh. */
export class GgufImports {
 readonly repository:GgufImportRepository;readonly files:GgufImportFiles;
 private readonly active=new Map<string,AbortController>();private streaming=0;
 constructor(readonly pool:Pool,root:string,private readonly policy:()=>Promise<Readonly<GgufImportPolicy>>=async()=>configuredGgufImportPolicy(),private readonly flags=()=>requireFeaturesEnabled(['gguf_import']),private readonly streamPool:Pool=pool){this.repository=new GgufImportRepository(pool);this.files=new GgufImportFiles(root);}
 protected streamLease():Promise<PoolClient>{return this.streamPool.connect();}
 async setup(){await ensureCatalogSchema(this.pool);await this.files.setup();}
 protected requireFiles():void{}
 async authorize(actor:IAccessActor,epoch?:string,db:GgufDatabase=this.pool,lock=false):Promise<string>{
  if(!actor||actor.activeRole!=='Главный админ')throw new ForbiddenException('Импортировать GGUF может главный администратор.');let email:string;try{email=normalizeEmail(actor.email);}catch{throw new ForbiddenException('Не подтверждён владелец импорта.');}
  const user=(await db.query<{epoch:string;enabled:boolean;is_main_admin:boolean}>('SELECT source_upload_auth_epoch::text AS epoch,enabled,is_main_admin FROM platform_users WHERE email=$1'+(lock?' FOR UPDATE':''),[email])).rows[0];
  if(!user?.enabled||!user.is_main_admin||epoch&&epoch!==user.epoch)throw new ForbiddenException('Права или состояние учётной записи изменились. Выберите GGUF заново.');return user.epoch;
 }
 async limits(actor:IAccessActor){await this.authorize(actor);return ggufImportPolicy(await this.policy());}
 async create(actor:IAccessActor,raw:unknown){
  await this.authorize(actor);const input=ggufIntent(raw,{...DEFAULT_GGUF_IMPORT_POLICY,maximumBytes:Number.MAX_SAFE_INTEGER}),email=normalizeEmail(actor.email);
  return this.repository.transaction(async db=>{const epoch=await this.authorize(actor,undefined,db,true),previous=await this.repository.find(email,input.requestKey,db);
   if(previous){if(previous.request_hash!==ggufRequestHash(input))throw new ConflictException('Этот UUID уже принадлежит другому файлу.');return ggufReceipt(previous);}
   const limits=ggufImportPolicy(await this.policy());await this.flags();this.requireFiles();ggufIntent(raw,limits);await this.repository.quota(email,limits,db,input.bytes,1);
   return ggufReceipt(await this.repository.create(email,epoch,input,limits,db));
  });
 }
 async get(actor:IAccessActor,id:string){await this.authorize(actor);if(!ggufImportId(id))throw new NotFoundException('Импорт GGUF не найден.');return ggufReceipt(await this.repository.get(normalizeEmail(actor.email),id.toLowerCase()));}
 async lookup(actor:IAccessActor,key:string){await this.authorize(actor);if(!ggufImportId(key))throw new BadRequestException('Нужен UUID запроса импорта.');const row=await this.repository.find(normalizeEmail(actor.email),key.toLowerCase());if(!row)throw new NotFoundException('Импорт ещё не создан.');return ggufReceipt(row);}
 private usable(row:GgufUploadRow){if(row.state==='CANCELLED')throw new ConflictException('Импорт отменён. Выберите GGUF заново.');if(row.state!=='ACCEPTED'&&new Date(row.expires_at).getTime()<=Date.now())throw new ConflictException('Срок импорта истёк. Выберите GGUF заново.');}
 private async capacity(limits:GgufImportPolicy,bytes=0){try{return await reserveCapacity({resource:'runtime-artifacts',bytes:bytes+limits.diskReserveBytes,path:this.files.root});}catch(error){if(error instanceof CapacityError)throw new HttpException(error.message,error.statusCode);throw error;}}
 async content(actor:IAccessActor,id:string,input:Readable,declared:unknown,signal?:AbortSignal){
  await this.authorize(actor);if(!ggufImportId(id))throw new NotFoundException('Импорт GGUF не найден.');id=id.toLowerCase();const email=normalizeEmail(actor.email),row=await this.repository.get(email,id);
  if(this.streaming>=row.limits.activeUploads)throw new ConflictException('Достигнут лимит параллельных импортов. Дождитесь завершения или отмените загрузку.');
  this.streaming++;try{return await this.receive(actor,row,input,declared,signal);}finally{this.streaming--;}
 }
 private async receive(actor:IAccessActor,initial:GgufUploadRow,input:Readable,declared:unknown,signal?:AbortSignal){
  const id=initial.id,email=normalizeEmail(actor.email),client=await this.streamLease(),controller=new AbortController();let locked=false,token='',ready=false,committing=false,discard=false,cleanup=false,release=()=>{};
  const aborted=()=>{if(!committing)controller.abort(new Error('Передача GGUF отменена.'));},disconnected=()=>{discard=true;controller.abort(new Error('Потеряна аренда загрузки.'));};
  client.on('error',disconnected);signal?.addEventListener('abort',aborted,{once:true});if(signal?.aborted)aborted();
  const deadline=setTimeout(()=>controller.abort(new Error('Истекло время загрузки GGUF.')),initial.limits.uploadTimeoutMs);deadline.unref();let timer:ReturnType<typeof setInterval>|undefined;
  try{
   locked=!!(await client.query<{locked:boolean}>('SELECT pg_try_advisory_lock(hashtextextended($1,72465402)) AS locked',[id])).rows[0]?.locked;if(!locked)throw new ConflictException('Этот GGUF уже загружается. Проверьте состояние.');
   const row=await this.repository.get(email,id,client);await this.authorize(actor,row.state==='ACCEPTED'?undefined:row.auth_epoch,client);this.usable(row);this.requireFiles();
   if(['READY','ACCEPTED'].includes(row.state)){await this.files.digest(id,Number(row.bytes),row.sha256);input.resume();return ggufReceipt(row);}
   await this.flags();controller.signal.throwIfAborted();
   if(declared!==undefined&&(!/^\d+$/.test(String(declared))||Number(declared)!==Number(row.bytes)))throw new BadRequestException('Размер потока не совпадает с выбранным GGUF.');
   release=await this.capacity(row.limits,Number(row.bytes));token=randomUUID();
   const claimed=await client.query("UPDATE model_gguf_uploads SET state='UPLOADING',lease_token=$2,updated_at=now() WHERE id=$1 AND state IN ('WAITING','UPLOADING') RETURNING id",[id,token]);if(!claimed.rowCount)throw new ConflictException('Состояние импорта изменилось.');
   this.active.set(id,controller);let checking:Promise<void>|undefined;
   const check=():Promise<void>=>checking??=Promise.resolve().then(async()=>{controller.signal.throwIfAborted();if(discard)throw new ConflictException('Аренда загрузки потеряна.');await this.authorize(actor,row.auth_epoch);const current=await this.repository.get(email,id);if(current.state!=='UPLOADING'||current.lease_token!==token)throw new ConflictException('Импорт отменён или принадлежит другой попытке.');}).finally(()=>{checking=undefined;});
   timer=setInterval(()=>void check().catch(error=>controller.abort(error)),row.limits.checkIntervalMs);timer.unref();
   let sha256:string|undefined;try{sha256=await this.files.digest(id,Number(row.bytes),row.expected_sha256,check,row.limits.checkIntervalMs);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'&&!(error instanceof ConflictException))throw error;await check();}
   if(sha256)input.resume();else{await this.files.remove(id);sha256=await this.files.receiveGguf(input,id,token,Number(row.bytes),row.expected_sha256,controller.signal,check,row.limits.checkIntervalMs);}
   await check();const metadata=await inspectGguf(this.files.filename(id),row.limits,check);await check();
   await assertGgufCapacity(this.files.root,row.limits);committing=true;
    const updated=await this.repository.transaction(async db=>{const current=await this.repository.get(email,id,db,true);await this.authorize(actor,row.auth_epoch,db,true);controller.signal.throwIfAborted();if(discard||current.state!=='UPLOADING'||current.lease_token!==token)throw new ConflictException('Импорт отменён или аренда потеряна.');this.usable(current);await this.flags();await this.repository.quota(email,row.limits,db);
     return (await db.query<GgufUploadRow>("UPDATE model_gguf_uploads SET state='READY',sha256=$2,metadata=$3::jsonb,lease_token=NULL,updated_at=now() WHERE id=$1 RETURNING *",[id,sha256,JSON.stringify(metadata)])).rows[0];
    });ready=true;return ggufReceipt(updated);
  }catch(error){
   if(token&&!discard){try{const current=await this.repository.transaction(async db=>{const row=await this.repository.get(email,id,db,true);if(row.state==='UPLOADING'&&row.lease_token===token)await db.query("UPDATE model_gguf_uploads SET state='WAITING',lease_token=NULL,updated_at=now() WHERE id=$1",[id]);return row;});ready=['READY','ACCEPTED'].includes(current.state);cleanup=!ready;}catch{}}
   if(error instanceof HttpException)throw error;throw new BadRequestException(controller.signal.aborted?'Передача GGUF прервана. Проверьте квитанцию и повторите тот же файл.':'Не удалось сохранить GGUF. Проверьте квитанцию и повторите загрузку.');
  }finally{
   clearTimeout(deadline);if(timer)clearInterval(timer);signal?.removeEventListener('abort',aborted);if(this.active.get(id)===controller)this.active.delete(id);
   if(cleanup)await this.files.remove(id).catch(()=>{});release();if(locked&&!discard)try{await client.query('SELECT pg_advisory_unlock(hashtextextended($1,72465402))',[id]);}catch{discard=true;}client.off('error',disconnected);client.release(discard);
  }
 }
 async accept(actor:IAccessActor,id:string,raw:unknown){
  await this.authorize(actor);if(!ggufImportId(id))throw new NotFoundException('Импорт GGUF не найден.');id=id.toLowerCase();const input=ggufAcceptance(raw,id),hash=ggufFingerprint(input),email=normalizeEmail(actor.email),row=await this.repository.get(email,id);
  if(row.state==='ACCEPTED'){if(row.accept_hash!==hash)throw new ConflictException('Импорт уже принят с другими параметрами.');return this.repository.accepted(row,this.pool);}
  this.usable(row);if(row.state!=='READY'||!row.sha256)throw new ConflictException('Сначала дождитесь проверки GGUF.');await this.flags();this.requireFiles();await this.authorize(actor,row.auth_epoch);await this.files.digest(id,Number(row.bytes),row.sha256,async()=>{await this.authorize(actor,row.auth_epoch);const current=await this.repository.get(email,id);if(current.state!=='READY'&&current.state!=='ACCEPTED')throw new ConflictException('Импорт отменён.');},row.limits.checkIntervalMs);
  await assertGgufCapacity(this.files.root,row.limits);return await this.repository.transaction(async db=>{const current=await this.repository.get(email,id,db,true);await this.authorize(actor,current.state==='ACCEPTED'?undefined:current.auth_epoch,db,true);
   if(current.state==='ACCEPTED'){if(current.accept_hash!==hash)throw new ConflictException('Импорт уже принят с другими параметрами.');return this.repository.accepted(current,db);}this.usable(current);if(current.state!=='READY'||current.sha256!==row.sha256)throw new ConflictException('Состояние GGUF изменилось.');await this.flags();await this.repository.quota(email,current.limits,db);return this.repository.accept(current,input,hash,db);
  });
 }
 async cancel(actor:IAccessActor,id:string){
  await this.authorize(actor);if(!ggufImportId(id))throw new NotFoundException('Импорт GGUF не найден.');id=id.toLowerCase();const row=await this.repository.transaction(async db=>{const row=await this.repository.get(normalizeEmail(actor.email),id,db,true);await this.authorize(actor,undefined,db,true);if(row.state==='ACCEPTED')throw new ConflictException('Файл уже принят в модель. Источник модели сохранён.');return (await db.query<GgufUploadRow>("UPDATE model_gguf_uploads SET state='CANCELLED',lease_token=NULL,updated_at=now() WHERE id=$1 RETURNING *",[id])).rows[0];});this.active.get(id)?.abort();await this.removeCancelled(id);return ggufReceipt(row);
 }
 protected async removeCancelled(id:string){await this.repository.transaction(async db=>{
  // A live stream owns the matching session lock; its late rename must settle before cleanup is marked done.
  const lease=(await db.query<{locked:boolean}>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,72465402)) AS locked',[id])).rows[0];if(!lease?.locked)return;
  const row=(await db.query<GgufUploadRow>('SELECT * FROM model_gguf_uploads WHERE id=$1 FOR UPDATE',[id])).rows[0];if(row?.state!=='CANCELLED')return;
  await this.files.remove(id);await db.query("UPDATE model_gguf_uploads SET cleaned_at=now() WHERE id=$1 AND state='CANCELLED'",[id]);
 });}
 async cleanup(){const candidates=await this.pool.query<{id:string;actor:string}>(`SELECT uploads.id,uploads.actor FROM model_gguf_uploads uploads LEFT JOIN platform_users users ON users.email=uploads.actor WHERE uploads.state<>'ACCEPTED' AND uploads.cleaned_at IS NULL AND (uploads.state='CANCELLED' OR uploads.expires_at<=now() OR NOT COALESCE(users.enabled AND users.is_main_admin,false) OR uploads.auth_epoch<>users.source_upload_auth_epoch::text) ORDER BY uploads.created_at LIMIT 100`);for(const row of candidates.rows){const cancelled=await this.repository.transaction(async db=>{const current=await this.repository.get(row.actor,row.id,db,true);if(current.state==='ACCEPTED')return false;await db.query("UPDATE model_gguf_uploads SET state='CANCELLED',lease_token=NULL,updated_at=now() WHERE id=$1",[row.id]);return true;});if(cancelled){this.active.get(row.id)?.abort();await this.removeCancelled(row.id);}}}
 stop(){for(const controller of this.active.values())controller.abort();}
}

@Injectable()
export class GgufImportService extends GgufImports implements OnModuleInit,OnModuleDestroy {
 private readonly availability=new SourceUploadAvailability(async()=>{await this.files.setup();await this.cleanup();});
 private readonly leases:Pool;
 constructor(private readonly access:AccessDb,limits:RuntimeLimitsService){const config={connectionString:process.env.CATALOG_PG_URL||'postgresql://rag:rag@localhost:5432/catalog'},leases=createPool({...config,max:RUNTIME_LIMIT_CEILINGS.ggufImport.activeUploads},'gguf-stream-leases');super(createPool({...config,max:6},'gguf-imports'),path.join(runtimeArtifactDirectory(),'.gguf-imports'),()=>limits.ggufPolicy(),undefined,leases);this.leases=leases;}
 protected override requireFiles(){this.availability.assertReady();}
 protected override async removeCancelled(id:string){if(!this.availability.ready)return;try{await super.removeCancelled(id);}catch{this.availability.unavailable();}}
 async onModuleInit(){await this.access.ready();await ensureCatalogSchema(this.pool);this.availability.start();}
 async onModuleDestroy(){this.stop();await this.availability.close();await Promise.all([this.pool.end(),this.leases.end()]);}
}
