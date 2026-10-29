import instance from '../../core/api/base';
import type {TextUpload} from './model';
import {requireCorpus, requireReceipt, requireSearch} from './model';
import {normalizeTextSearch, normalizeTextUpload, TEXT_KNOWLEDGE_CEILINGS} from '@neurocenter/project-text-knowledge';
import {defaultTextKnowledgeLimits, requireTextLimitsDecision, type TextLimitsDecision} from './limits';

const path = (projectId:string) => `/api/projects/${encodeURIComponent(projectId)}/knowledge/text`;
export const projectTextApi = {
    limits: async (signal?:AbortSignal):Promise<TextLimitsDecision> => {
        try { return requireTextLimitsDecision((await instance.get('/api/runtime-limits', {signal})).data); }
        catch (error) {
            if ((error as {response?:{status?:number}} | null)?.response?.status === 404)
                return {revision:0, limits:defaultTextKnowledgeLimits, legacy:true};
            throw error;
        }
    },
    state: async (projectId:string, signal?:AbortSignal) => requireCorpus((await instance.get(path(projectId), {signal})).data, projectId),
    upload: async (projectId:string, body:TextUpload, signal?:AbortSignal) => requireReceipt((await instance.post(`${path(projectId)}/documents`, normalizeTextUpload(body, TEXT_KNOWLEDGE_CEILINGS), {signal})).data, projectId),
    receipt: async (projectId:string, requestKey:string, signal?:AbortSignal) => {
        const value:unknown = (await instance.get(`${path(projectId)}/requests/${encodeURIComponent(requestKey)}`, {signal})).data;
        return value === null ? null : requireReceipt(value, projectId);
    },
    search: async (projectId:string, query:string, revision:number, signal?:AbortSignal) =>
        requireSearch((await instance.post(`${path(projectId)}/search`, normalizeTextSearch({query, revision}, TEXT_KNOWLEDGE_CEILINGS), {signal})).data, projectId),
};
export type ProjectTextApi = typeof projectTextApi;
