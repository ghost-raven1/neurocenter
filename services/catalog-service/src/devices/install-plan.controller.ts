import { Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { assertInternal } from '../access/access.controller';
import type { IAccessActor } from '../access/access.model';
import { InstallPlans } from './install-plans';
import type { InstallPlanInput } from './install-plan.model';

@Controller('api/device-install-plans')
export class InstallPlanController {
    constructor(private readonly plans: InstallPlans) {}
    private actor(req: Request): IAccessActor {
        assertInternal(req.headers['x-neurocenter-internal']);
        return JSON.parse(decodeURIComponent(String(req.headers['x-bridge-actor'] || 'null'))) as IAccessActor;
    }
    @Post() prepare(@Req() req: Request, @Body() input: InstallPlanInput) { return this.plans.prepare(this.actor(req), input); }
    @Get(':id') view(@Req() req: Request, @Param('id') id: string) { return this.plans.view(this.actor(req), id); }
    @Post(':id/approve') approve(@Req() req: Request, @Param('id') id: string, @Body() input: { expectedManifest: string; expectedRevision: number }) {
        return this.plans.decide(this.actor(req), id, input, 'approved');
    }
    @Post(':id/revoke') revoke(@Req() req: Request, @Param('id') id: string, @Body() input: { expectedManifest: string; expectedRevision: number }) {
        return this.plans.decide(this.actor(req), id, input, 'revoked');
    }
}
