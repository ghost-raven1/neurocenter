import { BadRequestException } from '@nestjs/common';
import { normalizeEmail } from '../access/access.model';
import { MODEL_USAGE_PURPOSES } from './model-usage.context';
import { MODEL_USAGE_STATUSES, type ModelUsageQuery, type UsageFilter } from './model-usage.types';

/** Every public filter is explicit; none changes the authoritative actor/project scope. */
export function modelUsageFilter(query: ModelUsageQuery): UsageFilter {
    if (Object.keys(query).some(key => !['days', 'projectId', 'modelId', 'purpose', 'status', 'cursor', 'limit', 'actorEmail', 'agentId', 'endpoint', 'provider'].includes(key))) throw new BadRequestException('Неизвестный фильтр использования моделей.');
    if ((['days', 'limit'] as const).some(key => query[key] !== undefined && typeof query[key] !== 'string')) throw new BadRequestException('Период и размер страницы задаются одним значением.');
    const days = query.days === undefined ? 7 : Number(query.days), limit = query.limit === undefined ? 50 : Number(query.limit);
    if (![1, 7, 30].includes(days) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new BadRequestException('Период: 1, 7 или 30 дней; страница: до 100 операций.');
    const filter: UsageFilter = { days, limit };
    for (const key of ['projectId', 'modelId', 'agentId'] as const) if (query[key] !== undefined) {
        if (typeof query[key] !== 'string' || !query[key] || query[key]!.length > 256 || /[\x00-\x1f\x7f]/.test(query[key]!)) throw new BadRequestException('Некорректный идентификатор фильтра.');
        filter[key] = query[key];
    }
    if (query.actorEmail !== undefined) {
        try { filter.actorEmail = query.actorEmail === '__system__' ? null : normalizeEmail(query.actorEmail); }
        catch { throw new BadRequestException('Выберите пользователя или серверные задания.'); }
    }
    if (query.endpoint !== undefined) { if (!['chat', 'embed'].includes(query.endpoint)) throw new BadRequestException('Неизвестный API модели.'); filter.endpoint = query.endpoint as UsageFilter['endpoint']; }
    if (query.provider !== undefined) { if (!['ollama', 'remote-openai', 'remote-ollama'].includes(query.provider)) throw new BadRequestException('Неизвестный тип подключения.'); filter.provider = query.provider; }
    if (query.purpose !== undefined) { if (!MODEL_USAGE_PURPOSES.includes(query.purpose as never)) throw new BadRequestException('Неизвестное назначение вызова.'); filter.purpose = query.purpose as UsageFilter['purpose']; }
    if (query.status !== undefined) { if (!MODEL_USAGE_STATUSES.includes(query.status as never)) throw new BadRequestException('Неизвестное состояние вызова.'); filter.status = query.status as UsageFilter['status']; }
    if (query.cursor !== undefined) {
        try {
            if (typeof query.cursor !== 'string' || query.cursor.length > 512) throw new Error();
            const value = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'));
            if (!value || Object.keys(value).sort().join(',') !== 'id,startedAt' || typeof value.id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.id)
                || typeof value.startedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3,6}Z$/.test(value.startedAt) || !Number.isFinite(new Date(value.startedAt).getTime())
                || new Date(value.startedAt).toISOString().slice(0, 19) !== value.startedAt.slice(0, 19)) throw new Error();
            filter.cursor = value;
        } catch { throw new BadRequestException('Некорректная страница журнала.'); }
    }
    return filter;
}
