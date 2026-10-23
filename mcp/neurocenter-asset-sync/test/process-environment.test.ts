import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {expect,it,vi} from 'vitest';
import {stateDir,writeState} from '../src/bridge/state.js';
const run=promisify(execFile);

it('installs a process-level isolated baseline before any bridge fixture can run',()=>{
    const root=process.env.NEUROCENTER_TEST_PROCESS_ROOT;
    expect(root).toBeTruthy();
    expect(process.env.HOME).toBe(path.join(root!,'home'));
    expect(process.env.NEUROCENTER_BRIDGE_HOME).toBe(path.join(root!,'bridge'));
    expect(process.env.NEUROCENTER_URL).toBe('https://bridge-tests.invalid');
});

it('unstubAllEnvs cannot send a delayed write back to the inherited profile',async()=>{
    const baseline=process.env.NEUROCENTER_BRIDGE_HOME!,root=process.env.NEUROCENTER_TEST_PROCESS_ROOT!;
    let release!:()=>void;
    const pending=new Promise<void>(resolve=>{release=resolve;}).then(()=>writeState('late-isolation-write',{fixture:true}));
    vi.stubEnv('HOME',path.join(root,'fixture-home'));
    vi.stubEnv('NEUROCENTER_BRIDGE_HOME',path.join(root,'fixture-bridge'));
    vi.stubEnv('NEUROCENTER_URL','https://fixture.invalid');
    vi.unstubAllEnvs();release();await pending;
    expect(process.env.HOME).toBe(path.join(root,'home'));expect(stateDir()).toContain(baseline+path.sep);
    const written=path.join(stateDir(),'late-isolation-write.json');
    expect(JSON.parse(await fs.readFile(written,'utf8'))).toEqual({fixture:true});await fs.rm(written);
});

it.each([false,true])('simulated parent credentials reproduce the old late-write failure and the process guard prevents it: %s',async guarded=>{
    const temporary=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-parent-isolation-')));
    const parentHome=path.join(temporary,'parent-home');await fs.mkdir(parentHome);
    const bootstrap=fileURLToPath(new URL('./process-environment.mjs',import.meta.url));
    const state=fileURLToPath(new URL('../src/bridge/state.ts',import.meta.url));
    const code=`import fs from 'node:fs/promises';import path from 'node:path';
const {stateDir,writeState}=await import(${JSON.stringify(state)});
const parentFile=path.join(stateDir(),'credentials.json');await writeState('credentials',{token:'SIMULATED_PARENT_SENTINEL'});
const before=await fs.readFile(parentFile,'utf8');
if(${guarded}){const {isolateBridgeTestProcess}=await import(${JSON.stringify(bootstrap)});isolateBridgeTestProcess();}
const baseline={...process.env};let release;const gate=new Promise(resolve=>release=resolve);
const pending=gate.then(()=>writeState('credentials',{token:'LATE_FIXTURE_MARKER'}));
process.env.HOME=path.join(${JSON.stringify(temporary)},'fixture-home');process.env.NEUROCENTER_BRIDGE_HOME=path.join(${JSON.stringify(temporary)},'fixture-bridge');process.env.NEUROCENTER_URL='https://fixture.invalid';
Object.assign(process.env,baseline);release();await pending;
const unchanged=await fs.readFile(parentFile,'utf8')===before;
const guardedPath=!!process.env.NEUROCENTER_TEST_PROCESS_ROOT&&stateDir().startsWith(process.env.NEUROCENTER_TEST_PROCESS_ROOT+path.sep);
process.stdout.write(JSON.stringify({unchanged,guardedPath}));`;
    try{
        const env={...process.env,HOME:parentHome,USERPROFILE:parentHome,NEUROCENTER_TEST_PROCESS_ROOT:'',NEUROCENTER_BRIDGE_HOME:'',NEUROCENTER_URL:'https://simulated-parent.invalid',NEUROCENTER_API_URL:''};
        const result=await run(process.execPath,['--import','tsx','--input-type=module','-e',code],{cwd:fileURLToPath(new URL('..',import.meta.url)),env,timeout:10000,maxBuffer:4096});
        expect(JSON.parse(result.stdout)).toEqual({unchanged:guarded,guardedPath:guarded});
    }finally{await fs.rm(temporary,{recursive:true,force:true});}
});
