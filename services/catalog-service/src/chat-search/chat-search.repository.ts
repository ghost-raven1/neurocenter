import {ConflictException,NotFoundException} from '@nestjs/common';
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {IAccessActor} from '../access/access.model';
import {ProjectChatRepository} from '../project-chat/project-chat.repository';
import {CHAT_SEARCH_CHUNK,type ChatSearchInput,type ChatSearchJobRow,type ChatSearchSource,type ChatSearchStoredHit,type ChatSearchHit} from './chat-search.types';
import {chatSearchHash} from './chat-search.math';
type Db=Pick<PoolClient,'query'>;
const live=`JOIN project_chat_messages m ON m.project_id=v.project_id AND m.id=v.message_id
 JOIN chat_search_revisions r ON r.project_id=m.project_id AND r.message_id=m.id AND r.revision=v.revision AND NOT r.tombstone
 JOIN project_chat_rooms room ON room.project_id=m.project_id AND room.id=m.room_id
 WHERE v.project_id=$1 AND v.model_id=$2 AND v.model_pin=$3 AND room.visibility='PUBLIC' AND m.status='done' AND length(btrim(m.content))>0`;

/** Chat policy owns live project grants; the index stores vectors and references, never message copies. */
export class ChatSearchRepository {
    readonly chat:ProjectChatRepository;
    constructor(readonly pool:Pool){this.chat=new ProjectChatRepository(pool);}
    scoped<T>(project:string,actor:IAccessActor,level:number,work:(db:PoolClient)=>Promise<T>):Promise<T>{
        return this.chat.transaction(async db=>{await db.query("SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='2s'");await this.chat.policy.authorize(db,project,actor,level,true);const result=await work(db);await this.chat.policy.authorize(db,project,actor,level,true);return result;});
    }
    async projection(db:Db,row:ChatSearchJobRow):Promise<void>{
        const message=row.state==='RUNNING'?'Семантическая обработка публичного чата':row.state==='SUCCEEDED'?'Семантическая обработка завершена':row.error??'Семантическая обработка отменена';
        await db.query(`INSERT INTO operations(operation_id,type,project_id,resource_type,resource_id,actor,state,percent,started_at,finished_at,error,log)
          VALUES($1,'PROJECT',$2,'project',$2,$3,$4,$5,now(),CASE WHEN $4='RUNNING' THEN NULL ELSE now() END,$6,$7::jsonb)
          ON CONFLICT(operation_id) DO UPDATE SET state=excluded.state,percent=excluded.percent,finished_at=excluded.finished_at,error=excluded.error,log=excluded.log`,
        ['chat-search-'+row.id,row.project_id,row.actor,row.state,row.state==='SUCCEEDED'?100:0,row.error,JSON.stringify([{at:new Date().toISOString(),level:row.error?'ERROR':'INFO',message}])]);
    }
    async expire(db:Db,project:string,actor:string):Promise<void>{
        const rows=(await db.query<ChatSearchJobRow>(`UPDATE chat_search_jobs SET state='FAILED',error='Обработка прервана или превысила время. Новый платный запрос автоматически не отправлен.',finished_at=now()
          WHERE project_id=$1 AND actor=$2 AND state='RUNNING' AND deadline<now() RETURNING *`,[project,actor])).rows;
        for(const row of rows)await this.projection(db,row);
    }
    async prior(db:Db,project:string,actor:string,input:ChatSearchInput,kind:'index'|'search'):Promise<ChatSearchJobRow|undefined>{
        const row=(await db.query<ChatSearchJobRow>('SELECT * FROM chat_search_jobs WHERE project_id=$1 AND actor=$2 AND request_key=$3',[project,actor,input.requestKey])).rows[0];
        if(row&&row.request_hash!==chatSearchHash({kind,...input}))throw new ConflictException('Ключ уже закреплён за другим запросом.');return row;
    }
    async create(db:Db,project:string,actor:IAccessActor,input:ChatSearchInput,kind:'index'|'search',dimension:number):Promise<ChatSearchJobRow>{
        const row=(await db.query<ChatSearchJobRow>(`INSERT INTO chat_search_jobs(id,project_id,actor,active_role,request_key,request_hash,kind,state,model_id,model_pin,dimension,deadline)
          VALUES($1,$2,$3,$4,$5,$6,$7,'RUNNING',$8,$9,$10,now()+interval '120 seconds') RETURNING *`,
        [randomUUID(),project,actor.email,actor.activeRole,input.requestKey,chatSearchHash({kind,...input}),kind,input.modelId,input.expectedModelPin,dimension])).rows[0];
        await this.projection(db,row);return row;
    }
    async get(db:Db,project:string,actor:string,id:string,lock=false):Promise<ChatSearchJobRow>{
        const row=(await db.query<ChatSearchJobRow>('SELECT * FROM chat_search_jobs WHERE project_id=$1 AND actor=$2 AND id=$3'+(lock?' FOR UPDATE':''),[project,actor,id])).rows[0];
        if(!row)throw new NotFoundException('Запрос семантического поиска не найден.');return row;
    }
    async active(db:Db,row:ChatSearchJobRow):Promise<void>{
        const current=await this.get(db,row.project_id,row.actor,row.id,true);
        if(current.state!=='RUNNING'||new Date(current.deadline).getTime()<=Date.now())throw new ConflictException('Запрос остановлен или его срок истёк. Автоматического платного повтора нет.');
    }
    async finish(db:Db,row:ChatSearchJobRow,state:ChatSearchJobRow['state'],result:ChatSearchJobRow['result']={},error:string|null=null):Promise<ChatSearchJobRow>{
        const updated=(await db.query<ChatSearchJobRow>(`UPDATE chat_search_jobs SET state=$2,result=$3::jsonb,error=$4,finished_at=now()
          WHERE id=$1 AND state='RUNNING' RETURNING *`,[row.id,state,JSON.stringify(result),error])).rows[0];
        if(updated)await this.projection(db,updated);return updated??row;
    }
    async pending(db:Db,row:ChatSearchJobRow,roomId?:string,limit=32):Promise<ChatSearchSource|undefined>{
        const source=(await db.query<Omit<ChatSearchSource,'chunks'>>(`SELECT m.id,m.room_id,r.revision::text,m.content,m.position::text,room.title AS room_title,m.author_name
          FROM project_chat_messages m JOIN chat_search_revisions r ON r.project_id=m.project_id AND r.message_id=m.id AND NOT r.tombstone
          JOIN project_chat_rooms room ON room.project_id=m.project_id AND room.id=m.room_id
          WHERE m.project_id=$1 AND room.visibility='PUBLIC' AND m.status='done' AND length(btrim(m.content))>0 AND ($4::uuid IS NULL OR m.room_id=$4)
          AND (SELECT count(*) FROM chat_search_vectors v WHERE v.project_id=m.project_id AND v.message_id=m.id AND v.revision=r.revision AND v.model_id=$2 AND v.model_pin=$3)<ceil(char_length(m.content)::numeric/${CHAT_SEARCH_CHUNK})
          ORDER BY m.position LIMIT 1`,[row.project_id,row.model_id,row.model_pin,roomId??null])).rows[0];
        if(!source)return;
        const existing=new Set((await db.query<{chunk_index:number}>('SELECT chunk_index FROM chat_search_vectors WHERE project_id=$1 AND message_id=$2 AND revision=$3 AND model_id=$4 AND model_pin=$5',[row.project_id,source.id,source.revision,row.model_id,row.model_pin])).rows.map(item=>item.chunk_index));
        const count=Math.ceil(Array.from(source.content).length/CHAT_SEARCH_CHUNK),chunks:number[]=[];
        for(let i=0;i<count&&chunks.length<limit;i++)if(!existing.has(i))chunks.push(i);
        return {...source,chunks};
    }
    async sourceCurrent(db:Db,row:ChatSearchJobRow,source:ChatSearchSource):Promise<boolean>{
        return !!(await db.query(`SELECT m.id FROM project_chat_messages m JOIN chat_search_revisions r ON r.project_id=m.project_id AND r.message_id=m.id
          JOIN project_chat_rooms room ON room.project_id=m.project_id AND room.id=m.room_id WHERE m.project_id=$1 AND m.id=$2 AND r.revision=$3 AND NOT r.tombstone AND room.visibility='PUBLIC' AND m.status='done' FOR SHARE OF m,r,room`,[row.project_id,source.id,source.revision])).rowCount;
    }
    async saveVectors(db:Db,row:ChatSearchJobRow,source:ChatSearchSource,vectors:number[][]):Promise<number>{
        if(!await this.sourceCurrent(db,row,source))return 0;
        for(let i=0;i<vectors.length;i++)await db.query(`INSERT INTO chat_search_vectors(project_id,message_id,revision,model_id,model_pin,dimension,chunk_index,embedding)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(project_id,message_id,model_id,model_pin,chunk_index) DO UPDATE SET revision=excluded.revision,embedding=excluded.embedding,indexed_at=now()`,
        [row.project_id,source.id,source.revision,row.model_id,row.model_pin,row.dimension,source.chunks[i],vectors[i]]);
        return vectors.length;
    }
    async count(db:Db,row:ChatSearchJobRow,roomId?:string):Promise<number>{return Number((await db.query<{count:string}>(`SELECT count(*) AS count FROM chat_search_vectors v ${live} AND ($4::uuid IS NULL OR m.room_id=$4)`,[row.project_id,row.model_id,row.model_pin,roomId??null])).rows[0].count);}
    async page(db:Db,row:ChatSearchJobRow,roomId:string|undefined,cursor:{id:string;chunk:number}|undefined,limit:number){
        return (await db.query<{message_id:string;revision:string;chunk_index:number;embedding:number[]}>(`SELECT v.message_id,v.revision::text,v.chunk_index,v.embedding FROM chat_search_vectors v ${live}
          AND v.dimension=$7 AND ($4::uuid IS NULL OR m.room_id=$4) AND ($5::uuid IS NULL OR (v.message_id,v.chunk_index)>($5,$6)) ORDER BY v.message_id,v.chunk_index LIMIT $8`,
        [row.project_id,row.model_id,row.model_pin,roomId??null,cursor?.id??null,cursor?.chunk??0,row.dimension,limit])).rows;
    }
    async hydrate(db:Db,row:ChatSearchJobRow,hits:ChatSearchStoredHit[]):Promise<ChatSearchHit[]>{
        if(!hits.length)return [];
        return (await db.query<ChatSearchHit>(`SELECT m.id AS "messageId",m.room_id AS "roomId",room.title AS "roomTitle",r.revision::text AS revision,h.chunk AS chunk,h.score,
          substring(m.content FROM h.chunk*${CHAT_SEARCH_CHUNK}+1 FOR ${CHAT_SEARCH_CHUNK}) AS content,m.position::text,m.author_name AS "authorName"
          FROM jsonb_to_recordset($4::jsonb) AS h("messageId" uuid,revision bigint,chunk integer,score double precision)
          JOIN chat_search_vectors v ON v.message_id=h."messageId" AND v.revision=h.revision AND v.chunk_index=h.chunk ${live}
          ORDER BY h.score DESC,m.position DESC`,[row.project_id,row.model_id,row.model_pin,JSON.stringify(hits)])).rows;
    }
}
