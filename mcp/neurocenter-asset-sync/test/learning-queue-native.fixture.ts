import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';

/** Only a SHA-checked pinned engine and temporary, provider-free HOME/config/project are used. */
export async function nativeQueueFixture(temporary:string,directory:string,mode:'hold'|'write'){
    const engine=process.env.OPENCODE_AGENT_TEST_ENGINE!,expected=process.env.OPENCODE_AGENT_TEST_ENGINE_SHA256;
    if(!expected||createHash('sha256').update(await fs.readFile(engine)).digest('hex')!==expected)throw Error('Native engine SHA mismatch');
    const root=path.join(temporary,'native-'+randomUUID()),home=path.join(root,'home'),project=path.join(root,'project');
    const config=path.join(home,'config/opencode'),local=path.join(project,'.opencode'),started=path.join(root,'started'),entered=path.join(root,'entered'),completed=path.join(root,'completed'),release=path.join(root,'release');
    for(const folder of [config,local]){
        await fs.mkdir(path.join(folder,'node_modules'),{recursive:true});const dependencies={'@opencode-ai/plugin':'1.14.48'};
        await fs.writeFile(path.join(folder,'package.json'),JSON.stringify({private:true,dependencies}));await fs.writeFile(path.join(folder,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{'':{dependencies}}}));
    }
    await fs.mkdir(path.join(local,'plugins'));
    await fs.writeFile(path.join(config,'opencode.json'),JSON.stringify({mcp:{},plugin:[],enabled_providers:[],provider:{},lsp:false,formatter:false,autoupdate:false,snapshot:false,share:'disabled',permission:{'*':'deny'}}));
    const module=new URL('../src/features/project-learning/queue-lock.ts',import.meta.url).href;
    await fs.writeFile(path.join(local,'plugins/probe.js'),`import fs from 'node:fs/promises';import path from 'node:path';import {withLearningQueueLock} from ${JSON.stringify(module)};
export default async()=>{await fs.writeFile(${JSON.stringify(started)},'started');await withLearningQueueLock(${JSON.stringify(directory)},async()=>{await fs.writeFile(${JSON.stringify(entered)},'entered');
${mode==='hold'?`while(!await fs.access(${JSON.stringify(release)}).then(()=>true,()=>false))await new Promise(resolve=>setTimeout(resolve,10));`:
`const file=path.join(${JSON.stringify(directory)},'critical'),handle=await fs.open(file,'wx',0o600);try{await fs.appendFile(path.join(${JSON.stringify(directory)},'entries.jsonl'),JSON.stringify({native:true,pid:process.pid})+'\\n');}finally{await handle.close();await fs.unlink(file);}`}
});await fs.writeFile(${JSON.stringify(completed)},'completed');return {};};`);
    for(const folder of [config,local]){await fs.chmod(path.join(folder,'node_modules'),0o500);await fs.chmod(folder,0o500);}
    const env:NodeJS.ProcessEnv={HOME:home,USERPROFILE:home,PATH:'',TERM:'dumb',NO_COLOR:'1',XDG_CONFIG_HOME:path.join(home,'config'),XDG_DATA_HOME:path.join(home,'data'),XDG_CACHE_HOME:path.join(home,'cache'),XDG_STATE_HOME:path.join(home,'state'),
        OPENCODE_DISABLE_MODELS_FETCH:'true',OPENCODE_DISABLE_AUTOUPDATE:'true',OPENCODE_DISABLE_DEFAULT_PLUGINS:'true',OPENCODE_DISABLE_LSP_DOWNLOAD:'true',OPENCODE_DISABLE_CLAUDE_CODE:'true',OPENCODE_DISABLE_EXTERNAL_SKILLS:'true',
        NPM_CONFIG_OFFLINE:'true',NPM_CONFIG_IGNORE_SCRIPTS:'true',NPM_CONFIG_REGISTRY:'http://127.0.0.1:9'};
    const child=spawn(engine,['debug','config'],{cwd:project,env,stdio:['ignore','ignore','pipe']});let errors='';child.stderr.on('data',chunk=>{errors+=String(chunk);});
    const exit=new Promise<number|null>(resolve=>child.once('exit',code=>resolve(code)));
    const wait=async(file:string)=>{const deadline=Date.now()+30000;while(Date.now()<deadline){if(await fs.access(file).then(()=>true,()=>false))return;
        if(child.exitCode!==null||child.signalCode!==null)throw Error('Native engine exited: '+errors);await new Promise(resolve=>setTimeout(resolve,10));}throw Error('Native hook timed out: '+errors);};
    return {child,started,entered,completed,release,exit,wait,errors:()=>errors,async close(){if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await exit;for(const folder of [config,local])await fs.chmod(folder,0o700);}};
}
