import {checkPlan} from '../workspace/check-plan.mjs';
import {packages,evidenceNote,DiagnosticError} from './constants.mjs';
import {readOwnedFile} from './safe-file.mjs';
import {checkSteps} from './tool-catalog.mjs';

/** Reuse the CLI planner over bounded, link-free manifests; planning never executes it. */
export async function readCheckPlan(root,{packages:selected,steps=checkSteps}={}){
    const known=packages.map(([name])=>name);
    if(!Array.isArray(selected)||!selected.length||selected.length>known.length||new Set(selected).size!==selected.length||selected.some(name=>!known.includes(name))
        ||!Array.isArray(steps)||!steps.length||steps.length>checkSteps.length||new Set(steps).size!==steps.length||steps.some(step=>!checkSteps.includes(step)))
        throw new DiagnosticError('INVALID_ARGUMENT','Choose explicit unique workspace packages and optional check steps.');
    const manifests=new Map();
    for(const [name,directory]of packages.filter(([name])=>selected.includes(name))){
        let value;
        try{value=JSON.parse((await readOwnedFile(root,directory+'/package.json',{limit:32768})).text);}
        catch(error){if(error instanceof SyntaxError)throw new DiagnosticError('MALFORMED_PACKAGE','A selected package manifest is not valid JSON.');throw error;}
        if(!value||typeof value!=='object'||Array.isArray(value)||!value.scripts||typeof value.scripts!=='object'||Array.isArray(value.scripts)
            ||['lint','typecheck','build'].some(step=>steps.includes(step)&&(typeof value.scripts[step]!=='string'||!value.scripts[step].trim()))
            ||['test','format:check'].some(step=>value.scripts[step]!==undefined&&typeof value.scripts[step]!=='string'))throw new DiagnosticError('MALFORMED_PACKAGE','A selected package is missing a valid requested check script.');
        manifests.set(directory,value);
    }
    let plan;
    try{plan=checkPlan(root,{packages:selected,steps},{readManifest:directory=>manifests.get(directory)});}
    catch{throw new DiagnosticError('EMPTY_CHECK_PLAN','The selected packages contain none of the requested check steps.');}
    const skipped=[];
    for(const [name,directory]of packages.filter(([name])=>selected.includes(name)))if(steps.includes('test')&&!manifests.get(directory).scripts.test)
        skipped.push({package:name,step:'test',reason:'No npm test script; use the separately configured coverage or integration profile.'});
    for(const [name,directory]of packages.filter(([name])=>selected.includes(name)))if(steps.includes('format:check')&&!manifests.get(directory).scripts['format:check'])
        skipped.push({package:name,step:'format:check',reason:'No npm format:check script configured.'});
    return {mode:'plan',selection:{packages:selected,steps},steps:plan.map(step=>({package:packages.find(([,directory])=>directory===step.directory)[0],
        step:step.args[1],directory:step.directory,command:'npm run '+step.args[1]})),skipped,
        command:'npm run check -- '+selected.map(name=>'--package '+name).join(' ')+' '+steps.map(step=>'--step '+step).join(' '),
        scope:'Only the explicit package/step selection. Shared contracts, agent-kit generation, Compose, coverage and native/integration profiles are excluded.',
        effects:'Planning reads manifests only. Executing a build step later writes normal dist; use build:isolated for a retained candidate.',evidence:evidenceNote};
}
