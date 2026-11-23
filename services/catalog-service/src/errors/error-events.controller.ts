import { BadRequestException, Body, Controller, ForbiddenException, Get, Headers, Post, Query, Req } from '@nestjs/common';
import { assertInternal } from '../access/access.controller';
import { pagination } from '../catalog/pagination';
import { ErrorEventsService } from './error-events.service';
import type { IErrorEvent, TErrorEventLevel } from './error-events';

/** Минимальная форма HTTP-запроса (заголовки, инжектированные gateway). */
interface IHttpRequest {
    headers: Record<string, unknown>;
}

/**
 * AD-O5 (res-obs 6.10): приём error-событий от писателей без прямого PG
 * (api-gateway, feature-flags, oauth2-bridge, rag-sync, skills). Доставка из file outbox
 * писателя; идемпотентность по id внутри error_events.
 */
@Controller()
export class ErrorEventsInternalController {
    constructor(private readonly events: ErrorEventsService) {}
    /** Тело — конверт `{ events }`, как у соседнего /internal/security-events. */
    @Post('internal/error-events')
    async record(@Headers('x-neurocenter-internal') token: string, @Body() body: { events?: IErrorEvent[] }) {
        assertInternal(token);
        return this.events.record(body?.events ?? []);
    }
}

/**
 * AD-O5: чтение error-событий для Главного админа (фильтры service/requestId/level/period,
 * пагинация как у /api/audit). Уровень доступа — та же политика, что у assertMainAdmin.
 */
@Controller('api')
export class ErrorEventsController {
    constructor(private readonly events: ErrorEventsService) {}

    /** Период «24h»/«7d» → граница ts; некорректное значение отклоняется до SQL. */
    private periodToSince(period: string | undefined): Date | undefined {
        if (period === undefined || period === '') return undefined;
        const match = /^(\d+)(h|d)$/.exec(period);
        if (!match) throw new BadRequestException('Период — число с суффиксом h или d (например, 24h).');
        const value = Number(match[1]);
        if (!Number.isSafeInteger(value) || value < 1) {
            throw new BadRequestException('Период — число с суффиксом h или d (например, 24h).');
        }
        const ms = value * (match[2] === 'h' ? 3_600_000 : 86_400_000);
        return new Date(Date.now() - ms);
    }

    @Get('errors')
    public async listErrors(
        @Req() req: IHttpRequest,
        @Query() query: Record<string, string>,
    ): Promise<ReturnType<ErrorEventsService['list']>> {
        const actor = JSON.parse(decodeURIComponent(String(req.headers['x-bridge-actor'] || '{}'))) as { activeRole?: unknown };
        if (actor.activeRole !== 'Главный админ') {
            throw new ForbiddenException('Нужна активная роль «Главный админ».');
        }
        const { page, size } = pagination(query);
        const level = query.level as TErrorEventLevel | undefined;
        if (level !== undefined && level !== 'error' && level !== 'critical') {
            throw new BadRequestException('Уровень — error или critical.');
        }
        return this.events.list({
            service: query.service || undefined,
            requestId: query.requestId || undefined,
            level: level ?? undefined,
            since: this.periodToSince(query.period),
            page,
            size,
        });
    }
}
