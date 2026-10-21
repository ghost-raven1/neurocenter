import type {ChatProjectEvidence,ChatProjectSource} from './chat-project-context.types';

/** Research citations contain only fragments actually read by this recipient. */
export function researchEvidence(evidence:ChatProjectEvidence,sources:ChatProjectSource[]):ChatProjectEvidence {
    if(!sources.length)return evidence;
    const combined=new Map([...evidence.sources,...sources].map(source=>[source.id,source]));
    return {...evidence,status:'ready',sources:[...combined.values()]};
}
