import {ensureCatalogSchema} from '../database/catalog-schema';
import {BadRequestException,ConflictException,ForbiddenException,HttpException,Injectable,NotFoundException,type OnModuleDestroy,type OnModuleInit} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {Readable} from 'node:stream';
import path from 'node:path';
import {AccessDb} from '../access/access-db';
import {normalizeEmail,type IAccessActor} from '../access/access.model';
import {createPool} from '../database/pool';
import {runtimeArtifactDirectory} from '../runtime-artifacts/runtime-artifacts';
import {CapacityError,reserveCapacity} from '../../../shared/capacity.cjs';
import {inspectUploadArchive} from '../../../shared/upload-inspection.cjs';
import {SourceUploadRepository} from './source-upload.repository';
import {UploadFiles} from './source-upload.files';
import {SourceUploadAvailability} from './source-upload.availability';
import {uploadId,uploadView,uploadRuntime,validateUploadIntent,type UploadBuildSource,type UploadRow,type PinnedUploadSource} from './source-upload.model';

/** Durable upload control plane; data streams hold a PostgreSQL session lease until bytes settle. */
export class SourceUploads{
 readonly repository:SourceUploadRepository;
 readonly files:UploadFiles;
 private streaming=0;
 private readonly active=new Map<string,AbortController>();
 constructor(readonly pool:Pool,root:string,private readonly inspect=inspectUploadArchive){this.repository=new SourceUploadRepository(pool);this.files=new UploadFiles(root);}
 async setup(){await ensureCatalogSchema(this.pool);await this.files.setup();}
 async authorize(actor:IAccessActor,epoch?:string,client:Pick<Pool,'query'>=this.pool):Promise<string>{
  if(!actor||actor.activeRole!=='Главный админ')throw new ForbiddenException('Загружать и упаковывать инструменты может главный администратор.');
  let email:string;try{email=normalizeEmail(actor.email);}catch{throw new ForbiddenException('Не подтверждён владелец загрузки.');}
  const {rows}=await client.query<{epoch:string;is_main_admin:boolean;enabled:boolean}>('SELECT source_upload_auth_epoch::text AS epoch,is_main_admin,enabled FROM platform_users WHERE email=$1',[email]);
  const user=rows[0];if(!user?.is_main_admin||!user.enabled||epoch&&epoch!==user.epoch)throw new ForbiddenException('Права или состояние учётной записи изменились. Загрузка остановлена. Выберите файл заново.');
  return user.epoch;
 }
 protected requireFiles():void{}
 async create(actor:IAccessActor,raw:unknown){const epoch=await this.authorize(actor);this.requireFiles();const input=validateUploadIntent(raw),row=await this.repository.create(normalizeEmail(actor.email),epoch,input);await this.authorize(actor,row.auth_epoch);return uploadView(row);}
 async get(actor:IAccessActor,id:string){await this.authorize(actor);if(!uploadId(id))throw new NotFoundException('Загрузка не найдена.');return uploadView(await this.repository.get(normalizeEmail(actor.email),id));}
 async lookup(actor:IAccessActor,key:string){await this.authorize(actor);if(!uploadId(key))throw new BadRequestException('Нужен UUID загрузки.');return uploadView(await this.repository.lookup(normalizeEmail(actor.email),key));}
 private usable(row:UploadRow){if(row.state==='CANCELLED')throw new ConflictException('Загрузка отменена. Выберите файл заново.');if(new Date(row.expires_at).getTime()<Date.now())throw new ConflictException('Срок загрузки истёк. Выберите файл заново.');}
 async content(actor:IAccessActor,id:string,input:Readable,declared:unknown,signal?:AbortSignal){
  if(this.streaming>=3)throw new ConflictException('Сейчас загружаются три файла. Дождитесь завершения или отмените одну загрузку.');
  this.streaming++;try{return await this.receiveContent(actor,id,input,declared,signal);}finally{this.streaming--;}
 }
 private async receiveContent(actor:IAccessActor,id:string,input:Readable,declared:unknown,signal?:AbortSignal){
  if(!uploadId(id))throw new NotFoundException('Загрузка не найдена.');
  id=id.toLowerCase();await this.authorize(actor);this.requireFiles();const email=normalizeEmail(actor.email),client=await this.pool.connect();
  let durable=false;
  const controller=new AbortController(),abort=()=>{if(!durable)controller.abort(new Error('Передача файла отменена.'));};
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const deadline=setTimeout(()=>controller.abort(new Error('Истекло время загрузки.')),10*60*1000);deadline.unref();
  let locked=false,token='',ready=false,cleanupConfirmed=false,release=()=>{},timer:ReturnType<typeof setInterval>|undefined;
  try{
   const lock=await client.query<{locked:boolean}>('SELECT pg_try_advisory_lock(hashtextextended($1,72465401)) AS locked',[id]);locked=!!lock.rows[0]?.locked;
   if(!locked)throw new ConflictException('Этот файл уже загружается. Проверьте состояние загрузки.');
   const row=await this.repository.get(email,id,client);await this.authorize(actor,row.auth_epoch,client);
   if(row.state==='READY'){await this.files.hash(this.files.filename(id),Number(row.bytes),row.sha256);input.resume();return uploadView(row);}
   this.usable(row);
   if(declared!==undefined&&(!/^\d+$/.test(String(declared))||Number(declared)!==Number(row.bytes)))throw new BadRequestException('Размер потока не совпадает с подтверждённым файлом.');
   release=await reserveCapacity({resource:'runtime-artifacts',bytes:Number(row.bytes)+1024**3,path:this.files.root});
   // A lost commit acknowledgement may leave this exact checked blob; validate it before deciding to replace bytes.
   let reused=false;
   try{await this.files.hash(this.files.filename(id),Number(row.bytes),row.sha256);reused=true;}
   catch(error){if(!(error instanceof ConflictException)&&(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   token=randomUUID();const claimed=await client.query("UPDATE tool_source_uploads SET state='UPLOADING',lease_token=$2,updated_at=now() WHERE id=$1 AND state IN ('WAITING','UPLOADING') RETURNING id",[id,token]);
   if(!claimed.rowCount){const current=await this.repository.get(email,id,client);if(current.state==='READY'){ready=true;await this.authorize(actor,current.auth_epoch,client);await this.files.hash(this.files.filename(id),Number(current.bytes),current.sha256);input.resume();return uploadView(current);}this.usable(current);throw new ConflictException('Состояние загрузки изменилось. Проверьте её перед повтором.');}
   if(!reused)await this.files.remove(id);
   this.active.set(id,controller);
   let checking:Promise<void>|undefined;
   const check=():Promise<void>=>checking??=Promise.resolve().then(async()=>{
    controller.signal.throwIfAborted();await this.authorize(actor,row.auth_epoch);
    const current=await this.repository.get(email,id);if(current.state!=='UPLOADING'||current.lease_token!==token)throw new ConflictException('Загрузка отменена или передана другой попытке.');
   }).finally(()=>{checking=undefined;});
   timer=setInterval(()=>{void check().catch(error=>controller.abort(error));},500);timer.unref();
   if(reused){input.resume();}else await this.files.receive(input,id,token,Number(row.bytes),row.sha256,controller.signal,check);
   durable=true;
   await check();const metadata=await this.inspect(this.files.filename(id),{name:row.name,format:row.format});await check();
   const updated=await this.repository.transaction(async transaction=>{
    const current=await this.repository.get(email,id,transaction,true);await this.authorize(actor,row.auth_epoch,transaction);
    if(current.state!=='UPLOADING'||current.lease_token!==token)throw new ConflictException('Загрузка отменена.');
    return (await transaction.query<UploadRow>("UPDATE tool_source_uploads SET state='READY',metadata=$2,lease_token=NULL,updated_at=now() WHERE id=$1 RETURNING *",[id,JSON.stringify(metadata)])).rows[0];
   });ready=true;return uploadView(updated);
  }catch(error){
   if(token){
    await client.query("UPDATE tool_source_uploads SET state=CASE WHEN state='CANCELLED' THEN state ELSE 'WAITING' END,lease_token=NULL,updated_at=now() WHERE id=$1 AND lease_token=$2",[id,token]).catch(()=>undefined);
    // The held upload lease and a fresh row lock settle any in-flight COMMIT; failed reconciliation keeps bytes.
    try{ready=(await this.repository.get(email,id,client,true)).state==='READY';cleanupConfirmed=true;}catch{}
   }
   if(error instanceof CapacityError)throw new HttpException(error.message,error.statusCode);
   if(error instanceof BadRequestException||error instanceof ConflictException||error instanceof ForbiddenException||error instanceof NotFoundException)throw error;
   if(error instanceof Error&&!('code' in error)&&!/https?:|\/tmp\/|\/var\/|postgres|password|token|secret/i.test(error.message)&&!controller.signal.aborted)throw new BadRequestException(error.message.slice(0,500));
   throw new BadRequestException(controller.signal.aborted?'Передача файла отменена. Можно повторить тот же файл.':'Архив повреждён или не содержит готовой поддерживаемой поставки.');
  }finally{
   clearTimeout(deadline);if(timer)clearInterval(timer);signal?.removeEventListener('abort',abort);if(this.active.get(id)===controller)this.active.delete(id);
   if(token&&!ready&&cleanupConfirmed)await this.files.remove(id).catch(()=>undefined);
   release();if(locked)await client.query('SELECT pg_advisory_unlock(hashtextextended($1,72465401))',[id]).catch(()=>undefined);client.release();
  }
 }
 async pin(actor:IAccessActor,source:UploadBuildSource):Promise<PinnedUploadSource>{
  const row=await this.repository.get(normalizeEmail(actor.email),source.uploadId);await this.authorize(actor,row.auth_epoch);
  this.requireFiles();
  if(row.state!=='READY'||row.sha256!==source.sha256||Number(row.bytes)!==source.bytes)throw new ConflictException('Нужна завершённая загрузка с теми же SHA-256 и размером.');
  this.usable(row);const choice=row.metadata?.choices.find(item=>item.entrypoint===source.entrypoint);if(!choice)throw new BadRequestException('Выберите исполняемый файл из проверенного архива.');
  await this.files.hash(this.files.filename(row.id),source.bytes,source.sha256);
  return {...source,format:row.format,runtimeSource:uploadRuntime(choice)};
 }
 /** Called inside the build enqueue transaction, locking cancellation and expiry against the retained job. */
 async retain(client:PoolClient,actor:string,source:PinnedUploadSource){
  const row=await this.repository.get(normalizeEmail(actor),source.uploadId,client,true);await this.authorize({email:actor,activeRole:'Главный админ'},row.auth_epoch,client);
  if(row.state!=='READY'||row.sha256!==source.sha256||Number(row.bytes)!==source.bytes)throw new ConflictException('Загрузка отменена или изменена перед началом сборки.');this.usable(row);
 }
 async assertRetained(actor:string,source:PinnedUploadSource){const row=await this.repository.get(normalizeEmail(actor),source.uploadId);await this.authorize({email:actor,activeRole:'Главный админ'},row.auth_epoch);this.requireFiles();await this.files.hash(this.files.filename(row.id),source.bytes,source.sha256);}
 protected async removeCancelled(id:string){await this.files.remove(id);await this.pool.query("UPDATE tool_source_uploads SET cleaned_at=now() WHERE id=$1 AND state='CANCELLED'",[id]);}
 async cancel(actor:IAccessActor,id:string){
  await this.authorize(actor);if(!uploadId(id))throw new NotFoundException('Загрузка не найдена.');
  id=id.toLowerCase();const row=await this.repository.transaction(async client=>{
   const row=await this.repository.get(normalizeEmail(actor.email),id,client,true);
   if(await this.repository.referenced(client,id))throw new ConflictException('Исходник уже сохранён в сборке. Его нельзя удалить вместе с формой.');
   return (await client.query<UploadRow>("UPDATE tool_source_uploads SET state='CANCELLED',updated_at=now() WHERE id=$1 RETURNING *",[row.id])).rows[0];
  });this.active.get(id)?.abort(new Error('Загрузка отменена.'));await this.removeCancelled(id);return uploadView(row);
 }
 async cancelRequest(actor:IAccessActor,key:string){
  const epoch=await this.authorize(actor);if(!uploadId(key))throw new BadRequestException('Нужен UUID загрузки.');
  const row=await this.repository.transaction(async client=>{
   await client.query(`INSERT INTO tool_source_uploads(id,actor,request_key,request_hash,name,sha256,bytes,format,state,auth_epoch) VALUES($1,$2,$3,'cancelled','cancelled',$4,1,'file','CANCELLED',$5) ON CONFLICT(actor,request_key) DO NOTHING`,[randomUUID(),normalizeEmail(actor.email),key,'0'.repeat(64),epoch]);
   const result=await client.query<UploadRow>('SELECT * FROM tool_source_uploads WHERE actor=$1 AND request_key=$2 FOR UPDATE',[normalizeEmail(actor.email),key]),row=result.rows[0];
   if(await this.repository.referenced(client,row.id))throw new ConflictException('Исходник уже сохранён в сборке. Его нельзя удалить вместе с формой.');
   return (await client.query<UploadRow>("UPDATE tool_source_uploads SET state='CANCELLED',updated_at=now() WHERE id=$1 RETURNING *",[row.id])).rows[0];
  });this.active.get(row.id)?.abort();await this.removeCancelled(row.id);return uploadView(row);
 }
 async cleanup(){
  const candidates=await this.pool.query<{id:string}>(`SELECT uploads.id FROM tool_source_uploads uploads LEFT JOIN platform_users users ON users.email=uploads.actor WHERE uploads.cleaned_at IS NULL AND (uploads.expires_at<now() OR uploads.state='CANCELLED' OR NOT COALESCE(users.enabled AND users.is_main_admin,false) OR uploads.auth_epoch<>users.source_upload_auth_epoch::text) ORDER BY uploads.cleanup_checked_at NULLS FIRST,uploads.created_at LIMIT 100`);
  for(const candidate of candidates.rows){
   const remove=await this.repository.transaction(async client=>{
    const {rows}=await client.query<UploadRow>('SELECT * FROM tool_source_uploads WHERE id=$1 FOR UPDATE',[candidate.id]);const row=rows[0];if(!row)return false;await client.query('UPDATE tool_source_uploads SET cleanup_checked_at=now() WHERE id=$1',[row.id]);if(await this.repository.referenced(client,row.id))return false;
    await client.query("UPDATE tool_source_uploads SET state='CANCELLED',updated_at=now() WHERE id=$1",[row.id]);return true;
   });if(remove){this.active.get(candidate.id)?.abort();await this.files.remove(candidate.id);await this.pool.query("UPDATE tool_source_uploads SET cleaned_at=now() WHERE id=$1 AND state='CANCELLED'",[candidate.id]);}
  }
 }
 stop(){for(const controller of this.active.values())controller.abort(new Error('Сервис загрузки остановлен.'));}
}

@Injectable()
export class SourceUploadService extends SourceUploads implements OnModuleInit,OnModuleDestroy{
 private readonly availability=new SourceUploadAvailability(async()=>{await this.files.setup();await this.cleanup();});
 constructor(private readonly access:AccessDb){super(createPool({connectionString:process.env.CATALOG_PG_URL||'postgresql://rag:rag@localhost:5432/catalog',max:6},'source-uploads'),path.join(runtimeArtifactDirectory(),'.source-uploads'));}
 protected override requireFiles():void{this.availability.assertReady();}
 protected override async removeCancelled(id:string){
  if(!this.availability.ready)return;
  try{await this.files.remove(id);}catch{this.availability.unavailable();return;}
  await this.pool.query("UPDATE tool_source_uploads SET cleaned_at=now() WHERE id=$1 AND state='CANCELLED'",[id]);
 }
 async onModuleInit(){await this.access.ready();await ensureCatalogSchema(this.pool);this.availability.start();}
 async onModuleDestroy(){this.stop();await this.availability.close();await this.pool.end();}
}
