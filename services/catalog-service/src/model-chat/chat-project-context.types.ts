import type { ChatMessage } from './chat.types';
import type { IChatContextSettings } from './chat-context';

export interface ChatProjectSource {
    id: string; path: string; title?: string; startLine?: number; endLine?: number; score: number; excerpt: string;
}
export interface ChatProjectEvidence {
    status: 'none' | 'metadata' | 'ready' | 'empty' | 'unavailable';
    project?: { id: string; name: string; state: string; headRevision: number };
    generation?: string; sources: ChatProjectSource[]; message?: string;
}
export interface PreparedProjectContext {
    messages: ChatMessage[]; evidence: ChatProjectEvidence;
    assertCurrent(): Promise<void>;
    fit(history: ChatMessage[], settings: IChatContextSettings): { messages: ChatMessage[]; evidence: ChatProjectEvidence };
}
