import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AgentsService } from './agents.service';
/** Prompt editing and delivery stay separate so desired settings never masquerade as local success. */
@Controller('api')
export class AgentsController {
    constructor(private readonly agents: AgentsService) {}
    @Get('agents') list(@Req() req: Request, @Query('projectId') projectId?: string) {
        return this.agents.list(req, projectId);
    }
    @Get('agents/:id') get(@Req() req: Request, @Param('id') id: string) {
        return this.agents.get(req, id);
    }
    @Post('agents') create(@Req() req: Request, @Body() body: unknown) {
        return this.agents.create(req, body);
    }
    @Patch('agents/:id') update(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
        return this.agents.update(req, id, body);
    }
    @Post('projects/:id/agents') assign(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
        return this.agents.assign(req, id, body);
    }
    @Patch('projects/:id/agents/:agentId') configure(
        @Req() req: Request,
        @Param('id') id: string,
        @Param('agentId') agentId: string,
        @Body() body: unknown,
    ) {
        return this.agents.configure(req, id, agentId, body);
    }
    @Delete('projects/:id/agents/:agentId') remove(
        @Req() req: Request,
        @Param('id') id: string,
        @Param('agentId') agentId: string,
        @Body() body: unknown,
    ) {
        return this.agents.remove(req, id, agentId, body);
    }
    @Post('projects/:id/agents/connect') connect(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
        return this.agents.connect(req, id, body);
    }
}
