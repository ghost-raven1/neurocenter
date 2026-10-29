import {OPENCODE_CLI_INSTALL_JOB,OPENCODE_CLI_INSTALL_SCHEMAS as schemas} from '../../services/shared/opencode-cli-install.cjs';
const completion=(state,result)=>({type:'object',additionalProperties:false,required:['lease','state','message','result'],properties:{lease:{type:'string',format:'uuid'},state:{type:'string',enum:[state]},message:{type:'string',maxLength:1500},result}});

/** Fixed installation uses the same published supply identity and strict fields as runtime admission. */
export const openCodeCliInstallSchemas={OpenCodeCliInstallRequest:schemas.request,OpenCodeCliInstallSupply:schemas.supply,OpenCodeCliInstallPayload:schemas.payload,OpenCodeCliInstallResult:schemas.result,
    OpenCodeCliInstallCompletion:{oneOf:[completion('succeeded',schemas.success),completion('failed',schemas.failure),completion('failed',{type:'object',additionalProperties:false,maxProperties:0})]}};

export function describeOpenCodeCliInstall(operation,path,http){
    if(path==='/api/device-jobs'&&http==='post'){
        const json=operation.requestBody?.content?.['application/json'];
        if(json)json.schema={oneOf:[{allOf:[json.schema,{type:'object',properties:{kind:{not:{enum:[OPENCODE_CLI_INSTALL_JOB]}}}}]},{$ref:'#/components/schemas/OpenCodeCliInstallRequest'}]};
        operation['x-neurocenter-job-kind-contracts']={...operation['x-neurocenter-job-kind-contracts'],[OPENCODE_CLI_INSTALL_JOB]:{
            request:{$ref:'#/components/schemas/OpenCodeCliInstallRequest'},payload:{$ref:'#/components/schemas/OpenCodeCliInstallPayload'},result:{$ref:'#/components/schemas/OpenCodeCliInstallResult'},completion:{$ref:'#/components/schemas/OpenCodeCliInstallCompletion'}}};
        operation.description=(operation.description?operation.description+'\n\n':'')+'install-opencode-cli requires the selected owned online bridge, current user/device write roles (level >=2), computer_setup and opencode-cli-install-v1. The server pins the bridge build, target, fixed CLI version and SHA. Browser commands, paths, provider keys and source overrides are rejected. The bridge copies its verified bundled CLI atomically without replacing an existing user CLI or modifying auth/config/profile files. Existing CLI and ordinary PATH readiness are separate measured results. Request replay, history, cancellation and receipt recovery remain readable when OFF. Unknown publication requires inspection; generic retry never copies again.';
    }
    if(path==='/api/device-channel/jobs/{id}/complete'&&http==='post'){
        operation['x-neurocenter-job-kind-contracts']={...operation['x-neurocenter-job-kind-contracts'],[OPENCODE_CLI_INSTALL_JOB]:{$ref:'#/components/schemas/OpenCodeCliInstallCompletion'}};
    }
    return operation;
}
