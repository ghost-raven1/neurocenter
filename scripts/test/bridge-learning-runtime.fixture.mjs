import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash,randomUUID} from 'node:crypto';

// Executes only extracted compiled files and its pinned OpenCode against a disposable project.
const content=process.cwd(),directory=path.resolve(process.argv[2]);
assert.ok(directory.startsWith((await fs.realpath(os.tmpdir()))+path.sep),'Native runtime fixture must use an OS temporary directory.');
await fs.mkdir(directory,{recursive:true});
process.env.NEUROCENTER_BRIDGE_HOME=path.join(directory,'private');
process.env.NEUROCENTER_URL='http://127.0.0.1:1';
const load=name=>import(pathToFileURL(path.join(content,'dist',name)).href);
const workspace=await load('bridge/workspace.js'),agents=await load('features/project-agents/index.js');
const contract=await load('features/project-agents/contract.js'),queue=await load('features/project-learning/observation-queue.js');
const {LEARNING_COLLECTOR_FILE}=await load('features/project-learning/collector-plugin.js');
const metadata=JSON.parse(await fs.readFile(path.join(content,'runtime.json'),'utf8'));
const engine=path.join(content,metadata.probeEngine.file);
assert.equal(createHash('sha256').update(await fs.readFile(engine)).digest('hex'),metadata.probeEngine.sha256);
const project=path.join(directory,'projects','проект');await fs.mkdir(project,{recursive:true});
await workspace.setRoot(path.dirname(project));await workspace.bindProject('runtime-learning',path.basename(project));
const bindingId=await workspace.projectBindingId('runtime-learning'),instanceId=await workspace.projectInstanceId('runtime-learning');
const payload=revision=>contract.createProjectAgentsPayload({schemaVersion:2,projectId:'runtime-learning',bindingId,instanceId,revision,
 agents:revision===1?[{id:'agent-learning',slug:'nc-learning',version:1,enabled:true,description:'Fixture',prompt:'Fixture prompt',mode:'subagent',permission:{bash:'deny'}}]:[]});
const compiler=async revision=>contract.compileProjectAgents(payload(revision),[]);
process.env.HOME=path.join(directory,'isolated-bridge-home');process.env.XDG_CONFIG_HOME=path.join(process.env.HOME,'.config');process.env.XDG_DATA_HOME=path.join(process.env.HOME,'.local/share');
await agents.configureProjectAgents(payload(1),async()=>undefined,async()=>undefined,()=>compiler(1));
const home=path.join(directory,'native-home'),config=path.join(home,'config/opencode'),projectConfig=path.join(project,'.opencode');
const marker=path.join(directory,'native-marker.json'),collector=path.join(project,LEARNING_COLLECTOR_FILE);
await fs.mkdir(config,{recursive:true});
const dependencies={'@opencode-ai/plugin':'1.14.48'};
for(const dir of [config,projectConfig]){
 await fs.mkdir(path.join(dir,'node_modules'),{recursive:true});
 await fs.writeFile(path.join(dir,'package.json'),JSON.stringify({private:true,dependencies}));
 await fs.writeFile(path.join(dir,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'':{dependencies}}}));
}
await fs.writeFile(path.join(config,'opencode.json'),JSON.stringify({mcp:{},plugin:[],enabled_providers:[],provider:{},lsp:false,formatter:false,autoupdate:false,snapshot:false,share:'disabled',permission:{'*':'deny'}}));
await fs.writeFile(path.join(projectConfig,'plugins/zz-learning-acceptance.js'),`import fs from 'node:fs/promises';import factory from ${JSON.stringify(pathToFileURL(collector).href)};
export default async input=>{const hooks=await factory(input);await hooks['tool.execute.after']({tool:'read',sessionID:'native-runtime-learning',args:{secret:'PRIVATE args'}},{output:'PRIVATE output'});await hooks.event({event:{type:'session.idle',properties:{sessionID:'native-runtime-learning',prompt:'PRIVATE prompt'}}});await hooks.event({event:{type:'session.idle',properties:{sessionID:'native-runtime-learning'}}});await fs.writeFile(${JSON.stringify(marker)},JSON.stringify({hooks:Object.keys(hooks).sort()}),{flag:'wx',mode:0o600});return {};};\n`);
for(const dir of [config,projectConfig]){await fs.chmod(path.join(dir,'node_modules'),0o500);await fs.chmod(dir,0o500);}
const env={HOME:home,USERPROFILE:home,PATH:'',TERM:'dumb',NO_COLOR:'1',XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'data'),XDG_CACHE_HOME:path.join(home,'cache'),XDG_STATE_HOME:path.join(home,'state'),
 OPENCODE_DISABLE_MODELS_FETCH:'true',OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_DISABLE_DEFAULT_PLUGINS:'true',OPENCODE_DISABLE_LSP_DOWNLOAD:'true',OPENCODE_DISABLE_CLAUDE_CODE:'true',OPENCODE_DISABLE_EXTERNAL_SKILLS:'true',
 NPM_CONFIG_OFFLINE:'true',NPM_CONFIG_IGNORE_SCRIPTS:'true',NPM_CONFIG_REGISTRY:'http://127.0.0.1:9'};
const run=promisify(execFile),native=async(...args)=>(await run(engine,args,{cwd:project,env,timeout:30000,maxBuffer:2*1024*1024})).stdout;
assert.equal((await native('--version')).trim(),metadata.probeEngine.version);
const nativeConfig=JSON.parse(await native('debug','config'));
assert.ok(nativeConfig.plugin.some(entry=>typeof entry==='string'&&entry.endsWith('/neurocenter-learning.js')));
assert.deepEqual(JSON.parse(await fs.readFile(marker,'utf8')),{hooks:['event','tool.execute.after']});
const queueDirectory=path.join(queue.learningQueueRoot(),bindingId);
let files=(await fs.readdir(queueDirectory)).filter(file=>file.endsWith('.json'));assert.equal(files.length,1);
const raw=await fs.readFile(path.join(queueDirectory,files[0]),'utf8'),observed=JSON.parse(raw);
assert.ok(!raw.includes('PRIVATE'));assert.equal(observed.input.outcome,'unknown');
assert.deepEqual(JSON.parse(observed.input.evidence[0].summary).toolObservations,{read:1});
assert.equal((await fs.stat(queueDirectory)).mode&0o777,0o700);assert.equal((await fs.stat(path.join(queueDirectory,files[0]))).mode&0o777,0o600);
for(const dir of [config,projectConfig])await fs.chmod(dir,0o700);
const hooks=await(await import(pathToFileURL(collector).href)).default({directory:project});
await hooks['tool.execute.after']({tool:'read',sessionID:'stale-runtime-learning'});
const identityFile=path.join(projectConfig,'neurocenter.json'),identity=await fs.readFile(identityFile,'utf8');
await fs.writeFile(identityFile,JSON.stringify({...JSON.parse(identity),instanceId:randomUUID()}));
try{await hooks.event({event:{type:'session.idle',properties:{sessionID:'stale-runtime-learning'}}});}
finally{await fs.writeFile(identityFile,identity);}
files=(await fs.readdir(queueDirectory)).filter(file=>file.endsWith('.json'));assert.equal(files.length,1);
assert.equal(await fs.readFile(path.join(queueDirectory,files[0]),'utf8'),raw);
await agents.configureProjectAgents(payload(2),async()=>undefined,async()=>undefined,()=>compiler(2));
await assert.rejects(fs.stat(collector),error=>error.code==='ENOENT');
console.log(JSON.stringify({nativePluginDiscovered:true,metadataOnly:true,repeatedIdleNoDuplicate:true,staleBindingDropped:true,managedCollectorRemoved:true,engineVersion:metadata.probeEngine.version}));
