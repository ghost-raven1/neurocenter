import {
    Body,
    Controller,
    ForbiddenException,
    Get,
    HttpException,
    Patch,
    Req,
    ServiceUnavailableException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AccessDb } from '../access/access-db';
import { assertInternal } from '../access/access.controller';

/** The platform quota belongs to RAG's base database; every browser request checks a fresh main-admin role. */
@Controller('api/maintenance/rag-quota-policy')
export class RagQuotaPolicyController {
    constructor(private readonly access: AccessDb) {}
    @Get() async get(@Req() req: Request) {
        await this.requireMain(req);
        return this.forward('GET');
    }
    @Patch() async save(@Req() req: Request, @Body() input: unknown) {
        const actor = await this.requireMain(req);
        return this.forward('PATCH', { policy: input, actor });
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
        if (actor?.activeRole !== 'Главный админ' || !claims.userRoles.includes('Главный админ'))
            throw new ForbiddenException('Нужна действующая роль главного администратора.');
        return claims.email;
    }

    private async forward(method: 'GET' | 'PATCH', body?: unknown): Promise<unknown> {
        const base = (process.env.RAG_SERVICE_URL || 'http://localhost:4300').replace(/\/+$/, '');
        try {
            const response = await fetch(base + '/internal/platform-rag-quota', {
                method,
                headers: {
                    'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN || '',
                    'content-type': 'application/json',
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
                signal: AbortSignal.timeout(15000),
                redirect: 'error',
            });
            let bytes = 0;
            const chunks: Uint8Array[] = [];
            if (!response.body) throw new Error('empty');
            for await (const chunk of response.body) {
                bytes += chunk.length;
                if (bytes > 16384) {
                    await response.body.cancel().catch(() => undefined);
                    throw new Error('oversize');
                }
                chunks.push(chunk);
            }
            const raw = Buffer.concat(chunks).toString('utf8');
            const result: unknown = JSON.parse(raw);
            if ([400, 409].includes(response.status))
                throw new HttpException(result as Record<string, unknown>, response.status);
            if (!response.ok) throw new Error('unavailable');
            return result;
        } catch (error) {
            if (error instanceof HttpException) throw error;
            throw new ServiceUnavailableException(
                'Настройки квот недоступны. Сохранённые лимиты проектов продолжают действовать.',
            );
        }
    }
}
