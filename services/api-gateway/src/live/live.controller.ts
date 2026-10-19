import {
    Body,
    Controller,
    ForbiddenException,
    Headers,
    Post,
} from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { LiveService } from './live.service';

/** Служебные уведомления о завершении фоновых операций сервисов. */
@Controller('internal/events')
export class LiveController {
    constructor(private readonly live: LiveService) {}
    @Post() publish(
        @Headers('x-neurocenter-internal') token: string,
        @Body() body: { sections?: string[] },
    ) {
        const expected = process.env.NEUROCENTER_INTERNAL_TOKEN || '';
        if (
            !expected ||
            typeof token !== 'string' ||
            Buffer.byteLength(expected) !== Buffer.byteLength(token) ||
            !timingSafeEqual(Buffer.from(expected), Buffer.from(token))
        ) {
            throw new ForbiddenException();
        }
        const allowed = [
            'projects',
            'catalog',
            'knowledge',
            'access',
            'maintenance',
            'audit',
            'operations',
        ];
        this.live.sections(
            (body.sections || []).filter((section) =>
                allowed.includes(section),
            ),
        );
        return { ok: true };
    }
}
