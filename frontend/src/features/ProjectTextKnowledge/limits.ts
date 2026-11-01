import { TEXT_KNOWLEDGE_LIMITS, textKnowledgeLimits } from '@neurocenter/project-text-knowledge';
import type { ITextKnowledgeLimits } from '@neurocenter/project-text-knowledge';
export type { ITextKnowledgeLimits as TextKnowledgeLimits } from '@neurocenter/project-text-knowledge';

/** Effective policy is supplied by its settings owner; shared values remain the fallback. */
export const defaultTextKnowledgeLimits: Readonly<ITextKnowledgeLimits> = TEXT_KNOWLEDGE_LIMITS;
export const formatKnowledgeBytes = (bytes: number): string =>
    `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(bytes / 1024)} КиБ`;
export interface ITextLimitsDecision {
    revision: number;
    limits: Readonly<ITextKnowledgeLimits>;
    legacy?: boolean;
}

export function requireTextLimitsDecision(raw: unknown): ITextLimitsDecision {
    const value = raw as { revision?: unknown; policy?: { textKnowledge?: unknown } } | null;
    if (
        !value ||
        !Number.isSafeInteger(value.revision) ||
        Number(value.revision) < 0 ||
        !value.policy ||
        !value.policy.textKnowledge
    )
        throw Error('Сервер не подтвердил лимиты базы знаний.');
    return { revision: Number(value.revision), limits: textKnowledgeLimits(value.policy?.textKnowledge) };
}
