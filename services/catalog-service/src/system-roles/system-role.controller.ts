import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { SystemRoleService } from './system-role.service';

/** Read/history/cancel/rollback remain available when new role execution is disabled. */
@Controller('api/system-roles')
export class SystemRoleController {
    constructor(private readonly roles: SystemRoleService) {}
    @Get() overview(@Req() req: Request, @Query('projectId') project?: string) {
        return this.roles.overview(req, project);
    }
    @Post(':agentId/prepare') prepare(@Req() req: Request, @Param('agentId') agent: string, @Body() body: unknown) {
        return this.roles.prepare(req, agent, body);
    }
    @Post(':agentId/runs') start(@Req() req: Request, @Param('agentId') agent: string, @Body() body: unknown) {
        return this.roles.start(req, agent, body);
    }
    @Get(':agentId/runs') list(
        @Req() req: Request,
        @Param('agentId') agent: string,
        @Query('projectId') project?: string,
    ) {
        return this.roles.list(req, agent, project);
    }
    @Get(':agentId/runs/:runId') detail(
        @Req() req: Request,
        @Param('agentId') agent: string,
        @Param('runId') run: string,
    ) {
        return this.roles.detail(req, agent, run);
    }
    @Get(':agentId/requests/:requestId') request(
        @Req() req: Request,
        @Param('agentId') agent: string,
        @Param('requestId') id: string,
    ) {
        return this.roles.request(req, agent, id);
    }
    @Post(':agentId/runs/:runId/cancel') cancel(
        @Req() req: Request,
        @Param('agentId') agent: string,
        @Param('runId') run: string,
        @Body() body: unknown,
    ) {
        return this.roles.cancel(req, agent, run, body);
    }
    @Post(':agentId/runs/:runId/apply') apply(
        @Req() req: Request,
        @Param('agentId') agent: string,
        @Param('runId') run: string,
        @Body() body: unknown,
    ) {
        return this.roles.apply(req, agent, run, body);
    }
    @Post(':agentId/runs/:runId/rollback') rollback(
        @Req() req: Request,
        @Param('agentId') agent: string,
        @Param('runId') run: string,
        @Body() body: unknown,
    ) {
        return this.roles.apply(req, agent, run, body, true);
    }
}
