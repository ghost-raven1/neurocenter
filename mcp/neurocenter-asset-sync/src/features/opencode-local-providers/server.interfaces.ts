import type { ICompatibleCliProof } from './editor.js';
import type { contract, IGlobalProvidersLimits } from './contract.js';
export interface IPrivateProviderEditor {
    inventory(): Promise<unknown>;
    lastSave(): Promise<unknown>;
    prepare(value: Record<string, unknown>): Promise<unknown>;
    save(value: Record<string, unknown>): Promise<unknown>;
    resume(value: Record<string, unknown>): Promise<unknown>;
}
export interface IPrivateProviderContext {
    signal: AbortSignal;
    authorize: () => Promise<void>;
    current: () => void;
    assertCompatibleCli: () => Promise<ICompatibleCliProof>;
}
export interface IOptions {
    privateEditor?: { page: string; create: (context: IPrivateProviderContext) => IPrivateProviderEditor };
    adapter?: typeof contract.OPENCODE_V2_ACCOUNTS_ADAPTER;
    id: string;
    home: string;
    environment: NodeJS.ProcessEnv;
    expiresAt: string;
    limits: Readonly<IGlobalProvidersLimits>;
    authorize: (signal?: AbortSignal) => Promise<unknown>;
    assertCurrent: () => Promise<void>;
    assertCompatibleCli: (signal?: AbortSignal) => Promise<ICompatibleCliProof>;
    open: (url: string) => Promise<boolean>;
}
