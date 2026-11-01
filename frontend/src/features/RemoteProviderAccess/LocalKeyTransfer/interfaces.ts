import type { IPersonalProviderView } from '../model';
import type { IOpenCodePersonalKeyRequest, IOpenCodePersonalKeyReceipt, TOpenCodePersonalKeyResult } from './contract';
import type { localKeyTransferApi } from './api';
import type { TCliJournalLock } from '../../ComputerSetup/journalLock';
export interface ILocalKeyTransferProps {
    view: IPersonalProviderView;
    manualPending: boolean;
    busy: boolean;
    onUpdated: () => Promise<void>;
}
export interface ITransferIntent {
    role: string;
    request: IOpenCodePersonalKeyRequest;
    jobId?: string;
}
export interface ITransferState {
    intent?: ITransferIntent;
    result?: TOpenCodePersonalKeyResult;
    receipt?: IOpenCodePersonalKeyReceipt;
    busy: boolean;
    error: string;
    journalError: string;
    canReplay: boolean;
    canRestart: boolean;
}
export interface ITransferControllerOptions {
    owner: string;
    role: string;
    deviceId: string;
    modelId: string;
    storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
    lock?: TCliJournalLock;
    api: typeof localKeyTransferApi;
    captureOwner: () => () => boolean;
    canOpen: () => boolean;
    target: () => IPersonalProviderView;
    onChange: (state: ITransferState) => void;
    onSaved: () => void;
}
