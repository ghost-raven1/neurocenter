import {ConflictException,Injectable,type OnModuleInit} from '@nestjs/common';
import type {Request} from 'express';
import {ModelsService} from './models.service';
import {ProjectEmbeddingRepository} from './project-embedding.repository';
import {projectEmbeddingUpdate} from './project-embedding.validation';
import type {IConfiguredProjectEmbedding,IProjectEmbeddingSelection} from './project-embedding.types';
import {ProjectRagCoordinator} from './project-rag-coordinator';

/** Внутренние callers сначала проверяют права проекта; сервис не зависит от устройств и очереди. */
@Injectable()
export class ProjectEmbeddingService implements OnModuleInit {
    private readonly repository:ProjectEmbeddingRepository;
    constructor(private readonly models:ModelsService,private readonly coordinator:ProjectRagCoordinator){this.repository=new ProjectEmbeddingRepository(models.pool);}
    private initialization?:Promise<void>;
    ready():Promise<void>{return this.initialization??=(async()=>{await this.models.ready();await this.repository.setup();})();}
    async onModuleInit():Promise<void>{await this.ready();}
    read(projectId:string):Promise<IProjectEmbeddingSelection>{return this.repository.read(projectId);}
    async get(request:Request,id:string):Promise<IProjectEmbeddingSelection>{
        const project=await this.models.resolveProject(request,id,1);return this.read(project.id);
    }
    async update(request:Request,id:string,input:unknown):Promise<IProjectEmbeddingSelection>{
        const body=projectEmbeddingUpdate(input);const actor=await this.models.actor(request);
        const project=await this.models.resolveProject(request,id,3,actor);
        if(body.modelId!==null)throw new ConflictException('Выбор модели выполняется через план переиндексации. Действующий индекс не меняется прямым PATCH.');
        return this.repository.clear(project.id,body.expectedRevision,actor.email,async db=>{
            await this.models.resolveProject(request,project.id,3);await this.coordinator.requireIdle(db,project.id);
        });
    }
    /** Возврат старого контекста не перенаправляет запрос после CAS-смены модели или снятия назначения. */
    async requireCurrent(projectId:string,expectedRevision?:number,expectedModelPin?:string):Promise<IConfiguredProjectEmbedding>{
        const selection=await this.read(projectId);
        if(selection.blocker||!selection.model||!selection.modelPin||!selection.profile)throw new ConflictException(selection.blocker||'Embedding-модель проекта не настроена.');
        if(expectedRevision!==undefined&&selection.revision!==expectedRevision||expectedModelPin!==undefined&&selection.modelPin!==expectedModelPin){
            throw new ConflictException('Выбор embedding-модели изменился. Перечитайте подключение; прежний индекс не перестраивается автоматически.');
        }
        return selection as IConfiguredProjectEmbedding;
    }
}
