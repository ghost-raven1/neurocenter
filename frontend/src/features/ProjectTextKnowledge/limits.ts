import {TEXT_KNOWLEDGE_LIMITS, textKnowledgeLimits} from '@neurocenter/project-text-knowledge';
import type {TextKnowledgeLimits} from '@neurocenter/project-text-knowledge';
export type {TextKnowledgeLimits} from '@neurocenter/project-text-knowledge';

/** Effective policy is supplied by its settings owner; shared values remain the fallback. */
export const defaultTextKnowledgeLimits:Readonly<TextKnowledgeLimits> = TEXT_KNOWLEDGE_LIMITS;
export const formatKnowledgeBytes = (bytes:number):string => `${new Intl.NumberFormat('ru-RU', {maximumFractionDigits:1}).format(bytes / 1024)} КиБ`;
export interface TextLimitsDecision {revision:number; limits:Readonly<TextKnowledgeLimits>; legacy?:boolean;}

export function requireTextLimitsDecision(raw:unknown):TextLimitsDecision {
    const value = raw as {revision?:unknown; policy?:{textKnowledge?:unknown}} | null;
    if (!value || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !value.policy
        || !value.policy.textKnowledge) throw Error('Сервер не подтвердил лимиты базы знаний.');
    return {revision:Number(value.revision), limits:textKnowledgeLimits(value.policy?.textKnowledge)};
}
