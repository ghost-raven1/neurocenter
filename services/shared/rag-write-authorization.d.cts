export const RAG_WRITE_AUTHORIZATION_PROTOCOL:'rag-write-authorization-v1';
export const RAG_WRITE_POLICY:'fresh-project-writer-v1';
export const RAG_LEGACY_WRITE_POLICY:'legacy-receipt-only-v1';
export const RAG_WRITE_AUTHORIZATION_REQUIRED:'RAG_WRITE_AUTHORIZATION_REQUIRED';
export type RagWriteAuthorizationPhase='receipt'|'write';
export interface IRagWriteGrant {ok:true;protocol:typeof RAG_WRITE_AUTHORIZATION_PROTOCOL;phase:RagWriteAuthorizationPhase;}
export function validRagWriteGrant(value:unknown,phase:RagWriteAuthorizationPhase):value is IRagWriteGrant;
export function ragWriteAdmissionUncertain(value:unknown):boolean;
