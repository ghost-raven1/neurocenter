import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {workspaceFixture} from './bridge-fixture.js';
import {hash} from '../src/bridge/state.js';
import {projectBindingId,projectInstanceId} from '../src/bridge/workspace.js';
import {configureProjectAgents} from '../src/features/project-agents/index.js';
import {createProjectAgentsPayload} from '../src/features/project-agents/contract.js';
import {LEARNING_COLLECTOR_FILE} from '../src/features/project-learning/collector-plugin.js';
import {learningQueueRoot} from '../src/features/project-learning/observation-queue.js';

const binary=process.env.OPENCODE_AGENT_TEST_ENGINE,run=promisify(execFile);
/** The native engine and HOME are isolated; no provider, tools, subprocess commands or user profile are used. */
describe.runIf(!!binary)('Native project learning collector',()=>{
    let fixture:Awaited<ReturnType<typeof workspaceFixture>>|undefined,config:string|undefined;
    afterEach(async()=>{
        vi.unstubAllEnvs();
        if(config)await fs.chmod(config,0o700).catch(()=>undefined);
        if(fixture){await fs.chmod(path.join(fixture.root,'.opencode'),0o700).catch(()=>undefined);await fs.rm(fixture.temporary,{recursive:true,force:true});}
    });
    it('auto-discovers the managed plugin and runs metadata-only hooks inside pinned OpenCode',async()=>{
        expect(process.env.OPENCODE_AGENT_TEST_ENGINE_SHA256).toMatch(/^[a-f0-9]{64}$/);
        expect(hash(await fs.readFile(binary!))).toBe(process.env.OPENCODE_AGENT_TEST_ENGINE_SHA256);
        fixture=await workspaceFixture();
        const root=fixture.root,bindingId=await projectBindingId('test-project'),instanceId=await projectInstanceId('test-project');
        await configureProjectAgents(createProjectAgentsPayload({schemaVersion:1,projectId:'test-project',bindingId,instanceId,revision:1,agents:[{id:'agent-fixture',slug:'nc-fixture',version:1,
            enabled:true,description:'Fixture',prompt:'Fixture prompt',mode:'subagent',permission:{bash:'deny'}}]}),async()=>undefined,async()=>undefined);
        const home=path.join(fixture.temporary,'native-home'),projectConfig=path.join(root,'.opencode'),marker=path.join(fixture.temporary,'native-marker.json');
        config=path.join(home,'config/opencode');await fs.mkdir(config,{recursive:true});
        const dependencies={'@opencode-ai/plugin':'1.14.48'};
        for(const directory of [config,projectConfig]){
            await fs.mkdir(path.join(directory,'node_modules'),{recursive:true});
            await fs.writeFile(path.join(directory,'package.json'),JSON.stringify({private:true,dependencies}));
            await fs.writeFile(path.join(directory,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'':{dependencies}}}));
        }
        await fs.writeFile(path.join(config,'opencode.json'),JSON.stringify({mcp:{},plugin:[],enabled_providers:[],provider:{},lsp:false,formatter:false,autoupdate:false,snapshot:false,share:'disabled',permission:{'*':'deny'}}));
        await fs.writeFile(path.join(root,'.opencode/plugins/zz-learning-acceptance.js'),`import fs from 'node:fs/promises';import factory from ${JSON.stringify(pathToFileURL(path.join(root,LEARNING_COLLECTOR_FILE)).href)};
export default async input=>{const hooks=await factory(input);await hooks['tool.execute.after']({tool:'read',sessionID:'native-learning-fixture',args:{secret:'PRIVATE native args'}},{output:'PRIVATE native output'});await hooks.event({event:{type:'session.idle',properties:{sessionID:'native-learning-fixture',prompt:'PRIVATE native prompt'}}});await fs.writeFile(${JSON.stringify(marker)},JSON.stringify({hooks:Object.keys(hooks).sort()}),{flag:'wx',mode:0o600});return {};};\n`);
        for(const directory of [config,projectConfig]){await fs.chmod(path.join(directory,'node_modules'),0o500);await fs.chmod(directory,0o500);}
        const env:NodeJS.ProcessEnv={HOME:home,USERPROFILE:home,PATH:'',TERM:'dumb',NO_COLOR:'1',XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'data'),XDG_CACHE_HOME:path.join(home,'cache'),XDG_STATE_HOME:path.join(home,'state'),
            OPENCODE_DISABLE_MODELS_FETCH:'true',OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_DISABLE_DEFAULT_PLUGINS:'true',OPENCODE_DISABLE_LSP_DOWNLOAD:'true',OPENCODE_DISABLE_CLAUDE_CODE:'true',OPENCODE_DISABLE_EXTERNAL_SKILLS:'true',
            NPM_CONFIG_OFFLINE:'true',NPM_CONFIG_IGNORE_SCRIPTS:'true',NPM_CONFIG_REGISTRY:'http://127.0.0.1:9'};
        expect((await run(binary!,['--version'],{cwd:root,env,timeout:15000})).stdout.trim()).toBe('1.14.48');
        const result=await run(binary!,['debug','config'],{cwd:root,env,timeout:30000,maxBuffer:2*1024*1024});
        const native=JSON.parse(result.stdout);expect(native.plugin.some((entry:unknown)=>typeof entry==='string'&&entry.endsWith('/neurocenter-learning.js'))).toBe(true);
        expect(JSON.parse(await fs.readFile(marker,'utf8'))).toEqual({hooks:['event','tool.execute.after']});
        const files=(await fs.readdir(path.join(learningQueueRoot(),bindingId))).filter(file=>file.endsWith('.json'));expect(files).toHaveLength(1);
        const observed=await fs.readFile(path.join(learningQueueRoot(),bindingId,files[0]!), 'utf8');expect(observed).not.toContain('PRIVATE');expect(JSON.parse(observed).input.outcome).toBe('unknown');
    },60000);
});
