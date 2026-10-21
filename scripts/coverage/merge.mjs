#!/usr/bin/env node
import path from 'node:path';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {writeGapReport} from './report.mjs';
import {coverageMethod,manifestCoverageKinds} from './methods.mjs';
const require=createRequire(new URL('./package.json',import.meta.url));
const {createCoverageMap}=require('istanbul-lib-coverage'),{createContext}=require('istanbul-lib-report'),reports=require('istanbul-reports');
const args=process.argv.slice(2),runs=[];let output,experimental=false;
for(let i=0;i<args.length;i++){
 if(args[i]==='--experimental-native-union')experimental=true;
 else if(args[i]==='--run'&&args[i+1])runs.push(path.resolve(args[++i]));
 else if(args[i]==='--output'&&args[i+1])output=path.resolve(args[++i]);
 else throw Error('Usage: node scripts/coverage/merge.mjs --run <retained-run> --run <retained-run> --output <new-directory> [--experimental-native-union]');
}
if(!runs.length||!output)throw Error('Pass at least one retained run and a new output directory.');
const map=createCoverageMap({}),inputs=[];
for(const directory of [...new Set(runs)]){
 const bytes=await readFile(path.join(directory,'manifest.json')),manifest=JSON.parse(bytes);
 if(!manifest.finishedAt)throw Error('Cannot merge an unfinished run: '+directory);
 map.merge(JSON.parse(await readFile(path.join(directory,'merged/coverage-final.json'),'utf8')));
 inputs.push({directory,manifestSha256:createHash('sha256').update(bytes).digest('hex'),manifest});
}
const method=coverageMethod(inputs.map(({manifest})=>manifestCoverageKinds(manifest)),experimental);
await mkdir(path.dirname(output),{recursive:true});await mkdir(output,{recursive:false});
const sourceIdentities=new Set(inputs.flatMap(({manifest})=>[manifest.sourceBefore,manifest.sourceAfter]).filter(Boolean).map(value=>JSON.stringify(value)));
const manifest={schemaVersion:2,profile:'retained-runs-merge',...method,startedAt:new Date().toISOString(),finishedAt:new Date().toISOString(),node:process.version,
 complete:inputs.every(({manifest})=>manifest.suiteCompletion??manifest.complete),suiteCompletion:inputs.every(({manifest})=>manifest.suiteCompletion??manifest.complete),
 sourceChangedDuringRun:sourceIdentities.size>1||inputs.some(({manifest})=>manifest.sourceChangedDuringRun),
 packages:inputs.flatMap(({manifest})=>manifest.packages),inputs:inputs.map(({directory,manifestSha256,manifest})=>({directory,manifestSha256,profile:manifest.profile,complete:manifest.complete,native:manifest.native,integration:manifest.integration,sourceBefore:manifest.sourceBefore,sourceAfter:manifest.sourceAfter})),
 denominator:{allWorkspaceSourcesIncluded:inputs.some(({manifest})=>manifest.denominator?.allWorkspaceSourcesIncluded),httpOnlyExecutedSources:true},
 summary:method.comparablePercentages?map.getCoverageSummary().toJSON():null,...(!method.comparablePercentages?{experimentalSummary:map.getCoverageSummary().toJSON()}:{}),sourceFiles:map.files().length,
 note:'Original raw V8, logs and per-package reports remain in each input directory. Inputs may overlap: test counts are per run, not distinct tests. Pure Vitest AST maps may be compared. An explicitly experimental mixed AST/c8 union has incomparable statement/branch/function/line denominators and is not a near100 measure. Mixed source identities remain explicit; this is not an atomic build or production acceptance.'};
const context=createContext({dir:path.join(output,'merged'),coverageMap:map});
for(const name of ['json','json-summary','lcov','html'])reports.create(name,{skipEmpty:false,skipFull:false}).execute(context);
await writeFile(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2));await writeGapReport(map,manifest,output);
console.log(path.join(output,'manifest.json'));
