'use strict';
const {portablePath}=require('./runtime-artifacts.cjs');
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).every(key=>keys.includes(key));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const fail=()=>{throw Object.assign(new Error('Рецепт сборки содержит неподдерживаемую операцию или не совпадает с закреплённым исходником.'),{code:'SOURCE_RECIPE_INVALID'});};

/** Internal executable recipes contain bounded operations, never shell text or install hooks. */
function validateBuildPlan(plan,inventory){
 if(!exact(plan,['schemaVersion','sourceSha256','entrypoint','targets','steps'])||plan.schemaVersion!==2
   ||!inventory||!Array.isArray(inventory.entrypoints)||!Array.isArray(inventory.resources)||!Array.isArray(inventory.dependencies)
   ||!Array.isArray(inventory.targets)||inventory.targets.length>8||inventory.entrypoints.length>32||inventory.resources.length>200||!/^[a-f0-9]{64}$/.test(inventory.sourceSha256)
   ||plan.sourceSha256!==inventory.sourceSha256||!same(plan.targets,inventory.targets)
   ||!Array.isArray(plan.steps)||plan.steps.length!==4)fail();
 const candidate=inventory.entrypoints.find(item=>item.path===plan.entrypoint);
 if(!candidate||candidate.runtime!=='node24')fail();
 const [dependencies,compile,resources,verify]=plan.steps;
 if(!exact(dependencies,['op','mode','lockSha256'])||dependencies.op!=='dependencies'
   ||dependencies.mode!==(inventory.dependencies.length?'locked':'none')||dependencies.lockSha256!==(inventory.lockSha256??null))fail();
 if(!exact(compile,['op','runtime','mode'])||compile.op!=='compile'||compile.runtime!=='node24'||!candidate.modes.includes(compile.mode))fail();
 if(!exact(resources,['op','paths'])||resources.op!=='copy-resources'||!Array.isArray(resources.paths)||resources.paths.length>200
   ||new Set(resources.paths).size!==resources.paths.length||resources.paths.some(file=>!portablePath(file)||!inventory.resources.includes(file)))fail();
 if(compile.mode==='preserve'&&inventory.resources.some(file=>!resources.paths.includes(file)))fail();
 if(!exact(verify,['op','profile'])||verify.op!=='verify'||verify.profile!=='isolated-startup')fail();
 const normalized=structuredClone(plan);normalized.steps[2].paths.sort();return normalized;
}
module.exports={validateBuildPlan};
