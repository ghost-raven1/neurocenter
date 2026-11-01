import type { ICompatibleCliProof } from '../opencode-local-providers/editor.js';
import type { IOpenCodePersonalKeyPayload, IOpenCodePersonalKeyContext } from './contract.js';
export interface IPersonalKeyOptions {
    jobId: string;
    payload: IOpenCodePersonalKeyPayload;
    context: IOpenCodePersonalKeyContext;
    home: string;
    environment: NodeJS.ProcessEnv;
    journalDirectory: string;
    siteOrigin: string;
    apiOrigin: string;
    ownerEmail: string;
    authorize: () => Promise<unknown>;
    current: () => void;
    assertCompatibleCli: () => Promise<ICompatibleCliProof>;
    wire: (route: 'context' | 'save' | 'receipt', input: unknown) => Promise<unknown>;
}
export interface IPersonalKeyIntent {
    schemaVersion: 1;
    jobId: string;
    payload: IOpenCodePersonalKeyPayload;
    sourceFingerprint: string;
    siteOrigin: string;
    apiOrigin: string;
    ownerEmail: string;
}
