import {TEXT_KNOWLEDGE_LIMITS,TEXT_KNOWLEDGE_CEILINGS} from '../../services/shared/project-text-knowledge.cjs';

/** Runtime UTF-8 limits are byte bounds, not JSON Schema character-count approximations. */
export function describeProjectText(operation,path,http){
    if(!/^\/api\/projects\/\{id\}\/knowledge\/text(?:\/|$)/.test(path))return operation;
    operation.description=(operation.description?operation.description+'\n\n':'')+'Explicit text knowledge on PostgreSQL. No embedding/model call, asset download, plugin or local index is required. Project authority is checked independently from feature configuration. Semantic profile, dimensions and generations remain unchanged.';
    operation.description+=' Effective product limits come from GET /api/runtime-limits. Accepted receipts retain their admission snapshot; structural ceilings permit exact recovery after a later limit reduction.';
    if(http==='get')operation.description+=' State and exact own upload receipts remain readable when project_text_knowledge is OFF.';
    else operation.description+=' New operations require project_text_knowledge, independent from model_hosting.';
    if(path.endsWith('/documents')){
        operation.description+=' Upload upserts the exact supplied paths without deleting absent files. expectedRevision is a whole-corpus CAS; requestKey binds the exact ordered file names/content bytes. A committed receipt is returned before new-write feature checks. Lost ACK must be recovered with that same key, never a new guessed upload.';
        operation['x-neurocenter-utf8-limits']=TEXT_KNOWLEDGE_LIMITS;
        operation['x-neurocenter-utf8-ceilings']=TEXT_KNOWLEDGE_CEILINGS;
        const schema=operation.requestBody?.content?.['application/json']?.schema;
        if(schema?.properties?.documents)schema.properties.documents={...schema.properties.documents,minItems:1,maxItems:TEXT_KNOWLEDGE_CEILINGS.documents,
            description:`UTF-8 text only. Effective limits are revisioned product policy. Supported ceilings: ${TEXT_KNOWLEDGE_CEILINGS.fileBytes} bytes/file, ${TEXT_KNOWLEDGE_CEILINGS.batchBytes} bytes/batch including paths, ${TEXT_KNOWLEDGE_CEILINGS.pathBytes} UTF-8 bytes/path. Paths are relative and unique. Binary control characters and invalid Unicode are refused.`};
    }
    if(path.endsWith('/search'))operation.description+=` Word search applies the effective policy, within ceilings of ${TEXT_KNOWLEDGE_CEILINGS.sources} citations and ${TEXT_KNOWLEDGE_CEILINGS.excerptBytes} UTF-8 bytes per excerpt, with exact source paths/line ranges and one consistent revision/corpusHash. Optional revision conflicts rather than silently searching a changed corpus. Query ceiling: ${TEXT_KNOWLEDGE_CEILINGS.queryBytes} UTF-8 bytes. A caller cannot supply an admission/limits override.`;
    operation.responses['409']={description:'Request key conflict, stale corpus revision or unavailable accepted context.'};
    return operation;
}
