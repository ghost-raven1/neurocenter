import { CODEX_RESPONSE_FAILURE_REASONS, type TCodexResponseFailureReason } from '../response.js';
import { stages, httpStages } from './constants.js';
import { isHttpStatus } from './utils.js';

import type { ICodexDiagnostic, TCodexDiagnosticStage, TCodexMediaType } from './interfaces.js';
export type { ICodexDiagnostic, TCodexDiagnosticStage, TCodexMediaType } from './interfaces.js';

/** Diagnostics are optional local metadata: raw errors, headers, bodies and external identifiers never survive projection. */
export function sanitizeCodexDiagnostic(value: unknown): ICodexDiagnostic | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const item = value as Record<string, unknown>;
    if (item.schemaVersion !== 1 || !stages.includes(item.stage as TCodexDiagnosticStage)) return;
    const result: ICodexDiagnostic = { schemaVersion: 1, stage: item.stage as TCodexDiagnosticStage };
    if (httpStages.has(result.stage) && isHttpStatus(item.httpStatus)) {
        result.httpStatus = item.httpStatus;
        if (typeof item.mediaType === 'string' && ['sse', 'json', 'other', 'missing'].includes(item.mediaType))
            result.mediaType = item.mediaType as TCodexMediaType;
    }
    if (
        result.stage === 'response-validation' &&
        typeof item.reason === 'string' &&
        CODEX_RESPONSE_FAILURE_REASONS.includes(item.reason as TCodexResponseFailureReason)
    )
        result.reason = item.reason as TCodexResponseFailureReason;
    return result;
}

/** Observe headers synchronously before an upstream 401 refresh; do not clone, consume or delay the body. */
export function observeCodexHttp(response: Response): Pick<ICodexDiagnostic, 'httpStatus' | 'mediaType'> {
    if (!isHttpStatus(response.status)) return {};
    const type = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    return {
        httpStatus: response.status,
        mediaType: !type
            ? 'missing'
            : type === 'text/event-stream'
              ? 'sse'
              : type === 'application/json' || type.endsWith('+json')
                ? 'json'
                : 'other',
    };
}
