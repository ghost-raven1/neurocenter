/** Only access credentials live here, in memory. Refresh credentials remain owned by Codex. */
export interface ICodexSession {
    accessToken: string;
    accountId: string;
    expiresAt: number;
}

export interface ICodexModel {
    id: string;
    name: string;
    isDefault: boolean;
    inputModalities: string[];
    defaultReasoningEffort: string;
    reasoningEfforts: string[];
}
