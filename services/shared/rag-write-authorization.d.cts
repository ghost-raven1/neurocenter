export const RAG_WRITE_AUTHORIZATION_PROTOCOL: 'rag-write-authorization-v1';
export const RAG_WRITE_POLICY: 'fresh-project-writer-v1';
export const RAG_LEGACY_WRITE_POLICY: 'legacy-receipt-only-v1';
export const RAG_WRITE_AUTHORIZATION_REQUIRED: 'RAG_WRITE_AUTHORIZATION_REQUIRED';
export type TRagWriteAuthorizationPhase = 'receipt' | 'write';
export interface IRagWriteGrant {
    ok: true;
    protocol: typeof RAG_WRITE_AUTHORIZATION_PROTOCOL;
    phase: TRagWriteAuthorizationPhase;
}
export function validRagWriteGrant(value: unknown, phase: TRagWriteAuthorizationPhase): value is IRagWriteGrant;
export function ragWriteAdmissionUncertain(value: unknown): boolean;
