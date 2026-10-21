import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { RagService } from './rag.service';
import { ProjectDatabases } from './project-databases';
import {requireRagFeatures} from './rag-features';

/** Internal token проверяет middleware; публичного обходного writer больше нет. */
@Controller('internal/project-rag')
export class ProjectRagController {
    constructor(private readonly rag:RagService,private readonly databases:ProjectDatabases){}
    @Post('search') search(@Body() body:unknown){return this.rag.search(body);}
    @Post('write') write(@Body() body:Parameters<RagService['applyDelta']>[0]){return this.rag.applyDelta(body);}
    @Post('source') source(@Body() body:{projectId:string;generation:string}){
        return this.databases.withProject(body.projectId,async(db,id)=>({...await db.generations.source(id,body.generation),availableBytes:(await db.quota(id)).availableBytes}));
    }
    @Post('generations') async create(@Body() body:{projectId:string;id:string;sourceGeneration:string;profile:unknown;sourceSnapshot:string}){
        await requireRagFeatures(['rag_sync']);
        return this.databases.withProject(body.projectId,(db,id)=>db.generations.create(id,body.id,body.sourceGeneration,body.profile,body.sourceSnapshot));
    }
    @Get('generations/:id') get(@Param('id') generation:string,@Query('projectId') projectId:string){
        return this.databases.withProject(projectId,(db,id)=>db.generations.get(id,generation));
    }
    @Post('generations/:id/build') async build(@Param('id') generation:string,@Body() body:{projectId:string}){
        await requireRagFeatures(['rag_sync']);
        void this.rag.buildGeneration(body.projectId,generation).catch(()=>undefined);
        return this.databases.withProject(body.projectId,(db,id)=>db.generations.get(id,generation));
    }
    @Post('generations/:id/cancel') cancel(@Param('id') generation:string,@Body() body:{projectId:string;profile:unknown;sourceGeneration:string;sourceSnapshot:string|null}){
        return this.databases.withProject(body.projectId,(db,id)=>db.generations.cancel(id,generation,body));
    }
    @Post('generations/:id/retry') async retry(@Param('id') generation:string,@Body() body:{projectId:string}){
        await requireRagFeatures(['rag_sync']);
        return this.databases.withProject(body.projectId,(db,id)=>db.generations.retry(id,generation));
    }
}
