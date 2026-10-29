const object=(properties,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const integer=minimum=>({type:'integer',minimum,maximum:Number.MAX_SAFE_INTEGER});
const sha={type:'string',pattern:'^[a-f0-9]{64}$'},key={type:'string',format:'uuid',pattern:'^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$'};
const identity={providerId:sha,expectedConnectionRevision:integer(1),expectedCredentialRevision:integer(0),requestKey:key};
const receipt=object({modelId:{type:'string'},providerId:sha,requestKey:key,requestHash:sha,connectionRevision:integer(1),credentialRevision:integer(1),hasKey:{type:'boolean'},acceptedAt:{type:'string',format:'date-time'}});
export const PERSONAL_PROVIDER_SCHEMAS={
    save:object({...identity,apiKey:{type:'string',minLength:1,maxLength:8192,pattern:'^[^\\x00-\\x20\\x7f]+$',writeOnly:true}}),remove:object(identity),receipt,
    view:object({modelId:{type:'string'},providerId:sha,providerUrl:{type:'string',format:'uri'},connectionRevision:integer(1),authMode:{type:'string',enum:['none','optional','required']},
        credentialRevision:integer(0),hasKey:{type:'boolean'},updatedAt:{type:'string',format:'date-time',nullable:true},canStoreKey:{type:'boolean'},legacySharedKeyRetained:{type:'boolean'}}),
};
/** Browser-owned secrets never enter common model descriptors, provider status, prompts or exported assets. */
export function describeRemoteProviderAccess(operation,path,http){
    if(path==='/api/models/{id}/connection'){
        operation.description=(operation.description?operation.description+'\n\n':'')+'The administrator configures the provider recipient and authorization mode. Saving does not invoke the model. Personal keys are configured through my-access; shared apiKey and credentialEnv writes are rejected. Historical shared credential metadata can remain readable, but is never an inference fallback.';
        if(http==='put'){
            const schema=operation.requestBody?.content?.['application/json']?.schema;
            if(schema?.properties){
                delete schema.properties.apiKey;delete schema.properties.credentialEnv;
                schema.properties.authMode={type:'string',enum:['none','optional','required'],description:'none omits Authorization; optional uses the current user key when present; required needs the current user key before inference.'};
                schema.properties.credential={type:'string',enum:['none'],deprecated:true,description:'Legacy anonymous input only. Prefer authMode. No shared credential is stored.'};
                schema.required=(schema.required??[]).filter(name=>!['credential','authMode'].includes(name));
                schema.anyOf=[{required:['authMode']},{required:['credential']}];schema.additionalProperties=false;
            }
        }
        for(const response of Object.values(operation.responses)){
            const schema=response.content?.['application/json']?.schema;
            if(schema?.properties?.authMode)schema.required=[...new Set([...(schema.required??[]),'authMode'])];
        }
        return operation;
    }
    if(!/^\/api\/models\/\{id\}\/my-access(?:\/|$)/.test(path))return operation;
    operation.description=(operation.description?operation.description+'\n\n':'')+'Personal access to the server-configured remote provider. The authenticated actor owns the key; callers cannot select another owner, role or provider URL. '+
        'none never sends Authorization, optional permits anonymous requests without a personal key, required rejects before wire until My Access is configured. No shared administrator/environment credential fallback is used. '+
        'Keys are encrypted at rest and write-only. Model pins and embedding profiles never contain the key or its revision. No model request is made by these settings endpoints.';
    if(['put','delete'].includes(http))operation.requestBody={required:true,content:{'application/json':{schema:http==='put'?PERSONAL_PROVIDER_SCHEMAS.save:PERSONAL_PROVIDER_SCHEMAS.remove}}};
    const requestReceipt=path.includes('/requests/'),schema=requestReceipt?{...receipt,nullable:true}:['put','delete'].includes(http)?receipt:PERSONAL_PROVIDER_SCHEMAS.view;
    const code=Object.keys(operation.responses).find(value=>/^2\d\d$/.test(value))??'200';
    operation.responses[code]={description:requestReceipt?'Own masked accepted receipt, or null when not found.':'Validated personal status or masked accepted mutation receipt.',content:{'application/json':{schema}}};
    operation.security=[{sessionCookie:[]}];
    operation.description+=' UUID replay binds provider/connection/credential revisions and the exact action and secret. Accepted own receipts remain readable when the feature is OFF; null does not prove a pending mutation cannot commit. A 403 after COMMIT can leave a valid own receipt: preserve the original UUID until recovery.';
    operation.responses['403']={description:'Fresh role/model authority denied, or new personal work disabled; a committed mutation may require later own receipt recovery.'};
    operation.responses['409']={description:'Provider or credential CAS changed, or same UUID refers to different mutation bytes.'};
    return operation;
}
