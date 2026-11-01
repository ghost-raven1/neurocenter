import type { stages } from './constants.js';
import type { TCodexResponseFailureReason } from '../response.js';

export type TCodexDiagnosticStage = (typeof stages)[number];

export type TCodexMediaType = 'sse' | 'json' | 'other' | 'missing';

export interface ICodexDiagnostic {
    schemaVersion: 1;
    stage: TCodexDiagnosticStage;
    httpStatus?: number;
    mediaType?: TCodexMediaType;
    reason?: TCodexResponseFailureReason;
}
