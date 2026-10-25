import {BadRequestException,ConflictException,Inject,Injectable,type OnModuleDestroy} from '@nestjs/common';
import type {Request} from 'express';
import {ModelsService} from '../models/models.service';
import {ModelRuntime,type IModelInferenceRuntime} from '../models/model-runtime';
import {assertProjectEmbeddingModel,projectEmbeddingPin} from '../models/project-embedding.validation';
import {requireFeaturesEnabled} from '../features/require-feature-enabled';
import {withModelUsage} from '../model-usage/model-usage.context';
import {ChatSearchRepository} from './chat-search.repository';
import {CHAT_SEARCH_FEATURES,CHAT_SEARCH_SCAN_CAP,type ChatSearchInput,type ChatSearchJob,type ChatSearchJobRow,type ChatSearchSource,type ChatSearchStoredHit} from './chat-search.types';
import {chatSearchInput,chatSearchChunk,cosine,embeddingVectors} from './chat-search.math';

/** Explicit, durable single-batch jobs reuse ModelRuntime admission and Operations; no paid restart/replay. */
@Injectable()
export class ChatSearchService implements OnModuleDestroy {
    readonly repository:ChatSearchRepository;
    private readonly controllers=new Map<string,AbortController>();
    private readonly tasks=new Set<Promise<void>>();
    constructor(private readonly models:ModelsService,@Inject(ModelRuntime) private readonly runtime:IModelInferenceRuntime){this.repository=new ChatSearchRepository(models.pool);}
    async onModuleDestroy():Promise<void>{for(const controller of this.controllers.values())controller.abort();await Promise.allSettled([...this.tasks]);}
    private project(value:string):string{if(!/^prj-[a-zA-Z0-9-]{1,235}$/.test(value))throw new BadRequestException('Выберите проект по его ID.');return value;}
    private id(value:string):string{if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value))throw new BadRequestException('Некорректный ID запроса.');return value;}
    private async model(req:Request,project:string,input:Pick<ChatSearchInput,'modelId'|'expectedModelPin'>){
        const model=await this.models.getUsable(input.modelId,req,project);
        assertProjectEmbeddingModel(model,model.dimension??0);
        if(model.archivedAt||projectEmbeddingPin(model)!==input.expectedModelPin)throw new ConflictException('Выбранная embedding-модель изменилась. Выберите и подтвердите текущую версию.');return model;
    }
    async create(req:Request,projectId:string,kind:'index'|'search',raw:unknown):Promise<ChatSearchJob>{
        const project=this.project(projectId),actor=this.repository.chat.policy.input(req),input=chatSearchInput(raw,kind);
        const prior=await this.repository.scoped(project,actor,1,db=>this.repository.prior(db,project,actor.email,input,kind));
        if(prior)return this.get(req,project,prior.id);
        await requireFeaturesEnabled(CHAT_SEARCH_FEATURES);
        const model=await this.model(req,project,input);
        let created=false;
        const row=await this.repository.scoped(project,actor,2,async db=>{
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['chat-search:'+project+':'+actor.email]);
            const previous=await this.repository.prior(db,project,actor.email,input,kind);if(previous)return previous;
            await this.repository.expire(db,project,actor.email);
            if((await db.query("SELECT 1 FROM chat_search_jobs WHERE project_id=$1 AND actor=$2 AND state='RUNNING'",[project,actor.email])).rowCount)throw new ConflictException('Дождитесь текущего запроса или отмените его.');
            await requireFeaturesEnabled(CHAT_SEARCH_FEATURES);created=true;return this.repository.create(db,project,actor,input,kind,model.dimension!);
        });
        if(created){const task=this.execute(req,row,input).catch(()=>undefined);this.tasks.add(task);void task.finally(()=>this.tasks.delete(task));}
        return this.get(req,project,row.id);
    }
    async get(req:Request,projectId:string,id:string):Promise<ChatSearchJob>{
        const project=this.project(projectId),actor=this.repository.chat.policy.input(req);this.id(id);
        return this.repository.scoped(project,actor,1,async db=>{
            await this.repository.expire(db,project,actor.email);const row=await this.repository.get(db,project,actor.email,id);
            const results=row.kind==='search'&&row.state==='SUCCEEDED'?await this.repository.hydrate(db,row,row.result.hits??[]):undefined;
            return {id:row.id,projectId:project,kind:row.kind,state:row.state,modelId:row.model_id,modelPin:row.model_pin,indexedChunks:row.result.indexedChunks??0,hasMore:row.result.hasMore??false,error:row.error,...(results?{results}:{})};
        });
    }
    async list(req:Request,projectId:string):Promise<{jobs:ChatSearchJob[]}>{
        const project=this.project(projectId),actor=this.repository.chat.policy.input(req);
        return this.repository.scoped(project,actor,1,async db=>{
            await this.repository.expire(db,project,actor.email);
            const rows=(await db.query<ChatSearchJobRow>('SELECT * FROM chat_search_jobs WHERE project_id=$1 AND actor=$2 ORDER BY created_at DESC,id DESC LIMIT 20',[project,actor.email])).rows;
            return {jobs:rows.map(row=>({id:row.id,projectId:project,kind:row.kind,state:row.state,modelId:row.model_id,modelPin:row.model_pin,indexedChunks:row.result.indexedChunks??0,hasMore:row.result.hasMore??false,error:row.error}))};
        });
    }
    async cancel(req:Request,projectId:string,id:string):Promise<ChatSearchJob>{
        const project=this.project(projectId),actor=this.repository.chat.policy.input(req);this.id(id);
        await this.repository.scoped(project,actor,1,async db=>{const row=await this.repository.get(db,project,actor.email,id,true);await this.repository.finish(db,row,'CANCELLED',{},'Запрос отменён. Автоматический платный повтор не выполняется.');});
        this.controllers.get(id)?.abort();return this.get(req,project,id);
    }
    private async current(req:Request,row:ChatSearchJobRow,input:ChatSearchInput,signal:AbortSignal,source?:ChatSearchSource){
        signal.throwIfAborted();await requireFeaturesEnabled(CHAT_SEARCH_FEATURES);const model=await this.model(req,row.project_id,input);
        const actor=this.repository.chat.policy.input(req);
        await this.repository.scoped(row.project_id,actor,2,async db=>{
            await this.repository.active(db,row);
            if(source&&!await this.repository.sourceCurrent(db,row,source))throw new ConflictException('Сообщение удалено или изменено. Прежний текст не отправлен модели.');
        });signal.throwIfAborted();return model;
    }
    private async embed(req:Request,row:ChatSearchJobRow,input:ChatSearchInput,texts:string[],signal:AbortSignal,source?:ChatSearchSource):Promise<number[][]>{
        const beforeInference=async()=>{await this.current(req,row,input,signal,source);};
        const model=await this.current(req,row,input,signal,source);
        const cancelled=new Promise<never>((_resolve,reject)=>{if(signal.aborted)reject(new Error('Обработка остановлена.'));else signal.addEventListener('abort',()=>reject(new Error('Обработка остановлена.')),{once:true});});
        const result=await Promise.race([withModelUsage({purpose:'reindex',actorEmail:row.actor,projectId:row.project_id,agentId:'agent-indexer',operationId:row.id,requiredFeatures:CHAT_SEARCH_FEATURES,beforeInference},
            ()=>this.runtime.infer(model,'embed',{input:texts,truncate:false},signal)),cancelled]);
        await this.current(req,row,input,signal,source);return embeddingVectors(result.embeddings,texts.length,row.dimension);
    }
    private async execute(req:Request,row:ChatSearchJobRow,input:ChatSearchInput):Promise<void>{
        const controller=new AbortController();this.controllers.set(row.id,controller);
        const timer=setTimeout(()=>controller.abort(),105000);timer.unref();
        const actor=this.repository.chat.policy.input(req),scoped=<T>(work:(db:import('pg').PoolClient)=>Promise<T>)=>this.repository.scoped(row.project_id,actor,2,work);
        try{
            await this.current(req,row,input,controller.signal);
            if(row.kind==='index'){
                const source=await scoped(db=>this.repository.pending(db,row,input.roomId,input.limit));
                const characters=source?Array.from(source.content):[];
                const texts=source?.chunks.map(index=>chatSearchChunk(characters,index))??[];
                const nonempty=texts.map((text,index)=>({text,index})).filter(item=>item.text.trim());
                const returned=nonempty.length?await this.embed(req,row,input,nonempty.map(item=>item.text),controller.signal,source):[];
                const vectors=texts.map(()=>Array(row.dimension).fill(0) as number[]);nonempty.forEach((item,index)=>{vectors[item.index]=returned[index];});
                await this.current(req,row,input,controller.signal);
                await scoped(async db=>{
                    await this.repository.active(db,row);const indexedChunks=source?await this.repository.saveVectors(db,row,source,vectors):0;
                    const hasMore=!!await this.repository.pending(db,row,input.roomId,1);await this.repository.finish(db,row,'SUCCEEDED',{indexedChunks,hasMore});
                });
            }else{
                const count=await scoped(db=>this.repository.count(db,row,input.roomId));
                if(count>CHAT_SEARCH_SCAN_CAP)throw new ConflictException('В индексе больше 10000 фрагментов. Выберите один публичный диалог; неполная выдача не возвращается.');
                const vector=count?(await this.embed(req,row,input,[input.query!],controller.signal))[0]:undefined;
                const hits=vector?await this.rank(row,input,vector,scoped,controller.signal):[];
                await this.current(req,row,input,controller.signal);
                await scoped(async db=>{await this.repository.active(db,row);await this.repository.finish(db,row,'SUCCEEDED',{hits});});
            }
        }catch{
            // Recovery records no source text/provider errors and never starts inference again.
            await this.repository.chat.transaction(db=>this.repository.finish(db,row,'FAILED',{},controller.signal.aborted?'Обработка прервана. Проверьте статус; платный повтор возможен только новым явным запросом.':'Не удалось завершить обработку. Проверьте доступ, текущую модель и индекс; исходные чаты не изменены.')).catch(()=>undefined);
        }finally{clearTimeout(timer);this.controllers.delete(row.id);}
    }
    private async rank(row:ChatSearchJobRow,input:ChatSearchInput,vector:number[],scoped:<T>(work:(db:import('pg').PoolClient)=>Promise<T>)=>Promise<T>,signal:AbortSignal):Promise<ChatSearchStoredHit[]>{
        const size=Math.max(1,Math.min(64,Math.floor(1024**2/(row.dimension*8)))),deadline=Date.now()+5000;
        let cursor:{id:string;chunk:number}|undefined,scanned=0,hits:ChatSearchStoredHit[]=[];
        for(;;){
            signal.throwIfAborted();if(Date.now()>deadline)throw new ConflictException('Поиск превысил время. Выберите один диалог.');
            const page=await scoped(async db=>{await this.repository.active(db,row);await db.query("SET LOCAL statement_timeout='4s'");return this.repository.page(db,row,input.roomId,cursor,size);});
            if(!page.length)break;scanned+=page.length;if(scanned>CHAT_SEARCH_SCAN_CAP)throw new ConflictException('Поиск превысил 10000 фрагментов.');
            for(const item of page){
                const score=cosine(vector,item.embedding);if(!Number.isFinite(score)||score<=0)continue;
                const previous=hits.find(hit=>hit.messageId===item.message_id);if(previous&&previous.score>=score)continue;
                hits=hits.filter(hit=>hit.messageId!==item.message_id);hits.push({messageId:item.message_id,revision:item.revision,chunk:item.chunk_index,score});hits.sort((a,b)=>b.score-a.score||a.messageId.localeCompare(b.messageId));hits=hits.slice(0,input.limit);
            }
            const last=page[page.length-1];cursor={id:last.message_id,chunk:last.chunk_index};
        }
        return hits;
    }
}
