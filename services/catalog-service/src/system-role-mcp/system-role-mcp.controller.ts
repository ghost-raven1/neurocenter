import { Body, Controller, Get, Header, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { assertInternal } from '../access/access.controller';
import { roleRequestId } from '../system-roles/system-role.validation';
import { SystemRoleMcpService } from './system-role-mcp.service';

/** Public requests contain pins only; server and device execution contexts stay on authenticated private channels. */
@Controller()
export class SystemRoleMcpController {
    constructor(private readonly mcp: SystemRoleMcpService) {}
    private internal(req: Request): void { assertInternal(req.headers['x-neurocenter-internal']); }
    private token(req: Request): string { this.internal(req); return String(req.headers.authorization ?? '').replace(/^Bearer /, ''); }
    @Get('api/system-role-mcp') @Header('Cache-Control', 'no-store') list(@Req() req: Request, @Query('projectId') project?: string) { return this.mcp.list(req, project); }
    @Post('api/system-role-mcp/discover') discover(@Req() req: Request, @Body() body: unknown) { return this.mcp.discover(req, body); }
    @Get('api/system-role-mcp/discoveries/:id') @Header('Cache-Control', 'no-store') discovery(@Req() req: Request, @Param('id') id: string) { return this.mcp.discovery(req, id); }
    @Get('api/system-role-mcp/runs/:id/calls') @Header('Cache-Control', 'no-store') calls(@Req() req: Request, @Param('id') id: string) { return this.mcp.calls(req, id); }
    @Post('internal/system-role-mcp/context') context(@Req() req: Request, @Body() body: { callId: string }) { this.internal(req); return this.mcp.context(roleRequestId(body?.callId)); }
    @Post('internal/system-role-mcp/dispatch') dispatch(@Req() req: Request, @Body() body: unknown) { this.internal(req); return this.mcp.serverDispatch(body); }
    @Post('internal/system-role-mcp/result') result(@Req() req: Request, @Body() body: unknown) { this.internal(req); return this.mcp.serverResult(body); }
    @Post('internal/device-channel/system-role-mcp/claim') claim(@Req() req: Request, @Body() body: unknown) { return this.mcp.channel.claim(this.token(req), body); }
    @Post('internal/device-channel/system-role-mcp/authorize') authorizeDevice(@Req() req: Request, @Body() body: unknown) { return this.mcp.channel.authorize(this.token(req), body); }
    @Post('internal/device-channel/system-role-mcp/context') deviceContext(@Req() req: Request, @Body() body: unknown) { return this.mcp.channel.context(this.token(req), body); }
    @Post('internal/device-channel/system-role-mcp/next') next(@Req() req: Request, @Body() body: unknown) { return this.mcp.channel.next(this.token(req), body); }
    @Post('internal/device-channel/system-role-mcp/dispatch') deviceDispatch(@Req() req: Request, @Body() body: unknown) { return this.mcp.channel.dispatch(this.token(req), body); }
    @Post('internal/device-channel/system-role-mcp/result') deviceResult(@Req() req: Request, @Body() body: unknown) { return this.mcp.channel.result(this.token(req), body); }
    @Post('internal/device-channel/system-role-mcp/complete') complete(@Req() req: Request, @Body() body: unknown) { return this.mcp.channel.complete(this.token(req), body); }
}
