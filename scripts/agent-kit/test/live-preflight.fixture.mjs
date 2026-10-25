import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {prepareLiveRun,cleanupLiveRun} from '../evals/live-runner.mjs';

// Test-only native CLI: metadata commands are implemented; every exec request is refused.
const required=['apps','plugins','hooks','shell_tool','browser_use','browser_use_external','computer_use','multi_agent','memories','chronicle','skill_search','workspace_dependencies','image_generation','in_app_browser','code_mode_host','remote_plugin'];
export async function fixtureRun(t){
    const source=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-live-preflight-fixture-'))),bin=path.join(source,'bin');
    await fs.mkdir(bin);
    await fs.writeFile(path.join(source,'config.toml'),'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "ultra"\n');
    await fs.writeFile(path.join(source,'auth.json'),'{"fixture":true}');
    const controls=path.join(source,'metadata.json'),calls=path.join(source,'calls.jsonl'),cli=path.join(bin,'codex');
    await fs.writeFile(controls,'{}');
    await fs.writeFile(cli,'#!'+process.execPath+'\n'+`const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),home=process.env.CODEX_HOME,control=JSON.parse(fs.readFileSync(${JSON.stringify(controls)},'utf8'));
fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({args,home,cwd:process.cwd()})+'\\n');
const config=fs.readFileSync(path.join(home,'config.toml'),'utf8'),kind=args[0]==='--version'?'version':args[0]==='features'?'features':args[0]==='mcp'?'mcp':args[1]==='models'?'catalog':args[1]==='prompt-input'?'prompt':'forbidden';
const read=name=>JSON.parse(config.match(new RegExp('^'+name+' = (.+)$','m'))[1]);
const values={version:'codex-cli fixture-1.0\\n',catalog:JSON.stringify({models:[{slug:'gpt-6.1-sol',supported_reasoning_levels:[{effort:'ultra'}]}]}),
features:${JSON.stringify(required)}.map(name=>name+' stable false').join('\\n')+'\\n',
mcp:JSON.stringify([{name:'eval_mock',enabled:true,disabled_reason:null,transport:{type:'stdio',command:read('command'),args:read('args'),env:null,env_vars:[],cwd:null},startup_timeout_sec:15,tool_timeout_sec:15,auth_status:'unsupported'}]),
prompt:JSON.stringify([{type:'message',role:'developer',content:[{type:'input_text',text:'<permissions instructions>\\nFilesystem sandboxing defines boundaries. \\x60sandbox_mode\\x60 is \\x60read-only\\x60: The sandbox only permits reading files.\\nApproval policy is currently never. Do not provide the sandbox_permissions.\\n</permissions instructions>'}]},
{type:'message',role:'user',content:[{type:'input_text',text:'<environment_context>\\n  <cwd>'+process.cwd()+'</cwd>\\n</environment_context>'}]},
{type:'message',role:'user',content:[{type:'input_text',text:args[2]}]}])};
const response=control[kind]||{},body=response.stdout??values[kind];if(kind==='forbidden')process.exit(99);
if(response.stderr)process.stderr.write(response.stderr);if(body!==undefined)process.stdout.write(body);process.exit(response.code??0);`,{mode:0o700});
    const previous={home:process.env.CODEX_HOME,path:process.env.PATH};process.env.CODEX_HOME=source;process.env.PATH=bin+path.delimiter+previous.path;
    const id='test-preflight-'+randomUUID(),plan=await prepareLiveRun(id),directory=path.dirname(plan.entries[0].directory);
    t.after(async()=>{
        try{await cleanupLiveRun(id);}catch{}
        await fs.rm(directory,{recursive:true,force:true});await fs.rm(source,{recursive:true,force:true});
        if(previous.home===undefined)delete process.env.CODEX_HOME;else process.env.CODEX_HOME=previous.home;
        if(previous.path===undefined)delete process.env.PATH;else process.env.PATH=previous.path;
    });
    return {id,plan,directory,source,bin,cli,controls,calls};
}
