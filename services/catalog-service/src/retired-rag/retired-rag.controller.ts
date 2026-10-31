import { Body, Controller, ForbiddenException, Get, Headers, Param, Patch, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AccessDb } from '../access/access-db';
import { assertInternal } from '../access/access.controller';
import { RetiredRagService } from './retired-rag.service';

/** DELETE отсутствует намеренно: необратимая операция требует точного preview и durable requestKey. */
@Controller()
export class RetiredRagController {
    constructor(
        private readonly retired: RetiredRagService,
        private readonly access: AccessDb,
    ) {}
    @Get('api/maintenance/retired-rag-databases') async list(@Req() req: Request) {
        await this.main(req);
        return this.retired.list();
    }
    @Patch('api/maintenance/retired-rag-databases/:id/retention') async retention(
        @Req() req: Request,
        @Param('id') id: string,
        @Body() body: unknown,
    ) {
        return this.retired.retention(id, body, await this.main(req));
    }
    @Post('api/maintenance/retired-rag-databases/:id/preview') async preview(
        @Req() req: Request,
        @Param('id') id: string,
    ) {
        return this.retired.preview(id, await this.main(req));
    }
    @Post('api/maintenance/retired-rag-databases/:id/purge') async purge(
        @Req() req: Request,
        @Param('id') id: string,
        @Body() body: unknown,
    ) {
        return this.retired.purge(id, body, await this.main(req));
    }
    @Get('api/maintenance/retired-rag-purges/:id') async get(@Req() req: Request, @Param('id') id: string) {
        await this.main(req);
        return this.retired.get(id);
    }
    @Post('api/maintenance/retired-rag-purges/:id/retry') async retry(
        @Req() req: Request,
        @Param('id') id: string,
        @Body() body: unknown,
    ) {
        return this.retired.retry(id, body, await this.main(req));
    }
    @Post('internal/retired-rag/purges/:id/authorize') authorize(
        @Headers('x-neurocenter-internal') token: string,
        @Param('id') id: string,
        @Body() body: unknown,
    ) {
        assertInternal(token);
        return this.retired.authorize(id, body);
    }
    @Post('internal/retired-rag/retirements/:id/authorize-preview') authorizePreview(
        @Headers('x-neurocenter-internal') token: string,
        @Param('id') id: string,
        @Body() body: unknown,
    ) {
        assertInternal(token);
        return this.retired.authorizePreview(id, body);
    }
    private async main(req: Request): Promise<string> {
        assertInternal(req.headers['x-neurocenter-internal']);
        let actor: { email?: string; activeRole?: string } | null;
        try {
            actor = JSON.parse(decodeURIComponent(String(req.headers['x-bridge-actor'] || 'null')));
        } catch {
            throw new ForbiddenException('Нужна действующая роль главного администратора.');
        }
        const claims = await this.access.claims(actor?.email);
        if (actor?.activeRole !== 'Главный админ' || !claims.userRoles.includes('Главный админ'))
            throw new ForbiddenException('Нужна действующая роль главного администратора.');
        return claims.email;
    }
}
