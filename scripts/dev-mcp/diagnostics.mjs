import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {workspaceName,packages,logServices,evidenceNote,DiagnosticError} from './constants.mjs';
import {readOwnedFile} from './safe-file.mjs';
import {redactLog} from './redact.mjs';
import {healthReader} from './health.mjs';

const execute=promisify(execFile),sha=/^[a-f0-9]{40,64}$/;
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const boolean=value=>typeof value==='boolean'?value:null;
const date=value=>typeof value==='string'&&value.length<40&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
const malformed=()=>new DiagnosticError('MALFORMED_REPORT','The report has an unsupported or incomplete format; inspect or rerun the existing coverage command.');

/** Read package identity before exposing any workspace diagnostic. */
export async function validateWorkspace(root){
    let manifest;
    try{manifest=JSON.parse((await readOwnedFile(root,'package.json',{limit:16384})).text);}catch{throw new DiagnosticError('WORKSPACE_INVALID','Run this server from an intact Neurocenter checkout with installed bridge dependencies.');}
    if(manifest?.name!==workspaceName)throw new DiagnosticError('WORKSPACE_INVALID','The configured checkout is not neurocenter-workspace.');
}

async function git(root,args){
    const {stdout}=await execute('git',['--no-optional-locks','-c','core.fsmonitor=false','-c','core.untrackedCache=false','-c','core.hooksPath=/dev/null',...args],{
        cwd:root,encoding:'utf8',timeout:2000,maxBuffer:65536,
        env:{PATH:process.env.PATH,LANG:'C',LC_ALL:'C',GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'},
    });
    return stdout;
}

async function gitObservation(root){
    try{
        const head=(await git(root,['rev-parse','HEAD'])).trim(),branch=(await git(root,['branch','--show-current'])).trim();
        const records=(await git(root,['status','--porcelain=v1','-z','--untracked-files=normal'])).split('\0').filter(Boolean);
        let changed=0,untracked=0,conflicts=0;
        for(let index=0;index<records.length;index++){
            const status=records[index].slice(0,2);
            if(status==='??')untracked++;else changed++;
            if(status.includes('U')||status==='AA'||status==='DD')conflicts++;
            if(/[RC]/.test(status))index++;
        }
        const after=(await git(root,['rev-parse','HEAD'])).trim();
        if(!sha.test(head)||after!==head)return {available:false,reason:'Git HEAD changed during observation; retry.'};
        return {available:true,head,branch:branch?redactLog(branch).slice(0,200):null,detached:!branch,
            dirty:{changed,untracked,conflicts,clean:changed+untracked===0,scope:'Untracked directories are summarized; filenames are not returned.'}};
    }catch{return {available:false,reason:'Git metadata is unavailable or exceeded the bounded observation budget.'};}
}

function metric(value,comparable){
    if(!value||count(value.total)===null||count(value.covered)===null||value.covered>value.total)throw malformed();
    const percentage=value.total>0?Math.floor(value.covered/value.total*10000)/100:null;
    return {total:value.total,covered:value.covered,skipped:count(value.skipped),pct:comparable?percentage:null};
}

function counters(value){return {passed:count(value?.passed),failed:count(value?.failed),skipped:count(value?.skipped),
    ...(value&&Object.hasOwn(value,'cancelled')?{cancelled:count(value.cancelled)}:{})};}

/** Feature-local read-only operations; injected service definitions exist only for owned fixture constructors. */
export async function createDiagnostics(root,{services}={}){
    await validateWorkspace(root);
    const health=healthReader(services);
    return {
        async workspaceStatus(){
            const versions=await Promise.all(packages.map(async([name,folder])=>{
                try{const manifest=JSON.parse((await readOwnedFile(root,folder+'/package.json',{limit:32768})).text);
                    return {name,version:typeof manifest.version==='string'&&/^[0-9][0-9A-Za-z.+-]{0,99}$/.test(manifest.version)?manifest.version:null};
                }catch{return {name,version:null,state:'unavailable'};}
            }));
            return {workspace:workspaceName,node:process.version,node24:Number(process.versions.node.split('.')[0])===24,git:await gitObservation(root),packages:versions,
                checkCommands:['npm run check','npm run coverage -- --max-workers 1','node --test scripts/test/dev-mcp.test.mjs'],
                note:'Commands are suggestions only and can be expensive; this server never executes checks.',evidence:evidenceNote};
        },
        async servicesHealth(signal){return {...await health(signal),evidence:evidenceNote};},
        async serviceLogs(service,lines=50){
            if(!logServices.includes(service)||!Number.isInteger(lines)||lines<1||lines>100)throw new DiagnosticError('INVALID_ARGUMENT','Choose a listed service and between 1 and 100 lines.');
            const file=await readOwnedFile(root,'.run/logs/neurocenter-'+service+'.log',{limit:32768,tail:true});
            let text=file.text;
            if(file.truncated){const newline=text.indexOf('\n');text=newline<0?'':text.slice(newline+1);}
            text=redactLog(text);
            const selected=text.replace(/\n$/,'').split('\n').slice(-lines).join('\n');
            const bytes=Buffer.from(selected),bounded=bytes.subarray(Math.max(0,bytes.length-32768)).toString('utf8');
            return {service,text:bounded,lines:bounded?bounded.split('\n').length:0,truncated:file.truncated||bytes.length>32768||text.split('\n').length>lines,evidence:evidenceNote};
        },
        async verificationSummary(report){
            if(typeof report!=='string'||!/^\.run\/coverage\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/manifest\.json$/.test(report))throw new DiagnosticError('INVALID_ARGUMENT','Choose .run/coverage/<one-directory>/manifest.json; reports are never discovered recursively.');
            let value;
            try{value=JSON.parse((await readOwnedFile(root,report,{limit:16*1024**2})).text);}catch(error){if(error instanceof SyntaxError)throw malformed();throw error;}
            if(!value||typeof value!=='object'||Array.isArray(value)||![1,2].includes(value.schemaVersion)||typeof value.profile!=='string'
                ||!/^[a-zA-Z0-9][a-zA-Z0-9+._-]{0,119}$/.test(value.profile)||!Array.isArray(value.packages)||value.packages.length>32)throw malformed();
            const finished=date(value.finishedAt),comparable=value.comparablePercentages===true;
            if(value.finishedAt!==undefined&&!finished)throw malformed();
            const results=value.packages.map(item=>{
                if(!packages.some(([name])=>name===item?.name))throw malformed();
                return {name:item.name,...counters(item),exitCode:Number.isInteger(item.exitCode)?item.exitCode:null,
                    excludedSuites:Array.isArray(item.excludedInfrastructureSuites)?item.excludedInfrastructureSuites.length:null,
                    fileInventory:item.testFileInventory?.complete===true?'complete':item.testFileInventory?.complete===false?'incomplete':'not-reported',
                    reportValid:item.reportValidation?.ok===true?'valid':item.reportValidation?.ok===false?'invalid':'not-reported'};
            });
            const external=[value.native,value.integration].filter(Boolean);
            const coverageSummary=value.summary??(value.coverageKind==='experimental-mixed-instrumentation'&&!comparable?value.experimentalSummary:null);
            if(finished&&(!coverageSummary||typeof value.complete!=='boolean'||results.some(item=>[item.passed,item.failed,item.skipped,item.exitCode,item.excludedSuites].some(value=>value===null))
                ||external.some(item=>[count(item.passed),count(item.failed),count(item.skipped),count(item.cancelled),count(item.exitCode)].some(value=>value===null))))throw malformed();
            const current=await gitObservation(root),recordedHead=sha.test(value.sourceAfter?.head)?value.sourceAfter.head:sha.test(value.sourceBefore?.head)?value.sourceBefore.head:null;
            const currentHeadMatches=!!recordedHead&&current.available?recordedHead===current.head:null;
            const sourceChangedDuringRun=boolean(value.sourceChangedDuringRun);
            const beforeDirty=typeof value.sourceBefore?.status==='string'?value.sourceBefore.status.length>0:null;
            const afterDirty=typeof value.sourceAfter?.status==='string'?value.sourceAfter.status.length>0:null;
            const recordedHeadChanged=sha.test(value.sourceBefore?.head)&&sha.test(value.sourceAfter?.head)&&value.sourceBefore.head!==value.sourceAfter.head;
            const sourceStatus=sourceChangedDuringRun===true||recordedHeadChanged||currentHeadMatches===false?'changed':currentHeadMatches===true&&current.dirty.clean&&beforeDirty===false&&afterDirty===false&&sourceChangedDuringRun===false?'clean-head-match':'not-fully-verified';
            const summary={};
            if(coverageSummary)for(const name of ['lines','statements','functions','branches'])summary[name]=metric(coverageSummary[name],comparable);
            const failed=results.some(item=>item.failed>0||item.exitCode!==null&&item.exitCode!==0)||[value.native,value.integration].some(item=>item?.failed>0||item?.exitCode!==undefined&&item.exitCode!==0);
            const incomplete=results.some(item=>item.skipped>0||item.cancelled>0||item.fileInventory!=='complete'||item.reportValid!=='valid')
                ||external.some(item=>item.skipped>0||item.cancelled>0)||value.sourceInventory?.inventoryComplete===false;
            const status=!finished?'in-progress':failed?'failed':value.complete===true&&!incomplete?'requested-suites-complete':'incomplete';
            return {report,profile:value.profile,coverageKind:['vitest-ast-v8','native-c8-v8','experimental-mixed-instrumentation'].includes(value.coverageKind)?value.coverageKind:null,
                status,startedAt:date(value.startedAt),finishedAt:finished,
                complete:status==='requested-suites-complete',comparablePercentages:comparable,packages:results,native:value.native?counters(value.native):null,integration:value.integration?counters(value.integration):null,
                countScope:value.profile==='retained-runs-merge'?'Counts are per retained run and can overlap; do not sum them as unique tests.':'Counters describe the selected requested suites only.',
                summary,sourceFiles:count(value.sourceFiles),source:{recordedHead,currentHead:current.available?current.head:null,currentHeadMatches,sourceChangedDuringRun,status:sourceStatus},
                denominator:{allWorkspaceSourcesIncluded:boolean(value.denominator?.allWorkspaceSourcesIncluded),configuredPackageSourcesIncluded:boolean(value.denominator?.configuredPackageSourcesIncluded),
                    httpOnlyExecutedSources:boolean(value.denominator?.httpOnlyExecutedSources),fileInventoryIsNotLineCoverage:boolean(value.denominator?.fileInventoryIsNotLineCoverage)},
                evidence:evidenceNote};
        },
    };
}
