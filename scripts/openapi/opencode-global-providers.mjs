import {OPENCODE_GLOBAL_PROVIDERS_READ_JOB as READ,OPENCODE_GLOBAL_PROVIDERS_OPEN_JOB as OPEN,OPENCODE_GLOBAL_PROVIDERS_SCHEMAS as schemas} from '../../services/shared/opencode-local-providers.cjs';
const completion=(state,result)=>({type:'object',additionalProperties:false,required:['lease','state','message','result'],properties:{lease:{type:'string',format:'uuid'},state:{type:'string',enum:[state]},message:{type:'string',maxLength:1500},result}});

/** Public metadata schemas share runtime field ownership; auth file contents never cross this API. */
export const globalProvidersSchemas={GlobalProvidersRequest:schemas.request,GlobalProvidersReadPayload:schemas.payloadRead,GlobalProvidersOpenPayload:schemas.payloadOpen,
    GlobalProvidersInventory:schemas.inventory,GlobalProvidersResult:schemas.results,
    GlobalProvidersCompletion:{oneOf:[completion('succeeded',{oneOf:schemas.results.oneOf.slice(0,2)}),completion('failed',schemas.results.oneOf[2]),completion('failed',{type:'object',additionalProperties:false,maxProperties:0})]}};

export function describeGlobalProviders(operation,path,http){
    if(path==='/api/device-jobs'&&http==='post'){
        const json=operation.requestBody?.content?.['application/json'];
        if(json)json.schema={oneOf:[{allOf:[json.schema,{type:'object',properties:{kind:{not:{enum:[READ,OPEN]}}}}]},{$ref:'#/components/schemas/GlobalProvidersRequest'}]};
        operation['x-neurocenter-job-kind-contracts']={...operation['x-neurocenter-job-kind-contracts'],...Object.fromEntries([READ,OPEN].map(kind=>[kind,{
            request:{$ref:'#/components/schemas/GlobalProvidersRequest'},payload:{$ref:'#/components/schemas/'+(kind===READ?'GlobalProvidersReadPayload':'GlobalProvidersOpenPayload')},
            result:{$ref:'#/components/schemas/GlobalProvidersResult'},completion:{$ref:'#/components/schemas/GlobalProvidersCompletion'}}]))};
        operation.description=(operation.description?operation.description+'\n\n':'')+'Global OpenCode provider setup belongs to the current owned computer before a project is chosen. Inspection returns bounded provider/model IDs and authentication presence/kind only; no secrets or local paths. Read-only inventory and accepted receipts survive feature OFF, subject to current account/device roles. Opening requires current write roles, computer_setup and computer_connections. Only an expiring private loopback window reads/changes auth.json or configuration; secrets never enter Catalog. Browser input cannot specify a deadline, path, command or key. A lost accepted opening is reconciled by request/job identity rather than replayed as a new window.';
    }
    if(path==='/api/device-channel/jobs/{id}/complete'&&http==='post')operation['x-neurocenter-job-kind-contracts']={...operation['x-neurocenter-job-kind-contracts'],[READ]:{$ref:'#/components/schemas/GlobalProvidersCompletion'},[OPEN]:{$ref:'#/components/schemas/GlobalProvidersCompletion'}};
    if(path==='/api/device-channel/opencode-global-providers/authorize'&&http==='post'){
        operation.requestBody={required:true,content:{'application/json':{schema:{type:'object',additionalProperties:false,required:['jobId'],properties:{jobId:{type:'string',format:'uuid'}}}}}};
        operation.description='A private local provider window obtains fresh current account/device/role/feature authority for its exact unexpired opening job before each local read or save. This route never receives provider secrets or file contents.';
        operation.responses['200']={description:'Current authority for this exact private local opening.',content:{'application/json':{schema:{type:'object',additionalProperties:false,required:['ok','expiresAt'],properties:{ok:{type:'boolean',enum:[true]},expiresAt:{type:'string',format:'date-time'}}}}}};
    }
    return operation;
}
