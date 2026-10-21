import {BadRequestException,ConflictException,Injectable,OnApplicationShutdown,OnModuleInit} from '@nestjs/common';
import type {Request} from 'express';
import type {IAccessActor} from '../access/access.model';
import {projectLevel} from '../access/access.model';
import {ModelsService} from '../models/models.service';
import {createPool} from '../database/pool';
import {normalizeLearningExperienceInput,normalizeLearningObservedExperienceInput,normalizeLearningHypothesisInput,normalizeLearningCheckInput,normalizeLearningCandidateInput,
    normalizeLearningCandidateActionInput,normalizeLearningAnalysisInput,normalizeLearningAnalysisRecord} from '../../../shared/project-learning.cjs';
import type {LearningDeviceContext,LearningOverview} from '../../../shared/project-learning.cjs';
import {LearningRepository,type LearningDeviceAuthorization} from './learning.repository';
import {learningInput,learningUuid} from './learning-validation';
import {requireLearningHuman} from './learning-access';

/** Evidence and hypotheses remain project-local; only an explicit human decision activates context. */
@Injectable()
export class LearningService implements OnModuleInit,OnApplicationShutdown {
    readonly pool=createPool({connectionString:process.env.CATALOG_PG_URL||'postgresql://rag:rag@localhost:5432/catalog',max:5},'learning');
    readonly repository=new LearningRepository(this.pool);
    constructor(private readonly access:ModelsService){}
    async onModuleInit(){await this.access.ready();}
    async onApplicationShutdown(){await this.pool.end();}
    private async scope(req:Request,id:string,minimum=1){requireLearningHuman(req);const actor=await this.access.actor(req),project=await this.access.resolveProject(req,id,minimum,actor);return {actor,projectId:project.id};}
    async overview(req:Request,id:string):Promise<LearningOverview>{
        const {actor,projectId}=await this.scope(req,id),level=projectLevel(actor.claims,actor.activeRole,projectId),human=!req.headers.authorization&&!req.headers['x-neurocenter-device-id'];
        return this.repository.read(actor,projectId,async db=>{
            const experiences=await this.repository.page(db,projectId,'experiences'),hypotheses=await this.repository.page(db,projectId,'hypotheses'),candidates=await this.repository.page(db,projectId,'candidates');
            const info=(page:{nextCursor:string|null;total:number})=>({nextCursor:page.nextCursor,total:page.total});
            return {schemaVersion:1,projectId,revision:await this.repository.revision(projectId,db),experiences:experiences.items,hypotheses:hypotheses.items,candidates:candidates.items,
                activeCandidates:await this.repository.activeCandidates(db,projectId),pages:{experiences:info(experiences),hypotheses:info(hypotheses),candidates:info(candidates)},
                history:await this.repository.history(db,projectId),capabilities:{read:true,record:level>=2,review:human&&level>=2,approve:human&&level>=3}};
        });
    }
    async page(req:Request,id:string,collection:'experiences'|'hypotheses'|'candidates',before?:string){
        if(before!==undefined)learningUuid(before);const {actor,projectId}=await this.scope(req,id);return this.repository.read(actor,projectId,db=>this.repository.page(db,projectId,collection,before));
    }
    async detail(req:Request,id:string,collection:'experiences'|'hypotheses'|'candidates',recordId:string){
        learningUuid(recordId);const {actor,projectId}=await this.scope(req,id);return this.repository.read(actor,projectId,db=>this.repository.detail(db,projectId,collection,recordId));
    }
    async checks(req:Request,id:string,hypothesisId:string,before?:string){
        learningUuid(hypothesisId);if(before!==undefined)learningUuid(before);const {actor,projectId}=await this.scope(req,id);return this.repository.read(actor,projectId,db=>this.repository.checkPage(db,projectId,hypothesisId,before));
    }
    async checkDetail(req:Request,id:string,hypothesisId:string,checkId:string){
        learningUuid(hypothesisId);learningUuid(checkId);const {actor,projectId}=await this.scope(req,id);return this.repository.read(actor,projectId,db=>this.repository.checkDetail(db,projectId,hypothesisId,checkId));
    }
    async context(req:Request,id:string){const {actor,projectId}=await this.scope(req,id);return this.repository.read(actor,projectId,db=>this.repository.context(db,projectId));}
    async history(req:Request,id:string,before?:string){
        const {actor,projectId}=await this.scope(req,id);let beforeRevision:number|undefined;
        if(before!==undefined){beforeRevision=Number(before);if(!Number.isSafeInteger(beforeRevision)||beforeRevision<1)throw new BadRequestException('Некорректная граница истории обучения.');}
        return this.repository.read(actor,projectId,db=>this.repository.history(db,projectId,beforeRevision));
    }
    async request(req:Request,id:string,key:string){learningUuid(key);const {actor,projectId}=await this.scope(req,id);return this.repository.read(actor,projectId,db=>this.repository.receipt(db,actor,projectId,key));}
    async recordExperience(req:Request,id:string,raw:unknown){
        requireLearningHuman(req);const input=learningInput(normalizeLearningExperienceInput,raw),{actor,projectId}=await this.scope(req,id,2);
        return this.repository.addExperience(actor,projectId,input,{origin:'human',device:null});
    }
    async proposeHypothesis(req:Request,id:string,raw:unknown){
        requireLearningHuman(req);const input=learningInput(normalizeLearningHypothesisInput,raw),{actor,projectId}=await this.scope(req,id,2);
        const {requestKey,expectedRevision,...draft}=input;return this.repository.addHypotheses(actor,projectId,{requestKey,expectedRevision,hypotheses:[draft]},{origin:'human',device:null});
    }
    async checkHypothesis(req:Request,id:string,hypothesisId:string,raw:unknown){
        requireLearningHuman(req);learningUuid(hypothesisId);const input=learningInput(normalizeLearningCheckInput,raw),{actor,projectId}=await this.scope(req,id,2);
        return this.repository.addCheck(actor,projectId,hypothesisId,input);
    }
    async proposeCandidate(req:Request,id:string,raw:unknown){
        requireLearningHuman(req);const input=learningInput(normalizeLearningCandidateInput,raw),{actor,projectId}=await this.scope(req,id,2);
        return this.repository.addCandidate(actor,projectId,input);
    }
    async candidateAction(req:Request,id:string,candidateId:string,raw:unknown,action:'approve'|'reject'|'revoke'|'activate'){
        requireLearningHuman(req);learningUuid(candidateId);const input=learningInput(normalizeLearningCandidateActionInput,raw),{actor,projectId}=await this.scope(req,id,3);
        return this.repository.candidateAction(actor,projectId,candidateId,input,action);
    }
    async deviceContext(actor:IAccessActor,projectId:string,authorizeDevice?:LearningDeviceAuthorization){
        return this.repository.read(actor,projectId,db=>this.repository.context(db,projectId),authorizeDevice);
    }
    async recordDeviceExperience(actor:IAccessActor,projectId:string,raw:unknown,device:LearningDeviceContext,authorizeDevice:LearningDeviceAuthorization){
        const input=learningInput(normalizeLearningExperienceInput,raw);return this.repository.addExperience(actor,projectId,input,{origin:'device',device},authorizeDevice);
    }
    async appendDeviceExperience(actor:IAccessActor,projectId:string,raw:unknown,device:LearningDeviceContext,authorizeDevice:LearningDeviceAuthorization){
        const input=learningInput(normalizeLearningObservedExperienceInput,raw);return this.repository.addExperience(actor,projectId,input,{origin:'device',device},authorizeDevice,true);
    }
    async proposeDeviceHypothesis(actor:IAccessActor,projectId:string,raw:unknown,device:LearningDeviceContext,authorizeDevice:LearningDeviceAuthorization){
        const input=learningInput(normalizeLearningHypothesisInput,raw),{requestKey,expectedRevision,...draft}=input;
        return this.repository.addHypotheses(actor,projectId,{requestKey,expectedRevision,hypotheses:[draft]},{origin:'device',device},authorizeDevice);
    }
    /** Analysis consumes an immutable, authorized evidence snapshot, never an inferred project name. */
    async analysisInput(req:Request,id:string,raw:unknown){
        requireLearningHuman(req);const input=learningInput(normalizeLearningAnalysisInput,raw),{actor,projectId}=await this.scope(req,id,2);
        return this.repository.read(actor,projectId,async db=>{
            const revision=await this.repository.revision(projectId,db);if(revision!==input.expectedRevision)throw new ConflictException('Опыт проекта изменился до начала анализа.');
            return {actor,projectId,revision,experiences:await this.repository.experiences(db,projectId,input.experienceIds)};
        });
    }
    /** Late model output may append only hypotheses; its original source revision remains provenance. */
    async recordAnalysis(req:Request,id:string,raw:unknown,authorize?:LearningDeviceAuthorization){
        requireLearningHuman(req);const normalized=learningInput(normalizeLearningAnalysisRecord,raw),input={...normalized,model:{...normalized.model,sourceRevision:normalized.expectedRevision}},
            {actor,projectId}=await this.scope(req,id,2);
        return this.repository.addHypotheses(actor,projectId,input,{origin:'llm',device:null},authorize,true);
    }
}
