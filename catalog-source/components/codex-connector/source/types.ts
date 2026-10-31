export type TRpcId = string | number;

export type IJsonObject = Record<string, unknown>;

export interface IRpcMessage {
  id?: TRpcId;
  method?: string;
  params?: IJsonObject;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface IApproval {
  method: string;
  details: IJsonObject;
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
  status: "completed" | "failed" | "interrupted";
  text: string;
  error?: string;
}

export type TSessionReader = (refresh?: boolean) => Promise<CodexSession>;

/** Only access credentials live here, in memory. Refresh credentials remain owned by Codex. */
export interface ICodexSession { 
  accessToken: string;
  accountId: string;
  expiresAt: number
}

export interface ICodexModel {
  id: string; 
  name: string;
  isDefault: boolean;
  inputModalities: string[];
  defaultReasoningEffort: string;
  reasoningEfforts: string[];
}
