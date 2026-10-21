import {BadRequestException,ConflictException,NotFoundException} from '@nestjs/common';
import {isDeepStrictEqual} from 'node:util';
import type {Pool,PoolClient} from 'pg';
import {createProjectAgentsPayload,type ProjectAgent} from '../../../shared/project-agents.cjs';
import type {IAccessActor} from '../access/access.model';
import {securityEvent} from '../access/security-events';
import {AgentRepository,agentSummary} from './agent.repository';
import {agentMutation} from './agent-mutation';
import {agentId,agentManifest,effectiveDefinition,object,revision,sha} from './agent-validation';
import type {AgentAssignmentRow,ProjectAgentAssignment,AgentDelivery} from './agent.types';
type Db=Pick<PoolClient,'query'>;
/** A project revision fences the full snapshot while individual version pins remain immutable. */
export class ProjectAgentRepository {
    readonly cards:AgentRepository;
    constructor(readonly pool:Pool){this.cards=new AgentRepository(pool);}
    async currentRevision(projectId:string,db:Db=this.pool):Promise<number>{return Number((await db.query<{revision:number}>('SELECT revision FROM project_agent_sets WHERE project_id=$1',[projectId])).rows[0]?.revision??0);}
    async assignments(projectId:string,db:Db=this.pool):Promise<ProjectAgentAssignment[]>{
        const rows=(await db.query<AgentAssignmentRow>('SELECT * FROM project_agents WHERE project_id=$1 ORDER BY added_at,agent_id',[projectId])).rows;
        return Promise.all(rows.map(row=>this.assignment(row,db)));
    }
    private async assignment(row:AgentAssignmentRow,db:Db):Promise<ProjectAgentAssignment>{
        const card=await this.cards.pinned(row.agent_id,Number(row.version),row.manifest,db),config=effectiveDefinition(card.definition,row.overrides);
        return {agentId:row.agent_id,version:Number(row.version),manifest:row.manifest,overrides:config.overrides,enabled:row.enabled,removed:row.removed,card,effective:config.effective};
    }
    async snapshot(projectId:string,db:Db=this.pool):Promise<{revision:number;agents:ProjectAgent[]}>{
        const rows=(await db.query<{revision:number;items:Array<{id:string;slug:string;name:string;version:number;manifest:string;definition:ProjectAgentAssignment['effective'];overrides:ProjectAgentAssignment['overrides'];enabled:boolean}>}>(`SELECT s.revision,
            coalesce(jsonb_agg(jsonb_build_object('id',a.agent_id,'slug',v.slug,'name',v.name,'version',a.version,'manifest',a.manifest,'definition',v.definition,'overrides',a.overrides,'enabled',a.enabled) ORDER BY a.agent_id) FILTER(WHERE a.agent_id IS NOT NULL),'[]'::jsonb) AS items
            FROM project_agent_sets s LEFT JOIN project_agents a ON a.project_id=s.project_id AND NOT a.removed
            LEFT JOIN agent_catalog_versions v ON v.agent_id=a.agent_id AND v.version=a.version AND v.manifest=a.manifest
            WHERE s.project_id=$1 GROUP BY s.project_id,s.revision`,[projectId])).rows[0];
        return {revision:Number(rows?.revision??0),agents:(rows?.items??[]).map(row=>{
            if(agentManifest(row)!==row.manifest)throw new ConflictException('Закреплённый шаблон агента повреждён.');
            return {id:row.id,slug:row.slug,version:Number(row.version),enabled:row.enabled,...effectiveDefinition(row.definition,row.overrides).effective};
        })};
    }
    private async lock(db:Db,projectId:string,expected:number):Promise<void>{
        await db.query('INSERT INTO project_agent_sets(project_id) VALUES($1) ON CONFLICT DO NOTHING',[projectId]);
        const row=(await db.query<{revision:number}>('SELECT revision FROM project_agent_sets WHERE project_id=$1 FOR UPDATE',[projectId])).rows[0];
        if(Number(row?.revision)!==expected)throw new ConflictException('Настройки агентов проекта изменились. Обновите страницу перед сохранением.');
    }
    private async saved(db:Db,projectId:string,id:string):Promise<{revision:number;assignment:ProjectAgentAssignment}>{
        const next=(await db.query<{revision:number}>('UPDATE project_agent_sets SET revision=revision+1,updated_at=now() WHERE project_id=$1 RETURNING revision',[projectId])).rows[0].revision;
        const snapshot=await this.snapshot(projectId,db);
        try{createProjectAgentsPayload({schemaVersion:2,projectId,bindingId:'0'.repeat(64),instanceId:'00000000-0000-4000-8000-000000000000',revision:Number(next),agents:snapshot.agents});}
        catch{throw new BadRequestException('Проект допускает до 32 агентов с разными именами OpenCode и общий размер настроек до 2 МиБ.');}
        const row=(await db.query<AgentAssignmentRow>('SELECT * FROM project_agents WHERE project_id=$1 AND agent_id=$2',[projectId,id])).rows[0];
        return {revision:Number(next),assignment:await this.assignment(row,db)};
    }
    assign(actor:IAccessActor,projectId:string,raw:unknown){
        const input=object(raw,['requestKey','expectedRevision','agentId','version','manifest']);agentId(input.agentId);revision(input.expectedRevision);
        if(!Number.isSafeInteger(input.version)||Number(input.version)<1||!sha(input.manifest))throw new BadRequestException('Выберите конкретную версию агента и её SHA.');
        const id=input.agentId;
        return agentMutation(this.pool,actor,input.requestKey,'project.agent.assign',{projectId,...input},projectId,async db=>{
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-management:agent:'+id]);await this.lock(db,projectId,Number(input.expectedRevision));
            const head=await this.cards.get(id,db);if(head.archivedAt)throw new ConflictException('Агент в архиве и не добавляется в новые проекты.');
            const card=await this.cards.pinned(id,Number(input.version),String(input.manifest),db);
            const old=(await db.query<AgentAssignmentRow>('SELECT * FROM project_agents WHERE project_id=$1 AND agent_id=$2',[projectId,id])).rows[0];
            if(old&&!old.removed)throw new ConflictException('Агент уже добавлен в проект. Измените существующие настройки.');
            await db.query(`INSERT INTO project_agents(project_id,agent_id,version,manifest,added_by,updated_by) VALUES($1,$2,$3,$4,$5,$5)
                ON CONFLICT(project_id,agent_id) DO UPDATE SET version=EXCLUDED.version,manifest=EXCLUDED.manifest,enabled=false,removed=false,updated_by=EXCLUDED.updated_by,updated_at=now()`,[projectId,id,input.version,input.manifest,actor.email]);
            const result=await this.saved(db,projectId,id);
            await securityEvent(db,{actor:actor.email,action:'project.agent.assign',resourceId:id,before:null,after:{...agentSummary(card),projectId,revision:result.revision,enabled:false,removed:false}});return result;
        });
    }
    update(actor:IAccessActor,projectId:string,id:string,raw:unknown){
        agentId(id);const input=object(raw,['requestKey','expectedRevision','version','manifest','overrides','enabled']);revision(input.expectedRevision);
        if(input.enabled!==undefined&&typeof input.enabled!=='boolean')throw new BadRequestException('Передайте состояние включения агента.');
        if((input.version===undefined)!==(input.manifest===undefined)||input.version!==undefined&&(!Number.isSafeInteger(input.version)||Number(input.version)<1||!sha(input.manifest)))throw new BadRequestException('Новая версия требует её точный SHA.');
        return agentMutation(this.pool,actor,input.requestKey,'project.agent.update',{projectId,id,...input},projectId,async db=>{
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-management:agent:'+id]);await this.lock(db,projectId,Number(input.expectedRevision));
            const before=(await db.query<AgentAssignmentRow>('SELECT * FROM project_agents WHERE project_id=$1 AND agent_id=$2',[projectId,id])).rows[0];
            if(!before||before.removed)throw new NotFoundException('Агент не добавлен в проект.');
            const version=Number(input.version??before.version),manifest=String(input.manifest??before.manifest);
            if(input.version!==undefined&&(await this.cards.get(id,db)).archivedAt)throw new ConflictException('Новая версия архивного агента не назначается. Сначала восстановите карточку.');
            const previousCard=await this.cards.pinned(id,Number(before.version),before.manifest,db),previousConfig=effectiveDefinition(previousCard.definition,before.overrides);
            const card=await this.cards.pinned(id,version,manifest,db),config=effectiveDefinition(card.definition,input.overrides===undefined?before.overrides:input.overrides);
            if(version===Number(before.version)&&manifest===before.manifest&&isDeepStrictEqual(config.overrides,before.overrides)&&(input.enabled??before.enabled)===before.enabled)return {revision:Number(input.expectedRevision),assignment:await this.assignment(before,db)};
            await db.query('UPDATE project_agents SET version=$3,manifest=$4,overrides=$5::jsonb,enabled=$6,updated_by=$7,updated_at=now() WHERE project_id=$1 AND agent_id=$2',
                [projectId,id,version,manifest,JSON.stringify(config.overrides),input.enabled??before.enabled,actor.email]);
            const result=await this.saved(db,projectId,id);
            await securityEvent(db,{actor:actor.email,action:'project.agent.update',resourceId:id,before:{...agentSummary({...previousCard,definition:previousConfig.effective}),projectId,revision:input.expectedRevision,enabled:before.enabled,removed:false,overridden:Object.keys(previousConfig.overrides).length>0},
                after:{...agentSummary({...card,definition:config.effective}),projectId,revision:result.revision,enabled:result.assignment.enabled,removed:false,overridden:Object.keys(config.overrides).length>0}});return result;
        });
    }
    remove(actor:IAccessActor,projectId:string,id:string,raw:unknown){
        agentId(id);const input=object(raw,['requestKey','expectedRevision']);revision(input.expectedRevision);
        return agentMutation(this.pool,actor,input.requestKey,'project.agent.remove',{projectId,id,...input},projectId,async db=>{
            await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',['asset-management:agent:'+id]);await this.lock(db,projectId,Number(input.expectedRevision));
            const before=(await db.query<AgentAssignmentRow>('SELECT * FROM project_agents WHERE project_id=$1 AND agent_id=$2',[projectId,id])).rows[0];
            if(!before)throw new NotFoundException('Агент не добавлен в проект.');
            if(before.removed)return {revision:Number(input.expectedRevision),assignment:await this.assignment(before,db)};
            await db.query('UPDATE project_agents SET enabled=false,removed=true,updated_by=$3,updated_at=now() WHERE project_id=$1 AND agent_id=$2',[projectId,id,actor.email]);
            const result=await this.saved(db,projectId,id);
            await securityEvent(db,{actor:actor.email,action:'project.agent.remove',resourceId:id,before:{projectId,version:before.version,enabled:before.enabled},after:{...agentSummary(result.assignment.card),projectId,revision:result.revision,enabled:false,removed:true}});return result;
        });
    }
    async deliveries(projectId:string,email:string,db:Db=this.pool):Promise<AgentDelivery[]>{
        return (await db.query<AgentDelivery>(`SELECT DISTINCT ON(device_id,payload->>'bindingId',payload->>'instanceId')
            device_id AS "deviceId",payload->>'bindingId' AS "bindingId",payload->>'instanceId' AS "instanceId",id AS "jobId",state,
            (payload->>'revision')::int AS revision,payload->>'manifestSha256' AS "manifestSha256",message,created_at AS "createdAt",updated_at AS "updatedAt",result
            FROM bridge_jobs WHERE project_id=$1 AND email=$2 AND kind='configure-project-agents'
            ORDER BY device_id,payload->>'bindingId',payload->>'instanceId',created_at DESC,id DESC`,[projectId,email])).rows.map(row=>({...row,createdAt:new Date(row.createdAt).toISOString(),updatedAt:new Date(row.updatedAt).toISOString()}));
    }
    async view(projectId:string,email:string){
        const db=await this.pool.connect();try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
            const result={revision:await this.currentRevision(projectId,db),assignments:await this.assignments(projectId,db),deliveries:await this.deliveries(projectId,email,db)};
            await db.query('COMMIT');return result;
        }catch(error){await db.query('ROLLBACK').catch(()=>undefined);throw error;}finally{db.release();}
    }
}
