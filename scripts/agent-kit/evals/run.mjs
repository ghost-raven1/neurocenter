import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {KIT_VERSION,repositoryRoot} from '../generate.mjs';
import {readOwnedFile} from '../../dev-mcp/safe-file.mjs';
import {evaluateTrace,validateScenario} from './evaluate.mjs';

const fixtureDirectory=fileURLToPath(new URL('./fixtures/',import.meta.url));
const digest=value=>createHash('sha256').update(value).digest('hex');
const usage='Usage: node scripts/agent-kit/evals/run.mjs --controls | --scenario <id> --trace .run/agent-kit-evals/<run>/trace.json\nOffline only. No model, commands or network are executed; scores are written to stdout.\n';

function controlsEnabled(environment=process.env){
    const value=environment.NEUROCENTER_AGENT_EVALS;
    if(value!==undefined&&!['0','1'].includes(value))throw Error('Invalid evaluation flag.');
    return value!=='0';
}

/** Read the fixed six-scenario suite; callers cannot select another fixture directory. */
export async function loadScenarios(){
    const names=(await fs.readdir(fixtureDirectory)).filter(name=>name.endsWith('.json')).sort();
    const scenarios=await Promise.all(names.map(async name=>validateScenario(JSON.parse(await fs.readFile(path.join(fixtureDirectory,name),'utf8')))));
    if(scenarios.length!==6||new Set(scenarios.map(item=>item.id)).size!==6)throw Error('Expected six unique scenarios.');
    return scenarios;
}

/** Preserve content fingerprints independently from unchanged kit semver. */
export async function currentVersions(){
    const manifest=await fs.readFile(path.join(repositoryRoot,'scripts/agent-kit/manifest.json'));
    const prompt=await fs.readFile(path.join(repositoryRoot,'.opencode/skills/neurocenter-task-flow/references/development-debugging.md'));
    return {kitVersion:KIT_VERSION,kitManifestSha256:digest(manifest),promptContentSha256:digest(prompt)};
}

/** Positive and negative controls test the evaluator, never a live model. */
export async function runControls({enabled=controlsEnabled()}={}){
    if(!enabled)throw Error('Offline evaluation controls are disabled.');
    const scenarios=await loadScenarios(),versions=await currentVersions(),results=[];
    for(const scenario of scenarios)for(const control of scenario.controls){
        const score=evaluateTrace(scenario,control.trace,versions);
        results.push({scenario:scenario.id,control:control.name,expectedPass:control.pass,matched:(score.status==='pass')===control.pass,score});
    }
    return {schemaVersion:1,kind:'offline-harness-controls',status:results.every(item=>item.matched)?'pass':'fail',
        scenarios:scenarios.length,controls:results.length,modelCalls:0,actionsExecuted:0,results,
        limits:['Control classifications verify deterministic evaluator behavior; live model quality has not been measured.']};
}

/** Read one bounded regular captured trace beneath the dedicated local run directory. */
export async function scoreCapturedTrace(id,relative,{root=repositoryRoot}={}){
    if(typeof relative!=='string'||!/^\.run\/agent-kit-evals\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/trace\.json$/.test(relative))throw Error('Choose a bounded local trace path.');
    const scenario=(await loadScenarios()).find(item=>item.id===id);
    if(!scenario)throw Error('Unknown scenario.');
    const raw=(await readOwnedFile(root,relative,{limit:1024**2})).text;
    const trace=JSON.parse(raw);
    if(trace?.metadata?.capture!=='captured-trace')throw Error('Captured trace metadata is required.');
    return evaluateTrace(scenario,trace,await currentVersions());
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    try{
        const args=process.argv.slice(2);let result;
        if(args.length===1&&args[0]==='--help'){process.stdout.write(usage);process.exitCode=0;}
        else{
            if(args.length===1&&args[0]==='--controls'){
                result=await runControls();
            }
            else if(args.length===4&&args[0]==='--scenario'&&args[2]==='--trace')result=await scoreCapturedTrace(args[1],args[3]);
            else throw Error('Invalid arguments.');
            process.stdout.write(JSON.stringify(result,null,2)+'\n');if(result.status!=='pass')process.exitCode=1;
        }
    }catch{process.stderr.write('Unable to score the bounded local fixture/trace. '+usage);process.exitCode=1;}
}
