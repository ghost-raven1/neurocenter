import base, { getLastRequestId } from '../../core/api/base';

import { sanitizeClientStackHint } from './clientStackHint';

/**
 * AD-O5 (res-obs 6.11): репортинг ошибок интерфейса в error-store.
 *
 * STRICT allowlist-сбор (AD-O8/AD-19): в репорт попадают ТОЛЬКО фиксированные
 * поля — message (фиксированный классификатор, НЕ error.message), component
 * (имя компонента), stackHint (кадры без значений), requestId (X-Request-ID
 * из последнего ответа, иначе 'background'). Payload, URL-параметры, cookies,
 * localStorage и тела запросов/ответов НЕ отправляются никогда.
 *
 * Коаляция: pending-ошибки сливаются в один репорт с числом (1 репорт/мин) —
 * уменьшает нагрузку и риск 429. Доставка best-effort: при 429/сбое репорт
 * отбрасывается (не затапливает error_events).
 */

/** Типы client-ошибок (фиксированный набор). */
export type TClientErrorKind = 'render' | 'uncaught' | 'rejection';

/** Фиксированные safe-классификаторы (те же, что allowlist gateway). */
export const CLIENT_ERROR_MESSAGES: Record<TClientErrorKind, string> = {
    render: 'client-render-error',
    uncaught: 'client-uncaught-error',
    rejection: 'client-unhandled-rejection',
};

/** Ввод репорта: только эти поля читаются, остальное игнорируется. */
export interface IClientErrorInput {
    kind: TClientErrorKind;
    /** Имя компонента (опционально; валидируется как идентификатор). */
    component?: string;
    /** Кадры без значений (опционально; trunc до 4 КБ). */
    stackHint?: string;
}

/** Маркер фоновых событий (тот же, что BACKGROUND_REQUEST_ID shared). */
const BACKGROUND_REQUEST_ID = 'background';
/** Окно коаляции: 1 репорт/мин. */
const COALESCE_WINDOW_MS = 60_000;
/** Очередь не растёт бесконечно: старые события отбрасываются. */
const MAX_PENDING = 200;
/** Имя компонента — идентификатор кода, не произвольный текст. */
const SAFE_COMPONENT = /^[A-Za-z_$][A-Za-z0-9_$-]{0,119}$/;
/** X-Request-ID — header-safe формат (тот же, что request-context.cjs). */
const SAFE_REQUEST_ID = /^[a-z0-9][a-z0-9._-]{0,126}[a-z0-9]$/i;

interface IPendingReport {
    message: string;
    component: string | null;
    stackHint: string | null;
    requestId: string;
}

let pending: IPendingReport[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Фиксирует client-ошибку (allowlist-поля) и планирует коалированную доставку.
 *
 * @param {IClientErrorInput} input — kind/component/stackHint
 * @returns {void}
 */
export function reportClientError(input: IClientErrorInput): void {
    if (!input || typeof input !== 'object') {
        return;
    }
    const { kind } = input;
    if (kind !== 'render' && kind !== 'uncaught' && kind !== 'rejection') {
        return;
    }
    const rawRequestId = getLastRequestId();
    const descriptor: IPendingReport = {
        message: CLIENT_ERROR_MESSAGES[kind],
        component: typeof input.component === 'string' && SAFE_COMPONENT.test(input.component) ? input.component : null,
        stackHint: sanitizeClientStackHint(input.stackHint),
        requestId: rawRequestId && SAFE_REQUEST_ID.test(rawRequestId) ? rawRequestId : BACKGROUND_REQUEST_ID,
    };
    pending.push(descriptor);
    if (pending.length > MAX_PENDING) {
        pending.splice(0, pending.length - MAX_PENDING);
    }
    if (!flushTimer) {
        flushTimer = setTimeout(() => {
            flushTimer = null;
            void flushClientErrorReport();
        }, COALESCE_WINDOW_MS);
    }
}

/**
 * Коалированная доставка: все pending-ошибки — одним POST с числом.
 * Best-effort: любой сбой — молча (метрика 429/сбоя не критична для SPA).
 *
 * @returns {Promise<void>}
 */
export async function flushClientErrorReport(): Promise<void> {
    if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
    }
    const batch = pending;
    pending = [];
    if (!batch.length) {
        return;
    }
    const first = batch[0];
    const body = {
        count: batch.length,
        message: first.message,
        component: first.component,
        stackHint: first.stackHint,
        requestId: first.requestId,
    };
    try {
        await base.post('/api/errors/client', body, { skipUnauthorizedHandler: true });
    } catch {
        // Best-effort (OQ-2): репорт отброшен (429/сеть) — не роняем SPA.
    }
}
