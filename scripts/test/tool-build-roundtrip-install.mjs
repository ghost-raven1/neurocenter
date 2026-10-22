import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

/** Installation runs in its own bridge profile and bound folder, never the user's project. */
const dist=process.env.TOOL_BUILD_BRIDGE_DIST,root=process.env.TOOL_BUILD_ROUNDTRIP_HOME;
if(!dist||!path.isAbsolute(dist)||!root||!path.isAbsolute(root)||!process.send)throw Error('Explicit bridge candidate, private folder and IPC owner are required');
const load=relative=>import(pathToFileURL(path.join(dist,relative)).href);
const {writeState,jobContext}=await load('bridge/state.js');
const {setRoot,bindProject,projectFolder}=await load('bridge/workspace.js');
const {prepareJobRuntimeArtifacts}=await load('bridge/job-runtime-artifacts.js');
const {install}=await load('bridge/installer.js');
const projectId='prj-owned-package-roundtrip';
const folders=path.join(root,'projects'),folder=path.join(folders,'bound-project');
await mkdir(folder,{recursive:true});await setRoot(folders);
let bound=false;
process.on('message',message=>{
    if(message?.type==='stop'){if(process.connected)process.disconnect();return;}
    if(message?.type!=='install')return;
    void(async()=>{
        try{
            const {credentials,job,pkg}=message;
            await writeState('credentials',credentials);
            if(!bound){await bindProject(projectId,'bound-project');bound=true;}
            assert.equal(await projectFolder(projectId),folder);
            let authorizationChecks=0;
            const authorize=async()=>{authorizationChecks++;};
            const result=await jobContext.run(job,async()=>{
                await prepareJobRuntimeArtifacts([pkg],authorize,async()=>{});
                return install(projectId,pkg,authorize,async()=>{});
            });
            const config=JSON.parse(await readFile(path.join(folder,'opencode.json'),'utf8'));
            const managed=config.plugin.filter(value=>typeof value==='string'&&value.startsWith('file:'));
            assert.equal(managed.length,1);
            const entry=new URL(managed[0]);entry.searchParams.set('owned-roundtrip',message.id);
            const plugin=await import(entry.href);
            const hooks=await plugin.default({directory:folder}),output={system:[]};
            await hooks['experimental.chat.system.transform']({},output);
            process.send?.({type:'response',id:message.id,ok:true,value:{result,config,hookOutput:output.system,authorizationChecks}});
        }catch(error){process.send?.({type:'response',id:message.id,ok:false,error:{message:String(error?.message??'Install failed').slice(0,1000)}});}
    })();
});
process.send({type:'ready',pid:process.pid});
