import {describe,expect,it} from 'vitest';
import {OPENCODE_CLI_INSTALL_JOB,openCodeInstallRuntimeTarget,normalizeOpenCodeInstallRequest,normalizeOpenCodeInstallSupply,normalizeOpenCodeInstallPayload,normalizeOpenCodeInstallResult} from '../../shared/opencode-cli-install.cjs';
const deviceId='00000000-0000-0000-0000-000000000001',jobId='00000000-0000-0000-0000-000000000002';
const source={buildId:'a'.repeat(64),target:'darwin-arm64',version:'1.14.48',sha256:'b'.repeat(64)};
const payload={schemaVersion:1,scope:'global',deviceId,source};
const result={...payload,jobId,checkedAt:'2026-10-29T12:00:00.000Z',status:'installed',installedVersion:'1.14.48',commandVersion:null,commandReady:false,nextAction:'inspect-path'};
describe('fixed bundled OpenCode CLI installation contract',()=>{
    it('accepts only a device-global UUID intent, not executable, target, version, secret or URL overrides',()=>{
        const input={deviceId,kind:OPENCODE_CLI_INSTALL_JOB,scope:'global',requestKey:jobId};expect(normalizeOpenCodeInstallRequest(input)).toEqual(input);
        for(const extra of [{command:'curl'},{path:'/tmp/cli'},{source},{version:'latest'},{apiKey:'secret'},{url:'https://elsewhere.test'},{projectId:'prj'}])expect(()=>normalizeOpenCodeInstallRequest({...input,...extra})).toThrow();
    });
    it('pins exact bridge build/target and binary SHA without a local path',()=>{
        expect(normalizeOpenCodeInstallSupply(source)).toEqual(source);expect(normalizeOpenCodeInstallPayload(payload)).toEqual(payload);
        for(const extra of [{buildId:'source-0.9.27'},{target:'win32-x64'},{sha256:'bad'},{version:'1.14.49'},{file:'../opencode'}])expect(()=>normalizeOpenCodeInstallSupply({...source,...extra})).toThrow();
    });
    it.each([['linux-x64','linux-x64-glibc'],['linux-arm64','linux-arm64-glibc'],['linux-x64-musl','linux-x64-musl'],['linux-arm64-musl','linux-arm64-musl'],['darwin-arm64','darwin-arm64']])('keeps actual bridge target %s distinct from runtime target %s', (target,runtime)=>{
        expect(normalizeOpenCodeInstallSupply({...source,target}).target).toBe(target);expect(openCodeInstallRuntimeTarget(target)).toBe(runtime);
    });
    it('never equates copied binary with ordinary PATH readiness',()=>{
        expect(normalizeOpenCodeInstallResult(result,{deviceId,jobId,source})).toEqual(result);
        expect(()=>normalizeOpenCodeInstallResult({...result,commandReady:true})).toThrow();
        expect(normalizeOpenCodeInstallResult({...result,commandVersion:'1.14.48',commandReady:true,nextAction:'none'})).toMatchObject({commandReady:true});
        expect(normalizeOpenCodeInstallResult({...result,status:'unchanged',installedVersion:'1.15.0',commandVersion:'1.15.0',commandReady:true,nextAction:'none'})).toMatchObject({status:'unchanged'});
    });
    it('rejects cross-device/job/build completion and plaintext output',()=>{
        for(const extra of [{deviceId:jobId},{jobId:deviceId},{source:{...source,sha256:'c'.repeat(64)}},{stdout:'private'},{path:'/Users/private'}])expect(()=>normalizeOpenCodeInstallResult({...result,...extra},{deviceId,jobId,source})).toThrow();
        expect(()=>normalizeOpenCodeInstallResult({...result,status:'unknown',nextAction:'retry'})).toThrow();
    });
});
