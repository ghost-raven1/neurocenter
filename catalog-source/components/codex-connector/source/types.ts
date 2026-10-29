export type RpcId = string | number;
export type JsonObject = Record<string, unknown>;
export interface RpcMessage {
  id?: RpcId;
  method?: string;
  params?: JsonObject;
  result?: unknown;
  error?: { code: number; message: string };
}
export interface Approval {
  method: string;
  details: JsonObject;
}
export interface RunOptions {
  prompt: string;
  cwd: string;
  threadId?: string;
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  command?: string;
  commandArgs?: string[];
  approve?: (request: Approval) => Promise<boolean>;
  onText?: (text: string) => void;
}
export interface RunResult {
  threadId: string;
  turnId: string;
  status: "completed" | "failed" | "interrupted";
  text: string;
  error?: string;
}
