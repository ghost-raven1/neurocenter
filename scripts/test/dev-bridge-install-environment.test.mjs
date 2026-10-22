import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fixture,update,jsonc,sha} from './dev-bridge-install.fixture.mjs';

const exec=promisify(execFile),nativeEvidence={markers:[],signals:[]};
after(async()=>{if(process.env.DEV_BRIDGE_LIFECYCLE_EVIDENCE)await fs.writeFile(process.env.DEV_BRIDGE_LIFECYCLE_EVIDENCE+'.environment.json',JSON.stringify(nativeEvidence,null,2)+'\n',{mode:0o600});});
async function stopEnvironmentWorker(install,pid,home){
    if(!pid)return;
    let command;try{command=(await exec('ps',['-p',String(pid),'-o','uid=','-o','args='],{timeout:2000})).stdout.trim();}catch(error){if(error.code===1){nativeEvidence.signals.push({pid,alreadyExited:true});return;}throw error;}
    assert.ok(command.startsWith(String(process.getuid())+' '),command);assert.ok(command.endsWith(path.join(install,'dist/index.js')+' --worker'),command);
    const receipt={pid,uid:process.getuid(),command,home,signal:'SIGTERM',terminated:false};nativeEvidence.signals.push(receipt);process.kill(pid,'SIGTERM');
    const deadline=Date.now()+3000;while(Date.now()<deadline){try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH'){receipt.terminated=true;return;}throw error;}await new Promise(resolve=>setTimeout(resolve,20));}
    process.kill(pid,'SIGKILL');throw Error('Owned runtime-HOME fixture worker required force termination.');
}

async function saveEnvironment(f){
    const text=await fs.readFile(f.config,'utf8');
    await fs.writeFile(f.config,jsonc.applyEdits(text,jsonc.modify(text,['mcp','neurocenter-asset-sync','environment'],f.entry.environment,{formattingOptions:{insertSpaces:true,tabSize:2,eol:'\n'}})));
}
test('Saved runtime HOME and XDG never redirect management registration or launcher into another config',async()=>{for(const explicitXdg of [true,false])await fixture(async f=>{
    if(!explicitXdg)delete f.environment.XDG_CONFIG_HOME;
    const alternateHome=path.join(f.home,'runtime-home'),alternateXdg=path.join(alternateHome,'xdg'),alternateConfig=path.join(alternateXdg,'opencode/opencode.jsonc');
    await fs.mkdir(path.dirname(alternateConfig),{recursive:true});const sentinel='// second config is not this installation target\n{"sentinel":"keep exact bytes","mcp":{"other":{"type":"remote","url":"https://other.invalid"}}}\n';await fs.writeFile(alternateConfig,sentinel);
    Object.assign(f.entry.environment,{HOME:alternateHome,USERPROFILE:alternateHome,XDG_CONFIG_HOME:alternateXdg});await saveEnvironment(f);
    const run=f.dependencies.runCommand,observed=[];f.dependencies.runCommand=async(command,args,environment,timeout)=>{observed.push({args,home:environment.HOME,profile:environment.USERPROFILE,xdg:environment.XDG_CONFIG_HOME});return run(command,args,environment,timeout);};
    let result,failure;try{result=await update(f);}catch(error){failure=error;}
    assert.equal(await fs.readFile(alternateConfig,'utf8'),sentinel,'Management CLI must not modify the second private config.');
    assert.equal(failure,undefined);assert.equal(result.updated,true);
    for(const row of observed.filter(row=>['--init','--install-command'].includes(row.args[1]))){assert.equal(row.home,f.home);assert.equal(row.profile,f.home);assert.equal(row.xdg,f.environment.XDG_CONFIG_HOME);}
    for(const row of observed.filter(row=>['--prepare-upgrade','--finish-upgrade'].includes(row.args[1]))){assert.equal(row.home,alternateHome);assert.equal(row.xdg,alternateXdg);}
    assert.deepEqual(jsonc.parse(await fs.readFile(f.config,'utf8')).mcp['neurocenter-asset-sync'].environment,f.entry.environment);
    await assert.rejects(fs.stat(path.join(alternateHome,'.local/bin/neurocenter-bridge')),{code:'ENOENT'});
});});
test('Saved runtime HOME selects existing pairing namespace when no explicit bridge-home override exists',async()=>fixture(async f=>{
    const runtimeHome=path.join(f.home,'runtime-home'),runtimeXdg=path.join(runtimeHome,'xdg'),runtimeState=path.join(runtimeHome,'.config/neurocenter/bridge',sha(f.entry.environment.NEUROCENTER_URL).slice(0,20));
    await fs.mkdir(runtimeState,{recursive:true,mode:0o700});await fs.rename(path.join(f.state,'credentials.json'),path.join(runtimeState,'credentials.json'));
    delete f.entry.environment.NEUROCENTER_BRIDGE_HOME;Object.assign(f.entry.environment,{HOME:runtimeHome,USERPROFILE:runtimeHome,XDG_CONFIG_HOME:runtimeXdg});await saveEnvironment(f);
    const run=f.dependencies.runCommand;let pid;
    // Keep this namespace oracle independent of the separately tested management selector defect.
    f.dependencies.runCommand=(command,args,environment,timeout)=>run(command,args,['--init','--install-command'].includes(args[1])?{...environment,HOME:f.home,USERPROFILE:f.home,XDG_CONFIG_HOME:f.environment.XDG_CONFIG_HOME}:environment,timeout);
    delete f.dependencies.startWorker;
    try{
        const result=await update(f);assert.equal(result.workerRestarted,true);
        const worker=JSON.parse(await fs.readFile(path.join(runtimeState,'worker-version.json'),'utf8'));pid=worker.pid;
        assert.equal(worker.fixtureHome,runtimeHome);assert.equal(worker.fixtureCwd,process.cwd());assert.equal(worker.buildId,f.buildId);assert.equal(await fs.readFile(path.join(runtimeState,'worker.lock'),'utf8'),String(pid));process.kill(pid,0);
        nativeEvidence.markers.push({pid,home:worker.fixtureHome,cwd:worker.fixtureCwd,state:runtimeState,entry:path.join(f.install,'dist/index.js')});
        assert.equal(await fs.readFile(path.join(runtimeState,'credentials.json'),'utf8'),f.credentials);await assert.rejects(fs.stat(path.join(f.home,'.config/neurocenter/bridge',path.basename(runtimeState),'credentials.json')),{code:'ENOENT'});
        assert.deepEqual(jsonc.parse(await fs.readFile(f.config,'utf8')).mcp['neurocenter-asset-sync'].environment,f.entry.environment);
    }finally{if(!pid)try{pid=JSON.parse(await fs.readFile(path.join(runtimeState,'worker-version.json'),'utf8')).pid;}catch{}await stopEnvironmentWorker(f.install,pid,runtimeHome);}
}));
test('An explicitly empty runtime home rejects before preparing a worker or changing any saved bytes',async()=>fixture(async f=>{
    f.entry.environment[process.platform==='win32'?'USERPROFILE':'HOME']='';await saveEnvironment(f);
    const before=await fs.readFile(f.config);
    await assert.rejects(update(f),/Пустой.*(?:HOME|USERPROFILE)/);
    assert.deepEqual(await fs.readFile(f.config),before);assert.equal(await fs.readFile(f.launcher,'utf8'),f.originalLauncher);assert.equal(await fs.readFile(path.join(f.install,'keep.txt'),'utf8'),'old runtime');assert.equal(await fs.readFile(path.join(f.state,'credentials.json'),'utf8'),f.credentials);
    assert.ok(!f.events.some(row=>row.args[1]==='--prepare-upgrade'));assert.equal(f.starts.length,0);
}));
