import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {hash} from '../src/bridge/state.js';
import {projectBindingId,projectInstanceId} from '../src/bridge/workspace.js';
import {configureProjectAgents} from '../src/features/project-agents/index.js';
import {createProjectAgentsPayload,type ProjectAgent} from '../src/features/project-agents/contract.js';
import {workspaceFixture} from './bridge-fixture.js';

const binary=process.env.OPENCODE_AGENT_TEST_ENGINE;
const run=promisify(execFile);
/** Opt-in acceptance uses a verified pinned engine, a temporary HOME and a disposable project only. */
describe.runIf(!!binary)('Native OpenCode 1.14.48 agent acceptance',()=>{
 let fixture:Awaited<ReturnType<typeof workspaceFixture>>,env:NodeJS.ProcessEnv,bindingId:string,instanceId:string;
 const execute=async(...args:string[])=>{
  const directories=[path.join(env.HOME!,'config/opencode'),path.join(fixture.root,'.opencode')];
  for(const directory of directories)await fs.chmod(directory,0o500);
  try{const result=await run(binary!,args,{cwd:fixture.root,env,timeout:30000,maxBuffer:2*1024*1024});
   expect(result.stdout.trim(),result.stderr).not.toBe('');return result.stdout;
  }finally{for(const directory of directories)await fs.chmod(directory,0o700);}
 };
 beforeEach(async()=>{
  const expected=process.env.OPENCODE_AGENT_TEST_ENGINE_SHA256;
  expect(expected).toMatch(/^[a-f0-9]{64}$/);expect(hash(await fs.readFile(binary!))).toBe(expected);
  fixture=await workspaceFixture();const home=path.join(fixture.temporary,'native-home');await fs.mkdir(home);
  env=Object.fromEntries(Object.entries(process.env).filter(([key])=>! /^(?:OPENCODE_|XDG_|HOME$)|(?:_API_KEY|_ACCESS_TOKEN|_SECRET)$/.test(key)));
  Object.assign(env,{HOME:home,XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'data'),XDG_CACHE_HOME:path.join(home,'cache'),XDG_STATE_HOME:path.join(home,'state'),
   OPENCODE_DISABLE_MODELS_FETCH:'true',OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_DISABLE_DEFAULT_PLUGINS:'true',OPENCODE_DISABLE_LSP_DOWNLOAD:'true',
   NPM_CONFIG_OFFLINE:'true',NPM_CONFIG_IGNORE_SCRIPTS:'true',NPM_CONFIG_REGISTRY:'http://127.0.0.1:9'});
  const dependencies={'@opencode-ai/plugin':'1.14.48'};
  for(const directory of [path.join(home,'config/opencode'),path.join(fixture.root,'.opencode')]){
   await fs.mkdir(path.join(directory,'node_modules'),{recursive:true});await fs.chmod(path.join(directory,'node_modules'),0o500);
   await fs.writeFile(path.join(directory,'package.json'),JSON.stringify({private:true,dependencies}));
   await fs.writeFile(path.join(directory,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'':{dependencies}}}));
  }
  await fs.writeFile(path.join(home,'config/opencode/opencode.json'),JSON.stringify({mcp:{},plugin:[],enabled_providers:[],provider:{},lsp:false,formatter:false,autoupdate:false,snapshot:false,share:'disabled',permission:{'*':'deny'}}));
  expect((await execute('--version')).trim()).toBe('1.14.48');bindingId=await projectBindingId('test-project');instanceId=await projectInstanceId('test-project');
 });
 afterEach(async()=>{vi.unstubAllEnvs();if(fixture)await fs.rm(fixture.temporary,{recursive:true,force:true});});
 it('discovers every mode and exact prompt/settings, then disables, reenables and removes managed agents',async()=>{
  const agents:ProjectAgent[]=(['primary','subagent','all'] as const).map(mode=>({id:'agent-native-'+mode,slug:'nc-native-'+mode,version:1,enabled:true,
   description:'Native: "'+mode+'"',prompt:'Instructions for '+mode+'.\n---\nmodel: this stays in the prompt',mode,model:'provider/model',temperature:0.2,topP:0.9,steps:7,permission:{edit:'deny',bash:'ask'}}));
  const apply=(revision:number,desired=agents)=>configureProjectAgents(createProjectAgentsPayload({schemaVersion:1,projectId:'test-project',bindingId,instanceId,revision,agents:desired}),async()=>undefined,async()=>undefined);
  await apply(1);let config=JSON.parse(await execute('debug','config')) as {agent:Record<string,Record<string,unknown>>};let list=await execute('agent','list');
  for(const agent of agents){
   expect(list).toContain(agent.slug+' ('+agent.mode+')');
   expect(config.agent[agent.slug]).toMatchObject({name:agent.slug,description:agent.description,prompt:agent.prompt,mode:agent.mode,model:agent.model,temperature:0.2,top_p:0.9,steps:7,permission:{bash:'ask',edit:'deny'},disable:false});
  }
  await apply(2,agents.map((agent,index)=>({...agent,enabled:index!==0})));list=await execute('agent','list');expect(list).not.toContain(agents[0]!.slug);expect(list).toContain(agents[1]!.slug);
  config=JSON.parse(await execute('debug','config'));expect(config.agent[agents[0]!.slug]!.disable).toBe(true);
  const edited=agents.map((agent,index)=>({...agent,prompt:index===0?'Edited project instructions':agent.prompt}));await apply(3,edited);list=await execute('agent','list');expect(list).toContain(agents[0]!.slug);
  config=JSON.parse(await execute('debug','config'));expect(config.agent[agents[0]!.slug]!.prompt).toBe('Edited project instructions');
  await fs.writeFile(path.join(fixture.root,'.opencode/agents/manual.md'),'---\ndescription: User agent\nmode: subagent\n---\nManual instructions.\n');await apply(4,[]);
  list=await execute('agent','list');for(const agent of agents)expect(list).not.toContain(agent.slug);expect(list).toContain('manual (subagent)');
 },120000);
});
