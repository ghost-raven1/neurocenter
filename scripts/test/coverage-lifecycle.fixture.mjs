import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {nativeSuites} from '../coverage/profiles.mjs';

const sourceRoot=fileURLToPath(new URL('../../',import.meta.url));
const packageFolders={frontend:'frontend',bridge:'mcp/neurocenter-asset-sync'};
const collector=String.raw`
import fs from 'node:fs/promises';
import path from 'node:path';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
const cwd=process.cwd(),{scenario,runtime,name}=JSON.parse(await fs.readFile(path.join(cwd,'fixture-case.json'),'utf8'));
await fs.writeFile(path.join(runtime,'started-'+name+'.json'),JSON.stringify({pid:process.pid}));
if(scenario==='hang'){
 const writer=spawn(process.execPath,['-e',"const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(process.argv[1],'x'),20);",path.join(runtime,'writer.log')],{stdio:'ignore'});
 await fs.writeFile(path.join(runtime,'writer.json'),JSON.stringify({pid:writer.pid,group:process.pid}));
 process.on('SIGTERM',()=>{});setInterval(()=>{},50);await new Promise(()=>{});
}
const testFile=path.join(cwd,'test/selected.test.ts'),source=path.join(cwd,'src/entry.ts');
await fs.writeFile(process.env.NEUROCENTER_COVERAGE_INVENTORY_FILE,JSON.stringify({schemaVersion:1,phase:'before-collection',cwd,moduleIds:[testFile]}));
const assertions=[['first observed assertion',()=>assert.equal(1,1)],['second observed assertion',()=>assert.equal(1,scenario==='test-failure'?2:1)]];
const assertionResults=assertions.map(([fullName,check])=>{try{check();return {status:'passed',fullName};}catch{return {status:'failed',fullName};}});
const passed=assertionResults.filter(item=>item.status==='passed').length,failed=assertionResults.filter(item=>item.status==='failed').length;
const report={success:failed===0,numPassedTests:passed,numFailedTests:failed,numPendingTests:0,numTodoTests:0,numTotalTests:assertionResults.length,numFailedTestSuites:failed?1:0,testResults:[{name:testFile,status:failed?'failed':'passed',assertionResults}]};
const reportFile=process.argv.find(arg=>arg.startsWith('--outputFile=')).slice('--outputFile='.length);
await fs.writeFile(reportFile,JSON.stringify(report));
await fs.mkdir(process.env.NEUROCENTER_COVERAGE_DIR,{recursive:true});
const coverage={[source]:{path:source,statementMap:{0:{start:{line:1,column:0},end:{line:1,column:21}}},fnMap:{},branchMap:{},s:{0:2},f:{},b:{}}};
await fs.writeFile(path.join(process.env.NEUROCENTER_COVERAGE_DIR,'coverage-final.json'),scenario==='invalid-json'?'{unfinished':JSON.stringify(coverage));
process.exitCode=failed?1:0;
`;

/** Wait on an observable fixture event; no guessed startup sleeps or product services. */
export async function until(action,label,timeoutMs=5000){
    const deadline=Date.now()+timeoutMs;
    while(Date.now()<deadline){const result=await action();if(result)return result;await delay(20);}
    throw Error('Fixture did not reach '+label);
}

export async function optionalJson(file){
    try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT'||error instanceof SyntaxError)return null;throw error;}
}

export function running(pid){
    const result=spawnSync('/bin/ps',['-p',String(pid),'-o','stat='],{encoding:'utf8'});
    return result.status===0&&result.stdout.trim()&&!result.stdout.trim().startsWith('Z');
}

function killGroup(pid){try{process.kill(-pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}}

/** Copy the shipped CLI; only the Vitest collector is synthetic, with real Git and supervision. */
export async function coverageFixture(t,{scenario='success',packages=['frontend'],native=false}={}){
    const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-coverage-lifecycle-'))),runtime=path.join(root,'runtime');
    const output=path.join(root,'.run/coverage/attempt'),children=[];
    t.after(async()=>{
        for(const file of await fs.readdir(runtime).catch(()=>[])){
            if(!file.startsWith('started-')||!file.endsWith('.json'))continue;
            const record=await optionalJson(path.join(runtime,file));if(record?.pid)killGroup(record.pid);
        }
        for(const child of children)if(child.exitCode===null&&child.signalCode===null)killGroup(child.pid);
        await fs.rm(root,{recursive:true,force:true});
    });
    await fs.mkdir(runtime,{recursive:true,mode:0o700});
    for(const folder of ['scripts/coverage','scripts/workspace']){
        const target=path.join(root,folder);await fs.mkdir(target,{recursive:true});
        for(const file of await fs.readdir(path.join(sourceRoot,folder)))if(file.endsWith('.mjs')||file==='package.json')await fs.copyFile(path.join(sourceRoot,folder,file),path.join(target,file));
    }
    const shared=path.join(root,'services/shared');await fs.mkdir(shared,{recursive:true});
    for(const file of ['feature-flags.cjs','feature-flag-catalog.json'])await fs.copyFile(path.join(sourceRoot,'services/shared',file),path.join(shared,file));
    await fs.symlink(await fs.realpath(path.join(sourceRoot,'scripts/coverage/node_modules')),path.join(root,'scripts/coverage/node_modules'),'dir');
    for(const name of packages){
        const folder=path.join(root,packageFolders[name]);
        for(const relative of ['src','test','node_modules/vitest'])await fs.mkdir(path.join(folder,relative),{recursive:true});
        await fs.writeFile(path.join(folder,'src/entry.ts'),'export const value=1;\n');
        await fs.writeFile(path.join(folder,'test/selected.test.ts'),'// Only collected by the synthetic Vitest boundary.\n');
        await fs.writeFile(path.join(folder,'fixture-case.json'),JSON.stringify({scenario:name==='frontend'?scenario:'success',runtime,name}));
        await fs.writeFile(path.join(folder,'node_modules/vitest/vitest.mjs'),collector);
    }
    if(native){
        const tests=path.join(root,'scripts/test');await fs.mkdir(tests,{recursive:true});
        const body=String.raw`
const runtime=path.join(process.cwd(),'runtime');
const group=Number(execFileSync('/bin/ps',['-p',String(process.pid),'-o','pgid='],{encoding:'utf8'}).trim());
fs.writeFileSync(path.join(runtime,'started-native.json'),JSON.stringify({pid:group}));
process.on('SIGTERM',()=>{});
const writer=spawn(process.execPath,['-e',"const fs=require('node:fs');process.on('SIGTERM',()=>{});setInterval(()=>fs.appendFileSync(process.argv[1],'x'),20);",path.join(runtime,'writer.log')],{stdio:'ignore'});
fs.writeFileSync(path.join(runtime,'writer.json'),JSON.stringify({pid:writer.pid,group}));
test('Synthetic native collector stays unfinished',async()=>{await new Promise(()=>{});});
setInterval(()=>{},50);
`;
        for(const file of nativeSuites){
            const cjs=file.endsWith('.cjs');
            const imports=cjs?"const fs=require('node:fs'),path=require('node:path'),{spawn,execFileSync}=require('node:child_process'),assert=require('node:assert/strict');\nimport('node:test').then(({default:test})=>{\n"
                :"import fs from 'node:fs';import path from 'node:path';import {spawn,execFileSync} from 'node:child_process';import assert from 'node:assert/strict';const {default:test}=await import('node:test');\n";
            const testBody=native==='failure'?"test('Native fixture assertion',()=>assert.equal(1,"+(file===nativeSuites[0]?2:1)+"));\n":body;
            await fs.writeFile(path.join(tests,file),imports+testBody+(cjs?'});\n':''));
        }
    }
    await fs.writeFile(path.join(root,'.gitignore'),'node_modules\n.run/\nruntime/\n');
    await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'neurocenter-workspace',private:true}));
    const git=(args)=>spawnSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:root,encoding:'utf8',env:{PATH:process.env.PATH,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});
    for(const args of [['init','--quiet'],['add','.'],['-c','user.name=Coverage fixture','-c','user.email=fixture@example.test','commit','--quiet','-m','Private coverage fixture']]){
        const result=git(args);assert.equal(result.status,0,result.stderr);
    }
    const start=({wrapper=false,entry:injectedEntry,args=[],environment={},timeoutMs=12000}={})=>{
        const entry=injectedEntry??path.join(root,'scripts/coverage',wrapper?'cli.mjs':'run.mjs');
        const invocation=args.length===1&&args[0]==='--help'?args:[...packages.flatMap(name=>['--package',name]),'--output',output,...args];
        const child=spawn(process.execPath,[entry,...invocation],{
            cwd:root,detached:true,env:{PATH:path.dirname(process.execPath)+path.delimiter+'/usr/bin:/bin',NODE_BIN:process.execPath,...environment},stdio:['ignore','pipe','pipe'],
        });
        children.push(child);let stdout='',stderr='';child.stdout.on('data',bytes=>stdout+=bytes);child.stderr.on('data',bytes=>stderr+=bytes);
        const ended=new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>{killGroup(child.pid);reject(Error('Coverage fixture exceeded its outer test deadline'));},timeoutMs);
            child.once('error',error=>{clearTimeout(timer);reject(error);});
            child.once('close',(code,signal)=>{clearTimeout(timer);resolve({code,signal,stdout,stderr});});
        });
        return {child,ended};
    };
    return {root,runtime,output,start,relativeReport:'.run/coverage/attempt/manifest.json',manifest:()=>optionalJson(path.join(output,'manifest.json')),
        marker:name=>optionalJson(path.join(runtime,'started-'+name+'.json'))};
}
