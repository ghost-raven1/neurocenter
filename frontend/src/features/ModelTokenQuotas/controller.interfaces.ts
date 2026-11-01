import type { IQuotaInput } from './interfaces';

/** Contract owned by controller. */
export interface IQuotaApi {
    read: (signal: AbortSignal) => Promise<unknown>;
    write: (input: IQuotaInput, signal: AbortSignal) => Promise<unknown>;
    receipt: (requestKey: string, signal: AbortSignal) => Promise<unknown>;
}
