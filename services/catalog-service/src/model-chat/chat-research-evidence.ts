import type { IChatProjectEvidence, IChatProjectSource } from './chat-project-context.interfaces';

/** Research citations contain only fragments actually read by this recipient. */
export function researchEvidence(evidence: IChatProjectEvidence, sources: IChatProjectSource[]): IChatProjectEvidence {
    if (!sources.length) return evidence;
    const combined = new Map([...evidence.sources, ...sources].map((source) => [source.id, source]));
    return { ...evidence, status: 'ready', sources: [...combined.values()] };
}
