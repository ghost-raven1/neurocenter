import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
const mocks=vi.hoisted(()=>({spawn:vi.fn()}));
vi.mock('node:child_process',()=>({spawnSync:mocks.spawn}));
import {stopWindowsBuildTree} from '../src/package-build/windows-build-process';

describe('Windows tree cancellation command admission (not a Windows OS acceptance)',()=>{
    afterEach(()=>vi.unstubAllEnvs());
    beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('SystemRoot','C:\\Windows');mocks.spawn.mockReturnValue({status:0,signal:null});});
    it('Uses fixed System32 taskkill with one owned numeric PID and no shell',()=>{
        stopWindowsBuildTree(321);
        expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith('C:\\Windows\\System32\\taskkill.exe',['/PID','321','/T','/F'],{shell:false,windowsHide:true,stdio:'ignore',timeout:5000});
    });
    it.each([0,-1,1.5,NaN,Infinity])('Rejects an invalid PID %s before process execution',pid=>{
        expect(()=>stopWindowsBuildTree(pid)).toThrow('Invalid owned builder PID');expect(mocks.spawn).not.toHaveBeenCalled();
    });
    it.each([{status:1},{status:null,error:Error('ENOENT')},{status:null,signal:'SIGTERM'}])('A failed or uncertain tree kill never becomes a positive acknowledgment',result=>{
        mocks.spawn.mockReturnValue(result);expect(()=>stopWindowsBuildTree(321)).toThrow('termination is not confirmed');
    });
    it('Does not search PATH or run a caller-provided relative Windows executable',()=>{
        vi.stubEnv('SystemRoot','relative');expect(()=>stopWindowsBuildTree(321)).toThrow('system directory');expect(mocks.spawn).not.toHaveBeenCalled();
    });
});
