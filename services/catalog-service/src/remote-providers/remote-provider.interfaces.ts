import type { ISealedModelCredential } from '../models/remote-model-secret';
export type TRemoteAuthMode = 'none' | 'optional' | 'required';
export interface IRemoteProviderAccessView {
    modelId: string;
    providerId: string;
    providerUrl: string;
    connectionRevision: number;
    authMode: TRemoteAuthMode;
    credentialRevision: number;
    hasKey: boolean;
    updatedAt: string | null;
    canStoreKey: boolean;
    legacySharedKeyRetained: boolean;
}
export interface IRemoteProviderMutation {
    providerId: string;
    expectedConnectionRevision: number;
    expectedCredentialRevision: number;
    requestKey: string;
    apiKey?: string;
}
export interface IRemoteProviderReceipt {
    modelId: string;
    providerId: string;
    requestKey: string;
    requestHash: string;
    connectionRevision: number;
    credentialRevision: number;
    hasKey: boolean;
    acceptedAt: string;
}
export interface IRemoteUserCredentialRow {
    model_id: string;
    provider_id: string;
    owner_email: string;
    revision: number;
    credential: ISealedModelCredential | null;
    updated_at: string | Date;
}
export interface IRemoteProviderActor {
    email: string;
    activeRole: string;
    projectId?: string | null;
}
