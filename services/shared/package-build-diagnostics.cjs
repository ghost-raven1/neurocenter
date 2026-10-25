'use strict';
const stages=['inspect','download','dependencies','compile','pack','build'];
const codes={SOURCE_DEPENDENCY_INVALID:false,SOURCE_DEPENDENCY_LOCK_REQUIRED:false,SOURCE_RUNTIME_UNSUPPORTED:false,
 SOURCE_RESOURCE_UNSUPPORTED:false,SOURCE_COMPILE_FAILED:true,SOURCE_ENTRYPOINT_INVALID:true,BUILD_FAILED:false,
 PYTHON_DEPENDENCIES_UNAVAILABLE:false,PYTHON_RUNTIME_UNAVAILABLE:false,PYTHON_SOURCE_INVALID:false};
/** Bounded diagnostics are data; credentials, URLs and host paths never enter model context/history. */
function cleanBuildReason(value){return String(value??'').slice(-8192).replace(/[\x00-\x1f\x7f]/g,' ')
 .replace(/(?:Bearer\s+\S+|(?:password|secret|token|authorization|credential|api[_-]?key)["']?\s*[:=]\s*["']?[^\s,"'}]+)/gi,'[secret]')
 .replace(/https?:\/\/\S+/gi,'[url]').replace(/(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)[^\s:]+/gi,'[private-path]').slice(0,1000);}
function parseBuildDiagnostic(value,targets){
 if(!value||value.schemaVersion!==1||!stages.includes(value.stage)||!Object.hasOwn(codes,value.code)
   ||value.target!==null&&(!Array.isArray(targets)||!targets.includes(value.target))||typeof value.reason!=='string')return;
 return {schemaVersion:1,stage:value.stage,target:value.target,code:value.code,reason:cleanBuildReason(value.reason),repairable:codes[value.code]};
}
async function withBuildDiagnostic(stage,target,work){
 try{return await work();}catch(error){
  if(!error||typeof error!=='object')error=new Error('Сборка прервана.');
  error.buildDiagnostic??={schemaVersion:1,stage,target,code:Object.hasOwn(codes,error.code)?error.code:stage==='compile'?'SOURCE_COMPILE_FAILED':'BUILD_FAILED',reason:cleanBuildReason(error.message)};
  throw error;
 }
}
module.exports={cleanBuildReason,parseBuildDiagnostic,withBuildDiagnostic};
