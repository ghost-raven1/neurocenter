import {createHash} from 'node:crypto';

const effectNames=['read','execute','write','network','delegate'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);

/** Role capabilities describe an authorized assignment; they never grant additional user permission. */
export function roleContract(role){
    if(!object(role)||typeof role.id!=='string'||!/^[a-z][a-z0-9-]{1,47}$/.test(role.id)||!['read','write','coordinate'].includes(role.mode))
        throw Error('Invalid role contract source.');
    const base={read:true,execute:role.mode!=='read',write:role.mode!=='read',network:role.mode!=='read',delegate:role.mode!=='read'};
    const effects={...base};
    if(Object.hasOwn(role,'effects')){
        if(!object(role.effects)||Object.entries(role.effects).some(([key,value])=>!effectNames.includes(key)||typeof value!=='boolean'))
            throw Error('Invalid role capability override.');
        for(const [key,value]of Object.entries(role.effects)){
            if(value&&!base[key])throw Error('Role capability cannot escalate its mode.');
            effects[key]=value;
        }
    }
    return {schemaVersion:1,roleId:role.id,mode:role.mode,sourceSha256:createHash('sha256').update(JSON.stringify(role)).digest('hex'),effects,authority:'user-authorized-task',
        networkMeaning:'explicit-network-effect-not-read-tool-transport',ownership:'assigned-files-and-resources',
        result:{evidence:'observed-artifact-and-revision',unknown:'preserve',outcome:role.outcome??null},
        enforcement:{codex:'instruction-only',opencode:{builtins:role.mode==='read'?{edit:'deny',bash:'deny',task:'deny'}:{},
            mcpEffects:'unverified'},effectivePermissions:'unknown'}};
}

/** Startup flag controls additional diagnostics and new role evaluations, not historical file access. */
export function roleContractsEnabled(environment=process.env){
    const value=environment.NEUROCENTER_AGENT_ROLE_CONTRACTS;
    if(value!==undefined&&!['0','1'].includes(value))throw Error('NEUROCENTER_AGENT_ROLE_CONTRACTS must be 0 or 1.');
    return value!=='0';
}

/** Keep one compact authority statement in all adapters without inventing client configuration fields. */
export function roleContractInstruction(role,target){
    if(!['skill','codex','opencode'].includes(target))throw Error('Unknown role contract target.');
    const contract=roleContract(role),ledger=effectNames.map(name=>name+'='+contract.effects[name]).join(', ');
    const enforcement=target==='codex'?'Codex: instruction-only; effective runtime permissions are unknown.'
        :target==='opencode'?(role.mode==='read'?'OpenCode: edit/bash/task deny are configured; MCP effects remain unverified.'
            :'OpenCode: client permissions apply; MCP effects remain unverified.')
            :'Runtime enforcement depends on the client; loading these instructions does not prove active permissions.';
    return `Role contract neurocenter-${role.id}: ${ledger}. These are capabilities within the user-authorized assignment, not independent authorization.\n`
        +'Network means initiating an operation with network effects, not the transport of an existing read-only tool. Work only on assigned files/resources.\n'
        +'Return the observed artifact/path and revision, the result and unresolved limits; do not promote a plan, another revision or an unexecuted test to evidence.\n'
        +'A handoff or follow-up cannot widen the target role: assign execution to an appropriate authorized worker instead of overriding a read-only reviewer.\n'
        +enforcement;
}

/** Bounded public diagnostics separate declarative capability from loaded/effective runtime state. */
export function summarizeRoleContracts(roles){
    if(!Array.isArray(roles)||roles.length!==64)throw Error('Expected the complete 64-role catalogue.');
    const contracts=roles.map(roleContract);
    if(new Set(contracts.map(contract=>contract.roleId)).size!==64)throw Error('Expected unique role contracts.');
    return {schemaVersion:1,roles:contracts.length,effectivePermissions:'unknown',loadedRoles:'unverified',
        enforcement:{codex:'instruction-only',opencodeReadBuiltins:'deny-configured',mcpEffects:'unverified'},
        contracts:contracts.map(({roleId,mode,effects})=>({roleId,mode,effects})),
        limits:['Capabilities require a user-authorized assignment; generated or installed files do not establish loaded roles or effective client permissions.',
            'OpenCode read-role edit/bash/task deny settings do not establish a deny for every MCP tool.']};
}
