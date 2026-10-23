import {CODEX_RESPONSE_FAILURE_REASONS,type CodexResponseFailureReason} from './response.js';

const stages=['preflight','runtime-preparation','transport-loading','transport-call','dispatch-admission','outbound-fetch','response-headers','response-validation','completed'] as const;
export type CodexDiagnosticStage=typeof stages[number];
export type CodexMediaType='sse'|'json'|'other'|'missing';
export interface CodexDiagnostic {schemaVersion:1;stage:CodexDiagnosticStage;httpStatus?:number;mediaType?:CodexMediaType;reason?:CodexResponseFailureReason}
const httpStages=new Set<CodexDiagnosticStage>(['response-headers','response-validation','completed']);
const status=(value:unknown):value is number=>Number.isInteger(value)&&Number(value)>=100&&Number(value)<=599;

/** Diagnostics are optional local metadata: raw errors, headers, bodies and external identifiers never survive projection. */
export function sanitizeCodexDiagnostic(value:unknown):CodexDiagnostic|undefined {
    if(!value||typeof value!=='object'||Array.isArray(value))return;
    const item=value as Record<string,unknown>;
    if(item.schemaVersion!==1||!stages.includes(item.stage as CodexDiagnosticStage))return;
    const result:CodexDiagnostic={schemaVersion:1,stage:item.stage as CodexDiagnosticStage};
    if(httpStages.has(result.stage)&&status(item.httpStatus)){
        result.httpStatus=item.httpStatus;
        if(typeof item.mediaType==='string'&&['sse','json','other','missing'].includes(item.mediaType))result.mediaType=item.mediaType as CodexMediaType;
    }
    if(result.stage==='response-validation'&&typeof item.reason==='string'&&CODEX_RESPONSE_FAILURE_REASONS.includes(item.reason as CodexResponseFailureReason))result.reason=item.reason as CodexResponseFailureReason;
    return result;
}

/** Observe headers synchronously before an upstream 401 refresh; do not clone, consume or delay the body. */
export function observeCodexHttp(response:Response):Pick<CodexDiagnostic,'httpStatus'|'mediaType'> {
    if(!status(response.status))return {};
    const type=response.headers.get('content-type')?.split(';',1)[0]?.trim().toLowerCase();
    return {httpStatus:response.status,mediaType:!type?'missing':type==='text/event-stream'?'sse':type==='application/json'||type.endsWith('+json')?'json':'other'};
}
