import path from 'node:path';
import {packages,DiagnosticError,evidenceNote} from './constants.mjs';
import {readOwnedFile} from './safe-file.mjs';
import {redactLog} from './redact.mjs';

const malformed=()=>new DiagnosticError('MALFORMED_REPORT','Coverage targets are missing or inconsistent; rerun the selected coverage command.');
const count=value=>Number.isSafeInteger(value)&&value>=0;
const relativePath=value=>typeof value==='string'&&value.length<=512&&!/[\\\u0000-\u001f\u007f]/.test(value)
    &&!path.posix.isAbsolute(value)&&path.posix.normalize(value)===value&&!value.split('/').some(part=>!part||part==='..'||part==='.');
const sourcePath=value=>relativePath(value)&&/\.[cm]?[jt]sx?$/.test(value);
const testPath=value=>sourcePath(value)&&value.startsWith('test/');

function summary(value,comparable){
    return Object.fromEntries(['lines','statements','functions','branches'].map(name=>{
        const item=value?.[name];
        if(!item||!count(item.total)||!count(item.covered)||item.covered>item.total)throw malformed();
        return [name,{total:item.total,covered:item.covered,pct:comparable&&item.total?Math.floor(item.covered/item.total*10000)/100:null}];
    }));
}

async function json(root,file,expectedSha){
    try{
        const content=await readOwnedFile(root,file,{limit:16*1024**2});
        if(expectedSha&&content.contentSha256!==expectedSha)throw new DiagnosticError('FILE_CHANGED','The manifest changed between observations; retry this diagnostic.');
        return {value:JSON.parse(content.text),sha256:content.contentSha256};
    }
    catch(error){if(error instanceof SyntaxError)throw malformed();throw error;}
}

/** Read bounded targets from one retained report; never import a source file or execute a test. */
export async function readCoverageGaps(root,report,packageName,limit,verification){
    const entry=packages.find(([name])=>name===packageName);
    if(!entry||!Number.isInteger(limit)||limit<1||limit>20)throw new DiagnosticError('INVALID_ARGUMENT','Choose a canonical package and a limit between 1 and 20.');
    if(verification.status==='in-progress')throw new DiagnosticError('REPORT_IN_PROGRESS','Wait for this coverage run to finish before choosing regression targets.');
    if(verification.lifecycle&&['failed','cancelled'].includes(verification.status)&&!verification.packages.some(item=>item.name===packageName))
        throw new DiagnosticError('COVERAGE_TARGETS_UNAVAILABLE','This coverage run stopped before retaining package targets; inspect its lifecycle and rerun the selected profile.');
    if(!verification.packages.some(item=>item.name===packageName))throw new DiagnosticError('PACKAGE_NOT_MEASURED','Choose a report containing unit results for this package; HTTP-only reports have no unit package scope.');
    const {value:manifest}=await json(root,report,verification.reportSha256),gapReport=report.replace(/manifest\.json$/,'gaps.json');
    let gapResult;
    try{gapResult=await json(root,gapReport);}catch(error){
        if(error.code==='ENOENT'&&verification.lifecycle&&['failed','cancelled'].includes(verification.status))
            throw new DiagnosticError('COVERAGE_TARGETS_UNAVAILABLE','This coverage run stopped before retaining targets; inspect its lifecycle and rerun the selected profile.');
        throw error;
    }
    const {value:gaps,sha256:gapsSha256}=gapResult;
    if(gaps?.schemaVersion!==1||!Array.isArray(gaps.gaps)||!Array.isArray(manifest.sourceInventory?.files)
        ||['profile','coverageKind','comparablePercentages','complete','sourceChangedDuringRun'].some(key=>gaps[key]!==manifest[key])
        ||manifest.profile!==verification.profile||Date.parse(manifest.finishedAt)!==Date.parse(verification.finishedAt))throw malformed();
    const prefix=entry[1]+'/src/',comparable=verification.comparablePercentages,targets=[],sources=new Map(),seen=new Set();
    for(const item of manifest.sourceInventory.files){
        if(item.role!=='production'||!item.path?.startsWith(prefix))continue;
        if(!relativePath(item.path)||sources.has(item.path)||!['represented','unrepresented','unsupported-runtime','source-unavailable'].includes(item.measurement))throw malformed();
        sources.set(item.path,item.measurement);
    }
    for(const gap of gaps.gaps){
        if(!sourcePath(gap?.file))throw malformed();
        if(!gap.file.startsWith(prefix))continue;
        if(sources.get(gap.file)!=='represented'||seen.has(gap.file))throw malformed();
        seen.add(gap.file);
        const metrics=summary(gap.summary,comparable);
        if(!count(gap.uncoveredBranches)||gap.uncoveredBranches!==metrics.branches.total-metrics.branches.covered
            ||!Array.isArray(gap.uncoveredFunctions)||!Array.isArray(gap.uncoveredStatementLines)
            ||gap.uncoveredFunctions.length!==metrics.functions.total-metrics.functions.covered
            ||gap.uncoveredFunctions.some(fn=>typeof fn?.name!=='string'||!Number.isSafeInteger(fn.line)||fn.line<1)
            ||gap.uncoveredStatementLines.some(line=>!Number.isSafeInteger(line)||line<1))throw malformed();
        targets.push({file:gap.file,summary:metrics,uncoveredBranches:gap.uncoveredBranches,
            uncoveredFunctionCount:gap.uncoveredFunctions.length,uncoveredFunctions:gap.uncoveredFunctions.slice(0,20).map(fn=>({name:redactLog(fn.name).slice(0,120),line:fn.line})),
            uncoveredStatementLines:gap.uncoveredStatementLines.slice(0,40),detailsTruncated:gap.uncoveredFunctions.length>20||gap.uncoveredStatementLines.length>40});
    }
    targets.sort((a,b)=>(b.uncoveredBranches+b.uncoveredFunctionCount*2)-(a.uncoveredBranches+a.uncoveredFunctionCount*2)||a.file.localeCompare(b.file));
    const missing=[...sources].filter(([,measurement])=>measurement!=='represented').map(([file])=>file);
    const measured=manifest.packages.filter(item=>item.name===packageName);
    if(measured.some(item=>!Array.isArray(item.excludedInfrastructureSuites)||item.excludedInfrastructureSuites.some(file=>!testPath(file))))throw malformed();
    const excluded=[...new Set(measured.flatMap(item=>item.excludedInfrastructureSuites))].sort();
    return {report,reportSha256:verification.reportSha256,gapsSha256,package:packageName,profile:verification.profile,coverageKind:verification.coverageKind,comparablePercentages:comparable,
        verificationStatus:verification.status,complete:verification.complete,testCounters:verification.packages.filter(item=>item.name===packageName).map(({passed,failed,skipped,todo,cancelled})=>({passed,failed,skipped,todo,...(cancelled!==undefined?{cancelled}:{})})),source:verification.source,totalTargets:targets.length,targets:targets.slice(0,limit),
        unrepresentedFileCount:missing.length,unrepresentedFiles:missing.sort().slice(0,limit),excludedSuiteCount:excluded.length,excludedSuites:excluded.slice(0,limit),
        exclusionScope:'Distinct unit suite paths across all retained entries for this package; HTTP-only exclusions are not attributed to packages.',
        truncated:targets.length>limit||missing.length>limit||excluded.length>limit,
        scope:'Recorded gaps in the selected package src tree. Missing files have no invented line percentage. Targets are test-writing hints, not proof of correctness or current source equivalence.',
        evidence:evidenceNote};
}
