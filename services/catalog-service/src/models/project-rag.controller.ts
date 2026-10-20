import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { assertInternal } from '../access/access.controller';
import { ProjectRagCoordinator } from './project-rag-coordinator';

@Controller('api/rag')
export class ProjectRagSyncController {
    constructor(private readonly coordinator:ProjectRagCoordinator){}
    @Post('sync') sync(@Req() req:Request,@Body() body:unknown){return this.coordinator.sync(req,body);}
}
@Controller('internal/project-rag')
export class ProjectRagContextController {
    constructor(private readonly coordinator:ProjectRagCoordinator){}
    @Get('context/:id') context(@Req() req:Request,@Param('id') id:string){assertInternal(req.headers['x-neurocenter-internal']);return this.coordinator.context(id);}
    @Post('write-authorize') authorize(@Req() req:Request,@Body() body:Parameters<ProjectRagCoordinator['authorizeWrite']>[0]){
        assertInternal(req.headers['x-neurocenter-internal']);return this.coordinator.authorizeWrite(body);
    }
}
