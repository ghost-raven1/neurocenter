import type { IRemoteModelOptions } from '../interfaces';

export interface IOpenCodeCandidate {
    candidateId: string;
    baseUrl?: string | null;
    provider: string;
    name: string;
    model: string;
    capability: 'vision' | 'chat';
    runtime: string | null;
    hasKey: boolean;
    credentialSource?: 'none' | 'inline' | 'environment' | 'file' | 'auth';
    blocker: string | null;
    outputTokenLimit?: number;
    options?: IRemoteModelOptions;
    parameterIssues?: Array<{ name: string; type: string }>;
    timeoutMs?: number;
}
export interface IOpenCodeCandidatePreviewProps {
    candidate: IOpenCodeCandidate;
    localCodex: boolean;
    blockerReason?: string;
}
