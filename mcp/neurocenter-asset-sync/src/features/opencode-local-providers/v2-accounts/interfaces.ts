import type { IGlobalProvidersLimits } from '../../../../../../services/shared/opencode-local-providers.cjs';
import type { ICompatibleCliProof } from '../editor.js';
export interface IAccount {
    id: string;
    integrationID: string;
    value: { type: string; key?: string };
}
export interface IRegistration {
    id: string;
    version: string;
    url: string;
    pid: number;
    password: string;
}
export interface IOptions {
    home: string;
    environment: NodeJS.ProcessEnv;
    authorize: () => Promise<unknown>;
    assertCompatibleCli: () => Promise<ICompatibleCliProof>;
    current?: () => void;
    signal?: AbortSignal;
    limits: Readonly<IGlobalProvidersLimits>;
}
export interface IIntent {
    id: string;
    key: string;
    server: IRegistration;
    complete: boolean;
}
