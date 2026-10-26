import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {nodeRuntime,npmCli} from './node-runtime.mjs';
import {captureCheckPlan,parseCheckOptions,checkHelp} from './check-plan.mjs';
import {readVitestReport,readNodeReport} from './check-report.mjs';
import {captureCheckSource,checkSourceResult} from './check-source.mjs';
import {runCheckProcess} from './check-process.mjs';

const workspace=fileURLToPath(new URL('../../',import.meta.url)).replace(/\/$/,'');
async function directory(folder){
    await fs.mkdir(folder,{recursive:true,mode:0o700});const info=await fs.lstat(folder);
    if(!info.isDirectory()||info.isSymbolicLink()||await fs.realpath(folder)!==folder)throw Error('Каталог отчётов должен находиться в текущем checkout без ссылок.');
}

/** Execute the admitted plan, preserve terminal outcome, and bind results to before/after current source bytes. */
export async function runCheck(root,options,{signal,environment=process.env,timeoutMs=600000,graceMs=1000,output=process.stdout,errorOutput=process.stderr}={}){
    if(environment.NEUROCENTER_CHECK_SOURCE!==undefined&&!['0','1'].includes(environment.NEUROCENTER_CHECK_SOURCE))throw Error('NEUROCENTER_CHECK_SOURCE должен быть 0 или 1.');
    if(environment.NEUROCENTER_CHECK_TOOLING!==undefined&&!['0','1'].includes(environment.NEUROCENTER_CHECK_TOOLING))throw Error('NEUROCENTER_CHECK_TOOLING должен быть 0 или 1.');
    if(options.tooling&&environment.NEUROCENTER_CHECK_TOOLING==='0')throw Error('NEUROCENTER_CHECK_TOOLING=0 отключает --tooling.');
    const plan=captureCheckPlan(root,options),steps=plan.steps,runtime=nodeRuntime(environment),npm=steps.some(step=>step.type==='npm')?npmCli(runtime.env):null;
    if(process.platform==='win32')throw Error('Проверка с управляемой очисткой процессов требует POSIX.');
    if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||!Number.isSafeInteger(graceMs)||graceMs<1)throw Error('Некорректные ограничения времени check.');
    await directory(path.join(root,'.run'));await directory(path.join(root,'.run/check'));
    const folder=path.join(root,'.run/check',randomUUID());await fs.mkdir(folder,{mode:0o700});
    const filename=path.join(folder,'report.json');
    const report={schemaVersion:3,startedAt:new Date().toISOString(),node:runtime.version,selection:options,plannedSteps:steps.map(step=>step.name),
        state:'running',success:false,steps:[],source:{status:'capturing',before:null,after:null},failure:null,cancellation:null};
    const save=async()=>{report.updatedAt=report.finishedAt||new Date().toISOString();await fs.writeFile(filename,JSON.stringify(report,null,2)+'\n',{mode:0o600});};
    await save();let before={snapshot:null,reason:'SOURCE_UNAVAILABLE'};
    try{
        before=await captureCheckSource(root,{enabled:environment.NEUROCENTER_CHECK_SOURCE!=='0',signal});
        report.source=checkSourceResult(before,{snapshot:null,reason:'CAPTURE_PENDING'});await save();
        const current=captureCheckPlan(root,options);
        if(JSON.stringify(plan)!==JSON.stringify(current)||before.snapshot&&Object.entries(plan.inputs).some(([name,sha])=>before.snapshot.records[name]?.sha256!==sha)){
            report.failure={code:'PLAN_SOURCE_CHANGED'};throw Error('Входные файлы плана изменились до начала проверки.');
        }
        for(const [index,step]of steps.entries()){
            if(signal?.aborted){report.failure={code:'CANCELLED'};break;}
            const logFile=path.join(folder,`${String(index+1).padStart(2,'0')}.log`),jsonFile=path.join(folder,`${String(index+1).padStart(2,'0')}.json`);
            output.write(`[${index+1}/${steps.length}] ${step.name}\n`);
            const node=step.type==='compose'?'docker':runtime.node;
            const args=step.type==='npm'?[npm,...step.args,...(step.vitest?['--','--reporter=json','--outputFile='+jsonFile]:[])]:step.nodeTests
                ?[...step.args.slice(0,2),'--test-reporter=spec','--test-reporter-destination=stdout',
                    '--test-reporter='+new URL('./check-node-reporter.mjs',import.meta.url).href,'--test-reporter-destination='+jsonFile,...step.args.slice(2)]:step.args;
            const environment=step.type==='npm'&&step.args[0]==='run'&&step.args[1]==='build'
                ?{...runtime.env,NODE_TLS_REJECT_UNAUTHORIZED:'0',NPM_CONFIG_STRICT_SSL:'false',npm_config_strict_ssl:'false'}:runtime.env;
            const result=await runCheckProcess({node,args,cwd:path.resolve(root,step.directory),env:environment,logFile,signal,timeoutMs,graceMs});
            const entry={name:step.name,...result,log:path.relative(root,logFile)};
            if(step.vitest||step.nodeTests){
                entry.testRunner=step.nodeTests?'node':'vitest';
                entry.results=path.relative(root,jsonFile);
                try{const validation=(step.nodeTests?readNodeReport:readVitestReport)(jsonFile);entry.tests=validation.tests;entry.ok=entry.ok&&validation.ok;if(validation.reportError)entry.reportError=validation.reportError;}
                catch(error){entry.ok=false;entry.reportError=error.message;}
            }
            report.steps.push(entry);await save();
            if(!entry.ok){report.failure=entry.failure||{code:entry.reportError?'TEST_REPORT_FAILED':'CHECK_FAILED'};
                errorOutput.write(`Проверка не прошла: ${step.name}. Лог: ${entry.log}\n`);if(entry.reportError)errorOutput.write(entry.reportError+'\n');break;}
        }
    }catch(error){report.failure??={code:'CHECK_EXECUTION_FAILED'};errorOutput.write('Проверка остановлена; подробности в сохранённом отчёте.\n');}
    finally{
        const after=await captureCheckSource(root,{enabled:environment.NEUROCENTER_CHECK_SOURCE!=='0'});
        report.source=checkSourceResult(before,after);
        if(signal?.aborted){report.failure={code:'CANCELLED'};report.cancellation={signal:['SIGINT','SIGTERM'].includes(signal.reason)?signal.reason:null};}
        else if(report.source.status==='changed'||before.reason==='SOURCE_CHANGED'||after.reason==='SOURCE_CHANGED')report.failure??={code:'SOURCE_CHANGED'};
        report.success=!report.failure&&report.steps.length===steps.length&&report.steps.every(step=>step.ok);
        report.state=report.success?'passed':report.failure?.code==='CANCELLED'?'cancelled':'failed';
        report.finishedAt=new Date().toISOString();await save();
    }
    output.write(`Отчёт: ${path.relative(root,filename)}\n`);return {...report,report:filename};
}

/** Help and invalid selectors finish before runtime resolution, signals or output directories. */
export async function main(args,{root=workspace,output=process.stdout,errorOutput=process.stderr,...execution}={}){
    const options=parseCheckOptions(args);if(options.help){output.write(checkHelp+'\n');return 0;}
    const controller=new AbortController(),interrupt=()=>controller.abort('SIGINT'),terminate=()=>controller.abort('SIGTERM');
    process.once('SIGINT',interrupt);process.once('SIGTERM',terminate);
    try{const result=await runCheck(root,options,{...execution,signal:controller.signal,output,errorOutput});return result.success?0:result.state==='cancelled'?(controller.signal.reason==='SIGTERM'?143:130):1;}
    finally{process.off('SIGINT',interrupt);process.off('SIGTERM',terminate);}
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url)try{process.exitCode=await main(process.argv.slice(2));}
catch(error){console.error(error.message);process.exitCode=1;}
