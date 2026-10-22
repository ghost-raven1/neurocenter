import { Body, Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AgentReadinessService } from './agent-readiness.service';

@Controller('api/projects/:projectId/agents')
export class AgentReadinessController {
    constructor(private readonly trials: AgentReadinessService) {}
    @Get('readiness') overview(@Req() req: Request, @Param('projectId') project: string) { return this.trials.overview(req, project); }
    @Post(':agentId/readiness-trials') @HttpCode(202)
    start(@Req() req: Request, @Param('projectId') project: string, @Param('agentId') agent: string, @Body() body: unknown) { return this.trials.start(req, project, agent, body); }
    @Get(':agentId/readiness-trials/:trialId')
    read(@Req() req: Request, @Param('projectId') project: string, @Param('agentId') agent: string, @Param('trialId') id: string) { return this.trials.read(req, project, agent, id); }
    @Post(':agentId/readiness-trials/:trialId/cancel')
    cancel(@Req() req: Request, @Param('projectId') project: string, @Param('agentId') agent: string, @Param('trialId') id: string, @Body() body: unknown) { return this.trials.cancel(req, project, agent, id, body); }
}
