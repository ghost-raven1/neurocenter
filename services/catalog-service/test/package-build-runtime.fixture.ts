import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import type {BuildRuntimeReport} from '../src/package-build/build-runtime';

/** Structural receipt for queue-boundary tests; actual OS/protocol execution has separate tests. */
export async function runtimeReportFixture(manifest:string,identity:string,passed=true):Promise<BuildRuntimeReport>{
    return {schemaVersion:1,ok:passed,status:passed?'passed':'failed',candidate:{identity,sourceDigest:'a'.repeat(64),assetId:'queue-runtime-fixture',version:1,
        manifestSha256:createHash('sha256').update(await fs.readFile(manifest)).digest('hex')},hostTarget:'darwin-arm64',testedTarget:'darwin-arm64',untestedTargets:[],
        isolation:{kind:'unit-fixture',osEnforced:true,network:'denied',childProcesses:'denied',disposableProfile:true},
        checks:{integrity:true,initialize:false,toolsList:false,pluginFactory:passed,hooks:passed},counts:{tools:0,pluginHooks:passed?1:0},
        diagnostics:passed?[]:[{code:'plugin-initialization-failed',message:'Проверяемый плагин не инициализировался.'}],
        startedAt:'2026-10-23T00:00:00.000Z',finishedAt:'2026-10-23T00:00:00.001Z',durationMs:1};
}
