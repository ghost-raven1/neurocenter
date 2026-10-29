import {RUNTIME_LIMIT_CEILINGS} from '../../services/shared/runtime-limits.cjs';
const object=(properties,required=Object.keys(properties))=>({type:'object',additionalProperties:false,properties,required});
const integer=(minimum=0,maximum=Number.MAX_SAFE_INTEGER)=>({type:'integer',minimum,maximum});
const group=values=>object(Object.fromEntries(Object.entries(values).map(([key,max])=>[key,integer(1,max)])));
const policy=object({textKnowledge:group(RUNTIME_LIMIT_CEILINGS.textKnowledge),ggufImport:group(RUNTIME_LIMIT_CEILINGS.ggufImport)});
const key={type:'string',format:'uuid',pattern:'^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$'};
const receipt=object({requestKey:key,requestHash:{type:'string',pattern:'^[a-f0-9]{64}$'},revision:integer(1),policy,acceptedAt:{type:'string',format:'date-time'}});
const view=object({revision:integer(),policy,ceilings:policy,updatedAt:{type:'string',format:'date-time',nullable:true}});
export const RUNTIME_LIMIT_SCHEMAS={policy,view,admin:object({...view.properties,configurationEnabled:{type:'boolean'}}),
    input:object({expectedRevision:integer(),requestKey:key,policy}),receipt};

/** Policy bounds are supported ceilings; the effective GET determines product admission for each new operation. */
export function describeRuntimeLimits(operation,path,http){
    if(!/^\/api\/runtime-limits(?:\/|$)/.test(path))return operation;
    const admin=path!=='/api/runtime-limits';
    operation.description=(operation.description?operation.description+'\n\n':'')+(admin
        ?'Browser MainAdmin authority is rechecked on each request. Configuration uses fresh SQL authority, revision CAS, atomic audit and an actor-scoped immutable request receipt. '
        :'Authenticated users read a sanitized effective policy with its revision and supported technical ceilings. No credentials, local paths or model invocation are included. ');
    operation.description+='Accepted operations retain their admission snapshot; current limits apply to new operations. Disabling runtime_limit_configuration preserves the saved effective policy and own receipt recovery.';
    if(http==='patch'){
        operation.requestBody={required:true,content:{'application/json':{schema:RUNTIME_LIMIT_SCHEMAS.input}}};
        operation.description+=' A committed exact replay is returned before new-save feature checks. Reusing a key with different policy/revision returns 409. After an unconfirmed 503, read the receipt or explicitly replay the identical request; a missing receipt does not prove the previous request cannot commit.';
    }
    const schema=path.includes('/requests/')||http==='patch'?receipt:admin?RUNTIME_LIMIT_SCHEMAS.admin:view;
    const code=Object.keys(operation.responses).find(value=>/^2\d\d$/.test(value))??'200';
    operation.responses[code]={description:'Validated effective policy or exact accepted configuration receipt.',content:{'application/json':{schema}}};
    if(admin)operation.security=[{sessionCookie:[]}];
    operation.responses['409']={description:'Stale expectedRevision or changed intent under the same writer/requestKey.'};
    operation.responses['503']={description:'Policy unavailable, or save outcome unconfirmed; draft and original requestKey must be retained.'};
    return operation;
}
