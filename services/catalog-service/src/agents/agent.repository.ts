import {ConflictException,NotFoundException} from '@nestjs/common';
import {randomUUID,createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {IAccessActor} from '../access/access.model';
import {securityEvent} from '../access/security-events';
import {agentMutation} from './agent-mutation';
import {agentId,agentCard,agentManifest,agentNativeHash,normalizeCard,object,revision} from './agent-validation';
import type {AgentCard,AgentHeadRow} from './agent.types';
type Db=Pick<PoolClient,'query'>;
export const agentSummary=(card:AgentCard)=>({id:card.id,name:card.name,slug:card.slug,version:card.version,manifest:card.manifest,
    promptSha256:createHash('sha256').update(card.definition.prompt).digest('hex'),archived:!!card.archivedAt});
/** Heads are editable; every referenced template version remains immutable. */
export class AgentRepository {
    constructor(readonly pool:Pool){}
    async list(ids?:string[]):Promise<AgentCard[]>{
        return (await this.pool.query<AgentHeadRow>('SELECT * FROM agent_catalog'+(ids?' WHERE id=ANY($1::text[])':'')+' ORDER BY archived_at NULLS FIRST,name,id',ids?[ids]:[])).rows.map(agentCard);
    }
    /** Archive metadata may change independently; prompt bytes still come from the exact project pin. */
    async withArchiveState(cards:AgentCard[]):Promise<AgentCard[]>{
        const heads=(await this.pool.query<{id:string;archived_at:Date|null}>('SELECT id,archived_at FROM agent_catalog WHERE id=ANY($1::text[])',[cards.map(card=>card.id)])).rows;
        const states=new Map(heads.map(row=>[row.id,row.archived_at?.toISOString()??null]));
        return cards.map(card=>({...card,archivedAt:states.get(card.id)??null}));
    }
    async assigned(projectIds:string[]):Promise<AgentCard[]>{
        return (await this.pool.query<AgentHeadRow>(`SELECT DISTINCT ON(v.agent_id) v.agent_id AS id,v.slug,v.name,v.definition,v.version,v.manifest,
            h.archived_at,v.created_at,v.created_at AS updated_at FROM project_agents a
            JOIN agent_catalog_versions v ON v.agent_id=a.agent_id AND v.version=a.version AND v.manifest=a.manifest
            JOIN agent_catalog h ON h.id=v.agent_id WHERE NOT a.removed AND a.project_id=ANY($1::text[]) ORDER BY v.agent_id,v.version DESC`,[projectIds])).rows.map(agentCard);
    }
    async get(id:string,db:Db=this.pool):Promise<AgentCard>{agentId(id);const row=(await db.query<AgentHeadRow>('SELECT * FROM agent_catalog WHERE id=$1',[id])).rows[0];if(!row)throw new NotFoundException('Агент отсутствует в каталоге.');return agentCard(row);}
    async pinned(id:string,version:number,manifest:string,db:Db=this.pool):Promise<AgentCard>{
        const row=(await db.query<AgentHeadRow>(`SELECT v.agent_id AS id,v.slug,v.name,v.definition,v.version,v.manifest,NULL::timestamptz AS archived_at,v.created_at,v.created_at AS updated_at
            FROM agent_catalog_versions v WHERE v.agent_id=$1 AND v.version=$2 AND v.manifest=$3`,[id,version,manifest])).rows[0];
        if(!row)throw new ConflictException('Закреплённая версия агента отсутствует или имеет другой SHA.');
        const card=agentCard(row);if(agentManifest(card)!==card.manifest)throw new ConflictException('Неизменяемая версия агента повреждена.');return card;
    }
    create(actor:IAccessActor,raw:unknown):Promise<AgentCard>{
        const {requestKey,...fields}=object(raw,['requestKey','slug','name','description','definition']),input=normalizeCard(fields);
        return agentMutation(this.pool,actor,requestKey,'agent.create',input,undefined,async db=>{
            const card=await this.write(db,'agent-'+randomUUID(),input,1);
            await securityEvent(db,{actor:actor.email,action:'agent.create',resourceId:card.id,before:null,after:agentSummary(card)});return card;
        });
    }
    update(actor:IAccessActor,id:string,raw:unknown):Promise<AgentCard>{
        agentId(id);const {requestKey,expectedVersion,...changes}=object(raw,['requestKey','expectedVersion','slug','name','description','definition']);revision(expectedVersion);
        return agentMutation(this.pool,actor,requestKey,'agent.update',{id,expectedVersion,changes},undefined,async db=>{
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-management:agent:'+id]);
            const before=await this.get(id,db);if(before.version!==expectedVersion||before.archivedAt)throw new ConflictException('Версия агента изменилась или карточка находится в архиве.');
            const input=normalizeCard({slug:before.slug,name:before.name,definition:changes.definition??{...before.definition,...(changes.description!==undefined?{description:changes.description}:{})},...changes});
            if(agentManifest({id,...input,version:before.version})===before.manifest)return before;
            const maximum=Number((await db.query<{v:number}>('SELECT max(version) AS v FROM agent_catalog_versions WHERE agent_id=$1',[id])).rows[0].v);
            const card=await this.write(db,id,input,maximum+1);
            await securityEvent(db,{actor:actor.email,action:'agent.update',resourceId:id,before:agentSummary(before),after:agentSummary(card)});return card;
        });
    }
    /** Source import uses its caller's transaction and exact planned native version. */
    async write(db:Db,id:string,input:ReturnType<typeof normalizeCard>,version:number,{snapshot=false}:{snapshot?:boolean}={}):Promise<AgentCard>{
        const manifest=agentManifest({id,...input,version});
        const values=[id,input.slug,input.name,JSON.stringify(input.definition),version,manifest];
        const row=snapshot?undefined:(await db.query<AgentHeadRow>(`INSERT INTO agent_catalog(id,slug,name,definition,version,manifest) VALUES($1,$2,$3,$4::jsonb,$5,$6)
            ON CONFLICT(id) DO UPDATE SET slug=EXCLUDED.slug,name=EXCLUDED.name,definition=EXCLUDED.definition,version=EXCLUDED.version,manifest=EXCLUDED.manifest,updated_at=now() RETURNING *`,values)).rows[0];
        const old=(await db.query<{manifest:string}>('SELECT manifest FROM agent_catalog_versions WHERE agent_id=$1 AND version=$2',[id,version])).rows[0];
        if(old&&old.manifest!==manifest)throw new ConflictException('Номер версии агента уже закреплён за другим содержимым.');
        if(!old)await db.query('INSERT INTO agent_catalog_versions(agent_id,slug,name,definition,version,manifest) VALUES($1,$2,$3,$4::jsonb,$5,$6)',values);
        return row?agentCard(row):this.pinned(id,version,manifest,db);
    }
    /** Archive policy changes desired project state; only bridge acknowledgements confirm local removal. */
    async archive(db:Db,id:string,expectedHash:string,{restore=false,removeProjectRefs=false}:{restore?:boolean;removeProjectRefs?:boolean}={}):Promise<AgentCard>{
        const before=await this.get(id,db);if(agentNativeHash(before)!==expectedHash)throw new ConflictException('Карточка агента изменилась после проверки последствий.');
        if(restore?!before.archivedAt:!!before.archivedAt)throw new ConflictException('Состояние архива агента уже изменилось.');
        if(removeProjectRefs){
            const sets=(await db.query<{project_id:string}>(`SELECT s.project_id FROM project_agent_sets s WHERE EXISTS(SELECT 1 FROM project_agents a WHERE a.project_id=s.project_id AND a.agent_id=$1 AND NOT a.removed) ORDER BY s.project_id FOR UPDATE`,[id])).rows;
            await db.query('UPDATE project_agents SET removed=true,enabled=false,updated_at=now() WHERE agent_id=$1 AND NOT removed',[id]);
            for(const row of sets)await db.query('UPDATE project_agent_sets SET revision=revision+1,updated_at=now() WHERE project_id=$1',[row.project_id]);
        }
        const row=(await db.query<AgentHeadRow>('UPDATE agent_catalog SET archived_at=CASE WHEN $2 THEN NULL ELSE now() END,updated_at=now() WHERE id=$1 RETURNING *',[id,restore])).rows[0];return agentCard(row);
    }
}
