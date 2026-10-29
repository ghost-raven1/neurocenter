import {OPENCODE_CLI_INSPECT_JOB,OPENCODE_CLI_SCHEMAS} from '../../services/shared/computer-setup.cjs';

const observed=statuses=>({oneOf:OPENCODE_CLI_SCHEMAS.observation.oneOf.flatMap(branch=>{
    const accepted=branch.properties.status.enum.filter(status=>statuses.includes(status));
    return accepted.length?[{...branch,properties:{...branch.properties,status:{type:'string',enum:accepted}}}]:[];
})});
const completion=(state,result)=>({type:'object',required:['lease','state','message','result'],properties:{lease:{type:'string',format:'uuid'},
    state:{type:'string',enum:[state]},message:{type:'string',maxLength:1500,description:'Untrusted worker text is ignored; the server stores a fixed message.'},result}});

/** Shared runtime patterns define the fixed kind; generic failures preserve the existing worker completion ABI. */
export const computerSetupSchemas={
    OpenCodeCliRequest:OPENCODE_CLI_SCHEMAS.request,
    OpenCodeCliPayload:OPENCODE_CLI_SCHEMAS.payload,
    OpenCodeCliObservation:OPENCODE_CLI_SCHEMAS.observation,
    OpenCodeCliCompletion:{description:'For an inspect-opencode-cli job: installed/missing succeed; failed/timed-out fail. An empty failed result denotes a worker/transport failure before observation and proves no CLI readiness.',
        oneOf:[completion('succeeded',observed(['installed','missing'])),completion('failed',observed(['failed','timed-out'])),
            completion('failed',{type:'object',additionalProperties:false,maxProperties:0})]},
};

/** Enrich only this assigned job kind while retaining the schemas of all existing consumers. */
export function describeComputerSetup(operation,path,http){
    if(path==='/api/device-jobs'&&http==='post'){
        const json=operation.requestBody?.content?.['application/json'];
        if(json)json.schema={oneOf:[{allOf:[json.schema,{type:'object',properties:{kind:{not:{enum:[OPENCODE_CLI_INSPECT_JOB]}}}}]},{$ref:'#/components/schemas/OpenCodeCliRequest'}]};
        operation.description=(operation.description?operation.description+'\n\n':'')+'inspect-opencode-cli observes the selected owned computer before any project or folder is chosen. Both the active role and device role require level 1 or higher with current account/project membership authority. The bridge must advertise opencode-cli-v1. New admission requires computer_setup (depending on computer_connections). An exact accepted request is returned before feature checks; a changed request under the same key conflicts. History, request receipts and cancellation remain available when OFF. No command, arguments, path or credential fields are accepted.';
        operation['x-neurocenter-job-kind-contracts']={[OPENCODE_CLI_INSPECT_JOB]:{request:{$ref:'#/components/schemas/OpenCodeCliRequest'},
            observation:{$ref:'#/components/schemas/OpenCodeCliObservation'},completion:{$ref:'#/components/schemas/OpenCodeCliCompletion'},
            errors:{'400':['computer-setup-invalid-request'],'403':['computer-setup-access-denied','feature-disabled'],
                '409':['computer-setup-upgrade-required','computer-setup-invalid-context','computer-setup-authority-changed','computer-setup-invalid-receipt','computer-setup-receipt-conflict','computer-setup-not-running']}}};
        operation.responses['409']={description:'Request key conflicts, the bridge lacks the capability, or current computer/job authority changed.',content:{'application/json':{schema:{$ref:'#/components/schemas/ApiError'}}}};
        operation.responses['429']={description:'The selected computer already has 100 active queued/running/reconciling jobs.'};
        operation.responses['503']={description:'Current feature or authority dependencies could not be verified; no new job is admitted.'};
    }
    if(path==='/api/device-channel/jobs/{id}/complete'&&http==='post'){
        operation['x-neurocenter-job-kind-contracts']={[OPENCODE_CLI_INSPECT_JOB]:{$ref:'#/components/schemas/OpenCodeCliCompletion'}};
        operation.description=(operation.description?operation.description+'\n\n':'')+'inspect-opencode-cli accepts a strict observation for this exact device/job, or failed {} when the worker never obtained an observation. The first completion rechecks current account, device and role grants. An accepted terminal/cancelled lease may replay only an ACK using the current device token hash and exact device owner/job/lease/kind, without another execution or result read. Token rotation, another device/lease and deleted or reset-retired jobs fail closed. A late ACK for a cancelled job cannot replace cancellation. Feature OFF does not reject an accepted receipt. Raw stdout/stderr and local paths never enter the stored result or message.';
    }
    return operation;
}
