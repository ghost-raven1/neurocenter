import {Injectable,OnApplicationShutdown,OnModuleInit,ForbiddenException} from '@nestjs/common';
import type {Request} from 'express';
import {canReadCommon,projectLevel} from '../access/access.model';
import {ModelsService} from '../models/models.service';
import {DeviceJobs} from '../devices/device-jobs';
import {createPool} from '../database/pool';
import {notifyModelCatalogChange} from '../models/model-events';
import {PROJECT_AGENTS_JOB} from '../../../shared/project-agents.cjs';
import {AgentRepository} from './agent.repository';
import {ProjectAgentRepository} from './project-agent.repository';
import {object,request,revision} from './agent-validation';
import type {AgentList} from './agent.types';
/** Native templates and project desired state share the existing trusted actor and project access boundary. */
@Injectable()
export class AgentsService implements OnModuleInit,OnApplicationShutdown {
    readonly pool=createPool({connectionString:process.env.CATALOG_PG_URL||'postgresql://rag:rag@localhost:5432/catalog',max:5},'agents');
    readonly cards=new AgentRepository(this.pool);readonly projects=new ProjectAgentRepository(this.pool);
    constructor(private readonly access:ModelsService,private readonly jobs:DeviceJobs){}
    async onModuleInit(){await this.access.ready();}async onApplicationShutdown(){await this.pool.end();}
    async list(req:Request,projectId?:string):Promise<AgentList>{
        const actor=await this.access.actor(req);
        if(projectId!==undefined){
            const project=await this.access.resolveProject(req,projectId,1,actor),view=await this.projects.view(project.id,actor.email);
            return {items:canReadCommon(actor.claims,actor.activeRole)?await this.cards.list():await this.cards.withArchiveState(view.assignments.filter(row=>!row.removed).map(row=>row.card)),...view};
        }
        const common=canReadCommon(actor.claims,actor.activeRole),projects=actor.claims.projects.filter(project=>projectLevel(actor.claims,actor.activeRole,project.projectId)>0).map(project=>project.projectId);
        return {items:common?await this.cards.list():await this.cards.assigned(projects),assignments:[],revision:null,deliveries:[]};
    }
    async get(req:Request,id:string){const allowed=await this.list(req);const card=allowed.items.find(row=>row.id===id);if(!card)throw new ForbiddenException('Агент не назначен доступному проекту.');return card;}
    async create(req:Request,raw:unknown){const actor=await this.access.actor(req),result=await this.cards.create(actor,raw);await notifyModelCatalogChange();return result;}
    async update(req:Request,id:string,raw:unknown){const actor=await this.access.actor(req),result=await this.cards.update(actor,id,raw);await notifyModelCatalogChange();return result;}
    private async project(req:Request,id:string){const actor=await this.access.actor(req),project=await this.access.resolveProject(req,id,3,actor);return {actor,project};}
    async assign(req:Request,id:string,raw:unknown){const {actor,project}=await this.project(req,id),result=await this.projects.assign(actor,project.id,raw);await notifyModelCatalogChange();return result;}
    async configure(req:Request,id:string,agentId:string,raw:unknown){const {actor,project}=await this.project(req,id),result=await this.projects.update(actor,project.id,agentId,raw);await notifyModelCatalogChange();return result;}
    async remove(req:Request,id:string,agentId:string,raw:unknown){const {actor,project}=await this.project(req,id),result=await this.projects.remove(actor,project.id,agentId,raw);await notifyModelCatalogChange();return result;}
    async connect(req:Request,id:string,raw:unknown){
        const {actor,project}=await this.project(req,id),input=object(raw,['requestKey','expectedRevision','deviceId','expectedBindingId','expectedInstanceId']);request(input.requestKey);revision(input.expectedRevision);
        const result=await this.jobs.create(actor,{kind:PROJECT_AGENTS_JOB,projectId:project.id,requestKey:input.requestKey,deviceId:input.deviceId as string,
            expectedAgentsRevision:input.expectedRevision,expectedBindingId:input.expectedBindingId as string,expectedInstanceId:input.expectedInstanceId as string});
        return {...result,desiredRevision:input.expectedRevision};
    }
}
