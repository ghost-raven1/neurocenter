import {TEXT_KNOWLEDGE_CEILINGS, textBytes, textKnowledgeLimits} from '@neurocenter/project-text-knowledge';
import type {TextCorpusState, TextSearchResult, TextUploadReceipt} from '@neurocenter/project-text-knowledge';
export type {TextCorpusState, TextDocument, TextSearchResult, TextUpload, TextUploadReceipt, TextContext} from '@neurocenter/project-text-knowledge';

const object = (value:unknown):value is Record<string,unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value:unknown):value is number => Number.isSafeInteger(value) && Number(value) >= 0;
export const sha = (value:unknown):value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const uuid = (value:unknown):value is string => typeof value === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value);
const date = (value:unknown):value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const admission = (value:unknown) => {
    if (value === undefined) return undefined;
    if (!object(value) || !integer(value.revision) || !object(value.limits)) throw Error('Сервер не подтвердил условия принятого запроса.');
    return {revision:value.revision, limits:textKnowledgeLimits(value.limits)};
};

/** Unconfirmed transport data never becomes a corpus or a selectable citation. */
export function requireCorpus(value:unknown, projectId:string):TextCorpusState {
    if (!object(value) || value.mode !== 'text' || value.projectId !== projectId || !integer(value.revision) || !sha(value.corpusHash)
        || !integer(value.documentCount) || !integer(value.bytes) || !(value.updatedAt === null || date(value.updatedAt))) {
        throw Error('Сервер не подтвердил состояние текстовой базы знаний.');
    }
    return {mode:'text', projectId, revision:value.revision, corpusHash:value.corpusHash,
        documentCount:value.documentCount, bytes:value.bytes, updatedAt:value.updatedAt};
}

export function requireReceipt(value:unknown, projectId:string):TextUploadReceipt {
    const corpus = requireCorpus(value, projectId);
    if (!object(value) || !uuid(value.requestKey) || !sha(value.requestHash) || !date(value.acceptedAt)) {
        throw Error('Квитанция загрузки не подтверждена. Проверьте прежнюю загрузку перед повтором.');
    }
    const accepted = admission(value.admission);
    return {...corpus, requestKey:value.requestKey, requestHash:value.requestHash, acceptedAt:value.acceptedAt, ...(accepted ? {admission:accepted} : {})};
}

export function requireSearch(value:unknown, projectId:string):TextSearchResult {
    if (!object(value) || value.mode !== 'text' || value.projectId !== projectId || !integer(value.revision) || !sha(value.corpusHash)
        || !Array.isArray(value.sources) || value.sources.length > TEXT_KNOWLEDGE_CEILINGS.sources) throw Error('Сервер не подтвердил результаты поиска.');
    const ids = new Set<string>();
    const sources = value.sources.map(source => {
        if (!object(source) || typeof source.id !== 'string' || !source.id || ids.has(source.id)
            || typeof source.path !== 'string' || !source.path || textBytes(source.path) > TEXT_KNOWLEDGE_CEILINGS.pathBytes
            || typeof source.excerpt !== 'string' || !source.excerpt.trim() || textBytes(source.excerpt) > TEXT_KNOWLEDGE_CEILINGS.excerptBytes
            || !integer(source.startLine) || source.startLine < 1 || !integer(source.endLine) || source.endLine < source.startLine
            || typeof source.score !== 'number' || !Number.isFinite(source.score) || source.score < 0 || source.score > 1) {
            throw Error('Сервер вернул неподтверждённую цитату. Повторите поиск.');
        }
        ids.add(source.id);
        return {id:source.id, path:source.path, startLine:source.startLine, endLine:source.endLine, excerpt:source.excerpt, score:source.score};
    });
    const accepted = admission(value.admission);
    return {mode:'text', projectId, revision:value.revision, corpusHash:value.corpusHash, sources, ...(accepted ? {admission:accepted} : {})};
}
