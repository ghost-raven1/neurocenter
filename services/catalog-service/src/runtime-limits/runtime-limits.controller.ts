import { Body, Controller, Get, Param, Patch, Req } from '@nestjs/common';
import type { Request } from 'express';
import { assertInternal } from '../access/access.controller';
import { RuntimeLimitsService } from './runtime-limits.service';
import type { RuntimeLimitInput } from '../../../shared/runtime-limits.cjs';

@Controller('api/runtime-limits')
export class RuntimeLimitsController {
    constructor(private readonly limits: RuntimeLimitsService) {}
    @Get() effective(@Req() req: Request) {
        return this.limits.read(req);
    }
    @Get('admin') admin(@Req() req: Request) {
        return this.limits.admin(req);
    }
    @Patch('admin') save(@Req() req: Request, @Body() input: RuntimeLimitInput) {
        return this.limits.save(req, input);
    }
    @Get('admin/requests/:key') receipt(@Req() req: Request, @Param('key') key: string) {
        return this.limits.receipt(req, key);
    }
}
@Controller('internal/runtime-limits')
export class InternalRuntimeLimitsController {
    constructor(private readonly limits: RuntimeLimitsService) {}
    @Get() effective(@Req() req: Request) {
        assertInternal(req.headers['x-neurocenter-internal']);
        return this.limits.effective();
    }
}
