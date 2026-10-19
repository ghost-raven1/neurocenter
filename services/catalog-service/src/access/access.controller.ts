import { Body, Controller, ForbiddenException, Get, Headers, Post, Query, Req } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { AccessDb } from './access-db';
import { allowRequest, IAccessRequest } from './access-policy';
import { IAccessActor } from './access.model';

/** Проверяет служебную идентичность gateway и моста входа. */
export function assertInternal(token: unknown): void {
    const expected=process.env.NEUROCENTER_INTERNAL_TOKEN;
    if (!expected || typeof token!=='string' || Buffer.byteLength(token)!==Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(token),Buffer.from(expected))) {
        throw new ForbiddenException('Запрос должен пройти через авторизованный шлюз.');
    }
}

/** Управление назначениями отделено от публичной аутентификации пользователя. */
@Controller()
export class AccessController {
    constructor(private readonly access: AccessDb) {}
    @Get('internal/access/profile')
    async profile(@Headers('x-neurocenter-internal') token: string, @Query('email') email: string) {
        assertInternal(token); return this.access.claims(email);
    }
    @Get('internal/access/projects')
    async projects(@Headers('x-neurocenter-internal') token: string) { assertInternal(token); return this.access.projects(); }
    @Post('internal/access/authorize')
    async authorize(@Headers('x-neurocenter-internal') token: string,@Body() input: IAccessRequest & IAccessActor) {
        assertInternal(token);
        const claims=await this.access.claims(input.email);
        const allowed=allowRequest(claims,input.activeRole,input);
        return {allowed,claims};
    }
    @Get('api/platform/users')
    async users(@Req() req: Request) { await this.requireMain(req); return this.access.list(); }
    @Post('api/platform/users')
    async save(@Req() req: Request,@Body() input: Parameters<AccessDb['save']>[0]) { const actor=await this.requireMain(req); return this.access.save(input,actor.email); }
    private async requireMain(req: Request): Promise<IAccessActor> {
        assertInternal(req.headers['x-neurocenter-internal']);
        const actor=JSON.parse(decodeURIComponent(String(req.headers['x-bridge-actor'] || 'null'))) as IAccessActor | null;
        const claims=await this.access.claims(actor?.email);
        if (actor?.activeRole!=='Главный админ' || !claims.userRoles.includes('Главный админ')) { throw new ForbiddenException('Нужна роль «Главный админ».'); }
        return actor;
    }
}
