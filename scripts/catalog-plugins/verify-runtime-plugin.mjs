import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const plain=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const callableHooks=new Set(['event','config','chat.message','chat.params','chat.headers','permission.ask','command.execute.before',
    'tool.execute.before','tool.execute.after','shell.env','experimental.chat.messages.transform','experimental.chat.system.transform',
    'experimental.session.compacting','experimental.text.complete','tool.definition']);
const fail=code=>{const error=new Error(code);error.verificationCode=code;throw error;};

function validateHooks(hooks) {
    if(!plain(hooks))fail('plugin-invalid-hooks');
    let count=0,tools=0;
    for(const [name,value] of Object.entries(hooks)) {
        if(callableHooks.has(name)&&typeof value==='function'){count++;continue;}
        if(name==='tool'&&plain(value)) {
            for(const definition of Object.values(value)) {
                if(!plain(definition)||typeof definition.execute!=='function'||typeof definition.description!=='string'||!plain(definition.args))fail('plugin-invalid-hooks');
                tools++;count++;
            }
            continue;
        }
        if(name==='auth'&&plain(value)&&typeof value.provider==='string'&&value.provider.trim()&&Array.isArray(value.methods)&&value.methods.length) {
            if(value.loader!==undefined&&typeof value.loader!=='function')fail('plugin-invalid-hooks');
            for(const method of value.methods)if(!plain(method)||!['oauth','api'].includes(method.type)||typeof method.label!=='string'
                ||method.authorize!==undefined&&typeof method.authorize!=='function'||method.type==='oauth'&&typeof method.authorize!=='function')fail('plugin-invalid-hooks');
            count++;continue;
        }
        fail('plugin-invalid-hooks');
    }
    if(!count)fail('plugin-no-hooks');
    return {hooks:count,tools};
}

/** Real-shaped SDK inputs expose only read-only fixture responses, no provider sessions or mutating client APIs. */
function pluginInput(directory,home) {
    const project={id:'runtime-verification',worktree:directory,vcs:'git',time:{created:0,updated:0}};
    const response=data=>async()=>({data});
    const client={app:{log:response(undefined)},config:{get:response({provider:{},mcp:{},plugin:[]})},
        project:{current:response(project),list:response([project])},path:{get:response({home,config:path.join(home,'config'),worktree:directory,directory})},session:{list:response([])}};
    const shell=()=>fail('plugin-shell-unavailable');shell.cwd=()=>shell;shell.env=()=>shell;shell.quiet=()=>shell;
    return {client,project,directory,worktree:directory,serverUrl:new URL('http://127.0.0.1:9'),$:shell};
}

/** This runner is copied into the disposable OS sandbox; only bounded enum/count results cross fd 3. */
async function main() {
    let result;
    try {
        const [entrypoint,directory,home]=process.argv.slice(2),mod=await import(pathToFileURL(entrypoint).href);
        const factories=[],seen=new Set();
        for(const value of Object.values(mod)) {
            if(seen.has(value))continue;seen.add(value);
            const factory=typeof value==='function'?value:plain(value)&&typeof value.id==='string'&&value.id.trim()&&typeof value.server==='function'&&value.tui===undefined?value.server:undefined;
            if(!factory)fail('plugin-invalid-export');factories.push(factory);
        }
        if(!factories.length||factories.length>32)fail('plugin-invalid-export');
        let hooks=0,tools=0;
        for(const factory of factories) {
            const counts=validateHooks(await factory(pluginInput(directory,home),undefined));hooks+=counts.hooks;tools+=counts.tools;
            if(hooks>1000||tools>1000)fail('plugin-invalid-hooks');
        }
        result={schemaVersion:1,ok:true,hooks,tools};
    } catch(error) {
        const known=new Set(['plugin-invalid-export','plugin-invalid-hooks','plugin-no-hooks','plugin-shell-unavailable']);
        result={schemaVersion:1,ok:false,code:known.has(error?.verificationCode)?error.verificationCode:
            ['ERR_MODULE_NOT_FOUND','MODULE_NOT_FOUND'].includes(error?.code)?'plugin-dependency-missing':'plugin-initialization-failed'};
    }
    fs.writeSync(3,JSON.stringify(result)+'\n');
    // Flush the report before terminating factory-owned watchers/timers. Linux PID ownership or Darwin fork denial bounds all package processes.
    process.exit(result.ok?0:1);
}
await main();
