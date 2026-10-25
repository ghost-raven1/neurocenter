import assert from 'node:assert/strict';
import {test} from 'node:test';
import {cleanBuildReason,parseBuildDiagnostic,withBuildDiagnostic} from '../../../services/shared/package-build-diagnostics.cjs';

test('Bounded reason redacts quoted secrets, bearer credentials, URLs and private paths',()=>{
 const reason=cleanBuildReason('Authorization: Bearer PRIVATE_BEARER password="PRIVATE WITH SPACES" token='+('X'.repeat(20000))+' https://private.invalid /Users/private/source');
 assert.ok(reason.length<=1000);assert.doesNotMatch(reason,/PRIVATE|X{20}/);
 assert.doesNotMatch(cleanBuildReason('https://private.invalid /Users/private/source'),/private\.invalid|\/Users\/private/);
 assert.doesNotMatch(cleanBuildReason('password="'+('PRIVATE LONG VALUE '.repeat(2000))+'"'),/PRIVATE|LONG|VALUE/);
});
test('Only located source compilation failures are classified as repairable',async()=>{
 for(const [error,code] of [[Object.assign(Error('Invalid source'),{errors:[{location:{file:'index.ts'}}]}),'SOURCE_COMPILE_FAILED'],
  [Object.assign(Error('Compiler service stopped'),{errors:[{location:null}]}),'BUILD_FAILED']]){
  try{await withBuildDiagnostic('compile','darwin-arm64',async()=>{throw error;});assert.fail('Expected failure');}
  catch(failure){const report=parseBuildDiagnostic(failure.buildDiagnostic,['darwin-arm64']);assert.equal(report.code,code);assert.equal(report.repairable,code==='SOURCE_COMPILE_FAILED');}
 }
 const forged=parseBuildDiagnostic({schemaVersion:1,stage:'build',target:'darwin-arm64',code:'SOURCE_COMPILE_FAILED',reason:'Forged retry',repairable:true},['darwin-arm64']);
 assert.equal(forged.repairable,false);
});
