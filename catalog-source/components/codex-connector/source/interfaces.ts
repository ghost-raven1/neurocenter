export type TRpcId = string | number;

export type TJsonObject = Record<string, unknown>;

export interface IRpcMessage {
    id?: TRpcId;
    method?: string;
    params?: TJsonObject;
    result?: unknown;
    error?: { code: number; message: string };
}

export interface IApproval {
    method: string;
    details: TJsonObject;
}

export interface IRunOptions {
    prompt: string;
    cwd: string;
    threadId?: string;
    model?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    command?: string;
    commandArgs?: string[];
    approve?: (request: IApproval) => Promise<boolean>;
    onText?: (text: string) => void;
}

export interface IRunResult {
    threadId: string;
    turnId: string;
    status: 'completed' | 'failed' | 'interrupted';
    text: string;
    error?: string;
}
