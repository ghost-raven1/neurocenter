import type {ISealedModelCredential} from '../models/remote-model-secret';
export type RemoteAuthMode = 'none'|'optional'|'required';
export interface RemoteProviderAccessView {
    modelId:string; providerId:string; providerUrl:string; connectionRevision:number; authMode:RemoteAuthMode;
    credentialRevision:number; hasKey:boolean; updatedAt:string|null; canStoreKey:boolean; legacySharedKeyRetained:boolean;
}
export interface RemoteProviderMutation {
    providerId:string; expectedConnectionRevision:number; expectedCredentialRevision:number; requestKey:string; apiKey?:string;
}
export interface RemoteProviderReceipt {
    modelId:string; providerId:string; requestKey:string; requestHash:string; connectionRevision:number;
    credentialRevision:number; hasKey:boolean; acceptedAt:string;
}
export interface RemoteUserCredentialRow {
    model_id:string; provider_id:string; owner_email:string; revision:number; credential:ISealedModelCredential|null; updated_at:string|Date;
}
export interface RemoteProviderActor {email:string; activeRole:string; projectId?:string|null;}
