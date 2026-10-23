'use strict';

const RAG_WRITE_AUTHORIZATION_PROTOCOL='rag-write-authorization-v1';
const RAG_WRITE_POLICY='fresh-project-writer-v1';
const RAG_LEGACY_WRITE_POLICY='legacy-receipt-only-v1';
const RAG_WRITE_AUTHORIZATION_REQUIRED='RAG_WRITE_AUTHORIZATION_REQUIRED';

/** Both services must understand the phase: an old generic grant cannot authorize a first write. */
function validRagWriteGrant(value,phase){
    return !!value&&typeof value==='object'&&!Array.isArray(value)&&value.ok===true
        &&value.protocol===RAG_WRITE_AUTHORIZATION_PROTOCOL&&value.phase===phase;
}

/** A denied new admission says nothing about a previously dispatched request's eventual COMMIT. */
function ragWriteAdmissionUncertain(value){
    return !!value&&typeof value==='object'&&[RAG_WRITE_AUTHORIZATION_REQUIRED,'feature-disabled'].includes(value.code);
}

module.exports={RAG_WRITE_AUTHORIZATION_PROTOCOL,RAG_WRITE_POLICY,RAG_LEGACY_WRITE_POLICY,RAG_WRITE_AUTHORIZATION_REQUIRED,validRagWriteGrant,ragWriteAdmissionUncertain};
