import type { ICodexSession } from '../auth-session/interfaces.js';

export type TSessionReader = (refresh?: boolean, signal?: AbortSignal) => Promise<ICodexSession>;
