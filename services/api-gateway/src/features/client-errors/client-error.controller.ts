import { BadRequestException, Body, Controller, HttpException, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLogger } from '../../../../shared/logging.cjs';
import { requestContextHeaders } from '../../../../shared/request-context.cjs';
import { UPSTREAM_UNAVAILABLE } from '../../proxy/error-policy';

const log = createLogger('api-gateway');

/**
 * AD-O5 (res-obs 6.11): приём client-репортов ошибок интерфейса.
 *
 * Public-роут (без auth), rate-limit — nginx limit_req zone errors_client
 * (10r/m per IP + burst; паттерн neurocenter_login). Gateway — allowlist-валидация
 * (AD-O8/AD-19: только безопасные поля, клиентские payload/URL/cookies в тело
 * репорта не попадают) и доставка в catalog POST /internal/error-events
 * (internal token, service='frontend').
 *
 * Best-effort (OQ-2): при сбое доставки/429 репорт отбрасывается — client-ошибка
 * не должна затапливать error_events.
 */

/** Фиксированные safe-классификаторы client-репортов (allowlist). */
const CLIENT_ERROR_MESSAGES = new Set(['client-render-error', 'client-uncaught-error', 'client-unhandled-rejection']);
/** Имя компонента — идентификатор кода, не произвольный текст. */
const SAFE_COMPONENT = /^[A-Za-z_$][A-Za-z0-9_$-]{0,119}$/;
/** X-Request-ID — header-safe формат (тот же, что request-context.cjs). */
const SAFE_REQUEST_ID = /^[a-z0-9][a-z0-9._-]{0,126}[a-z0-9]$/i;
/** Ограничение stack-hint в байтах (AD-O5 OQ-1). */
const MAX_STACK_HINT_BYTES = 4096;
/** Число скоалесированных ошибок в одном репорте. */
const MAX_REPORT_COUNT = 1000;
/** Дедлайн доставки в каталог, мс. */
const CATALOG_DELIVERY_TIMEOUT_MS = 5000;

interface INormalizedClientReport {
    message: string;
    component: string | null;
    stackHint: string | null;
    requestId: string;
    count: number;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** Пометка об обрезке (учитывается в лимите: итог не длиннее maxBytes). */
const TRUNCATION_MARKER = '…[truncated]';
const truncateToBytes = (value: string, maxBytes: number): string => {
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
        return value;
    }
    // Каталог отклоняет stackHint > 4 КБ: маркер резервируется, итог ≤ maxBytes.
    const limit = maxBytes - Buffer.byteLength(TRUNCATION_MARKER, 'utf8');
    let out = '';
    let size = 0;
    for (const char of value) {
        const charBytes = Buffer.byteLength(char, 'utf8');
        if (size + charBytes > limit) {
            break;
        }
        out += char;
        size += charBytes;
    }
    return `${out}${TRUNCATION_MARKER}`;
};

@Controller('api')
export class ClientErrorController {
    constructor(private readonly config: ConfigService) {}

    /**
     * Client-репорт ошибки интерфейса (коалированный: count — число событий).
     *
     * @param {unknown} body — только allowlist-поля: message/component/stackHint/requestId/count
     * @returns {Promise<{ok: boolean}>}
     */
    @Post('errors/client')
    public async reportClientError(@Body() body: unknown): Promise<{ ok: boolean }> {
        const report = this.normalize(body);
        if (!report) {
            throw new BadRequestException('Некорректный репорт клиентской ошибки.');
        }
        try {
            await this.deliver(report);
        } catch (error) {
            // AD-O8: в лог — только safe-поля репорта (текст ошибки и body клиента — нет).
            log.warn('Client error report: доставка в каталог не удалась.', {
                err: error,
                service: 'frontend',
                message: report.message,
                count: report.count,
            });
            throw new HttpException({ code: UPSTREAM_UNAVAILABLE.code, message: UPSTREAM_UNAVAILABLE.message }, 502);
        }
        return { ok: true };
    }

    /**
     * Allowlist-нормализация: читаются только фиксированные поля; всё чужое
     * (payload/URL/cookies/тела) игнорируется — в репорт попасть не может.
     */
    private normalize(body: unknown): INormalizedClientReport | null {
        if (!isPlainObject(body)) {
            return null;
        }
        const { message, component, stackHint, requestId, count } = body;
        if (typeof message !== 'string' || !CLIENT_ERROR_MESSAGES.has(message)) {
            return null;
        }
        const safeComponent = typeof component === 'string' && SAFE_COMPONENT.test(component) ? component : null;
        let safeStackHint: string | null = null;
        if (typeof stackHint === 'string') {
            const trimmed = stackHint
                .replace(/\r\n/g, '\n')
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0)
                .join('\n');
            safeStackHint = trimmed ? truncateToBytes(trimmed, MAX_STACK_HINT_BYTES) : null;
        }
        const safeRequestId =
            typeof requestId === 'string' && SAFE_REQUEST_ID.test(requestId) ? requestId : 'background';
        const safeCount =
            typeof count === 'number' && Number.isInteger(count) && count >= 1 && count <= MAX_REPORT_COUNT ? count : 1;
        return {
            message,
            component: safeComponent,
            stackHint: safeStackHint,
            requestId: safeRequestId,
            count: safeCount,
        };
    }

    /** Доставка в catalog (internal): service='frontend' (фиксированное, OQ-3). */
    private async deliver(report: INormalizedClientReport): Promise<void> {
        const catalogUrl = this.config.get<string>('CATALOG_SERVICE_URL') || 'http://127.0.0.1:4100';
        const token = this.config.get<string>('NEUROCENTER_INTERNAL_TOKEN') || '';
        if (!token) {
            throw new Error('NEUROCENTER_INTERNAL_TOKEN не настроен для client error-репортов.');
        }
        const base = new URL(catalogUrl);
        if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
            throw new Error('Некорректно настроен адрес каталога для client error-репортов.');
        }
        const endpoint = new URL('/internal/error-events', base);
        // Префикс component добавляется до trunc: итог гарантированно ≤ 4 КБ (лимит каталога).
        const stackHint = report.component
            ? truncateToBytes(
                  report.stackHint
                      ? `component: ${report.component}\n${report.stackHint}`
                      : `component: ${report.component}`,
                  MAX_STACK_HINT_BYTES,
              )
            : report.stackHint;
        const response = await fetch(endpoint, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(CATALOG_DELIVERY_TIMEOUT_MS),
            headers: {
                'content-type': 'application/json',
                'x-neurocenter-internal': token,
                ...requestContextHeaders(),
            },
            body: JSON.stringify({
                events: [
                    {
                        service: 'frontend',
                        level: 'error',
                        message: report.message,
                        requestId: report.requestId,
                        stackHint: stackHint ?? null,
                    },
                ],
            }),
        });
        const result = ((await response.json().catch(() => ({}))) || {}) as { received?: unknown };
        if (!response.ok || result.received !== 1) {
            throw new Error('Каталог не принял client error-событие.');
        }
    }
}
