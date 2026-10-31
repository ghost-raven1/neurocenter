import { Body, Controller, Get, Param, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { assertInternal } from '../access/access.controller';
import { ProjectReindexService } from './project-reindex.service';

@Controller('api/projects/:projectId/embedding/reindex')
export class ProjectReindexController {
    constructor(private readonly service: ProjectReindexService) {}
    @Get() async latest(
        @Req() req: Request,
        @Param('projectId') project: string,
        @Res() response: Response,
    ): Promise<void> {
        response.json(await this.service.latest(req, project));
    }
    @Post() create(@Req() req: Request, @Param('projectId') project: string, @Body() body: unknown) {
        return this.service.create(req, project, body);
    }
    @Get(':id') get(@Req() req: Request, @Param('projectId') project: string, @Param('id') id: string) {
        return this.service.get(req, project, id);
    }
    @Post(':id/start') start(
        @Req() req: Request,
        @Param('projectId') project: string,
        @Param('id') id: string,
        @Body() body: unknown,
    ) {
        return this.service.start(req, project, id, body);
    }
    @Post(':id/local-retry') retryLocal(
        @Req() req: Request,
        @Param('projectId') project: string,
        @Param('id') id: string,
    ) {
        return this.service.retryLocal(req, project, id);
    }
    @Post(':id/retry') retry(@Req() req: Request, @Param('projectId') project: string, @Param('id') id: string) {
        return this.service.retry(req, project, id);
    }
    @Post(':id/cancel') cancel(@Req() req: Request, @Param('projectId') project: string, @Param('id') id: string) {
        return this.service.cancel(req, project, id);
    }
}
@Controller('internal/project-rag')
export class ProjectReindexInferenceController {
    constructor(private readonly service: ProjectReindexService) {}
    @Post('reindex-embedding') embed(@Req() req: Request, @Body() body: Parameters<ProjectReindexService['embed']>[0]) {
        assertInternal(req.headers['x-neurocenter-internal']);
        return this.service.embed(body);
    }
}
