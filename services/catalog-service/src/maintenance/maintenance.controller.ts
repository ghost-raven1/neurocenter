import { getCapacityStatus } from '../../../shared/capacity.cjs';
import { Body, Controller, ForbiddenException, Get, Patch, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AccessDb } from '../access/access-db';
import { assertInternal } from '../access/access.controller';
import { MaintenanceService } from './maintenance.service';

/** Даже прямой внутренний вызов заново проверяет действующие платформенные права. */
@Controller('api/maintenance')
export class MaintenanceController {
    constructor(
        private readonly maintenance: MaintenanceService,
        private readonly access: AccessDb,
    ) {}
    @Get('capacity')
    async capacity(@Req() req: Request) {
        await this.requireMain(req);
        return getCapacityStatus();
    }
    @Get('policy')
    async get(@Req() req: Request) {
        await this.requireMain(req);
        return this.maintenance.get();
    }
    @Patch('policy')
    async save(@Req() req: Request, @Body() input: Parameters<MaintenanceService['save']>[0]) {
        const email = await this.requireMain(req);
        return this.maintenance.save(input, email);
    }
    private async requireMain(req: Request): Promise<string> {
        assertInternal(req.headers['x-neurocenter-internal']);
        let actor: { email?: string; activeRole?: string } | null;
        try {
            actor = JSON.parse(decodeURIComponent(String(req.headers['x-bridge-actor'] || 'null')));
        } catch {
            throw new ForbiddenException('Нужна действующая роль главного администратора.');
        }
        const claims = await this.access.claims(actor?.email);
        if (actor?.activeRole !== 'Главный админ' || !claims.userRoles.includes('Главный админ')) {
            throw new ForbiddenException('Нужна действующая роль главного администратора.');
        }
        return claims.email;
    }
}
