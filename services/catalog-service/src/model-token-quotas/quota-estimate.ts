import {createHash} from 'node:crypto';
import type {IModel} from '../models/model.types';
import {MODEL_TOKEN_QUOTA_DEFAULT_OUTPUT_ESTIMATE,MODEL_TOKEN_QUOTA_ESTIMATE_VERSION,type ModelTokenQuotaEstimate} from './model-token-quotas.types';
import {quotaCoverage} from './model-token-quotas.model';

const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
/** This is an admission estimate, never a tokenizer, provider cap or reported actual usage. */
export function estimateModelTokens(model:IModel,endpoint:'chat'|'embed',body:Record<string,unknown>):ModelTokenQuotaEstimate{
    const bytes=Buffer.byteLength(JSON.stringify(body),'utf8'),messages=Array.isArray(body.messages)?body.messages.length:0;
    const inputTokens=Math.max(1,Math.ceil(bytes/2)+messages*6+3),options=object(body.options)?body.options:{};
    const limits=[body.max_tokens,body.max_completion_tokens,body.max_output_tokens,options.num_predict]
        .filter((n):n is number=>typeof n==='number'&&Number.isSafeInteger(n)&&n>0);
    const outputTokens=endpoint==='embed'?0:limits.length?Math.max(...limits):MODEL_TOKEN_QUOTA_DEFAULT_OUTPUT_ESTIMATE;
    return {version:MODEL_TOKEN_QUOTA_ESTIMATE_VERSION,inputTokens,outputTokens,totalTokens:inputTokens+outputTokens,
        outputBasis:endpoint==='embed'?'no-generated-output':limits.length?'configured-limit':'planning-default',
        modelPin:model.modelPin??model.verificationSha256??model.manifestSha256??null,
        requestDigest:createHash('sha256').update(JSON.stringify(body)).digest('hex'),supported:endpoint==='chat'&&quotaCoverage(model).managedText};
}
