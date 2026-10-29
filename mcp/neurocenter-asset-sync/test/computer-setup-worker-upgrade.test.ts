import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {api,readState,stateDir} from '../src/bridge/state.js';
import {recoverComputerSetupJobs} from '../src/features/computer-setup/executor.js';
import {ensureCurrentWorker,prepareWorkerUpgrade} from '../src/bridge/worker-upgrade.js';

const{execute}=vi.hoisted(()=>({execute:vi.fn()}));
vi.mock('node:child_process',()=>({execFile:Object.assign(vi.fn(),{[Symbol.for('nodejs.util.promisify.custom')]:execute})}));
vi.mock('../src/bridge/state.js',()=>({api:vi.fn(),readState:vi.fn(),stateDir:vi.fn()}));
vi.mock('../src/bridge/protocol.js',()=>({BRIDGE_VERSION:'test-version',bridgeBuildId:async()=>'same-build'}));
vi.mock('../src/features/computer-setup/executor.js',()=>({recoverComputerSetupJobs:vi.fn()}));

describe('Installer cannot replace native runtime before the CLI cleanup fence',()=>{
    let root:string,lock:string,dead:boolean,previous:PropertyDescriptor;const pid=1234567,entry=path.join(os.tmpdir(),'owned-cli-upgrade','dist','index.js');
    beforeEach(async()=>{
        vi.resetAllMocks();previous=Object.getOwnPropertyDescriptor(process,'platform')!;Object.defineProperty(process,'platform',{value:'darwin'});
        root=await fs.mkdtemp(path.join(os.tmpdir(),'neurocenter-cli-upgrade-'));lock=path.join(root,'worker.lock');dead=false;
        vi.mocked(stateDir).mockReturnValue(root);vi.mocked(readState).mockResolvedValue({pid,version:'test-version',buildId:'same-build'});
        vi.mocked(api).mockResolvedValue({activeJobs:0});vi.mocked(recoverComputerSetupJobs).mockResolvedValue();
        execute.mockResolvedValue({stdout:`${process.getuid?.()} ${process.execPath} ${entry} --worker`});
        vi.spyOn(process,'kill').mockImplementation((_pid,signal)=>{if(signal==='SIGTERM'){dead=true;return true;}if(dead)throw Object.assign(new Error('gone'),{code:'ESRCH'});return true;});
    });
    afterEach(async()=>{Object.defineProperty(process,'platform',previous);vi.restoreAllMocks();await fs.rm(root,{recursive:true,force:true});});
    it.each(['no lock','dead lock','graceful stop'])('blocks a successful replacement for %s when durable cleanup remains uncertain',async mode=>{
        if(mode!=='no lock')await fs.writeFile(lock,String(pid));if(mode==='dead lock')dead=true;
        vi.mocked(recoverComputerSetupJobs).mockRejectedValue(new Error('private CLI cleanup blocker'));
        await expect(prepareWorkerUpgrade(entry)).rejects.toThrow('CLI cleanup blocker');expect(recoverComputerSetupJobs).toHaveBeenCalledOnce();
        expect(api).toHaveBeenLastCalledWith('worker/resume');
    });
    it('runs orphan cleanup without contacting API when both worker and credentials are absent',async()=>{
        vi.mocked(readState).mockResolvedValue(undefined);await expect(prepareWorkerUpgrade(entry)).resolves.toEqual({paused:false});
        expect(recoverComputerSetupJobs).toHaveBeenCalledOnce();expect(api).not.toHaveBeenCalled();
    });
    it('checks cleanup on the same-build early return without stealing a live journal',async()=>{
        await fs.writeFile(lock,String(pid));vi.mocked(recoverComputerSetupJobs).mockRejectedValue(new Error('live CLI owner'));
        await expect(ensureCurrentWorker()).rejects.toThrow('live CLI owner');expect(recoverComputerSetupJobs).toHaveBeenCalledOnce();
        expect(process.kill).not.toHaveBeenCalledWith(pid,'SIGTERM');expect(api).not.toHaveBeenCalled();
    });
    it('waits for graceful worker exit before recovering its journal and returning a replacement permit',async()=>{
        await fs.writeFile(lock,String(pid));vi.mocked(recoverComputerSetupJobs).mockImplementation(async()=>{expect(dead).toBe(true);expect(api).toHaveBeenCalledWith('worker/pause');});
        await expect(prepareWorkerUpgrade(entry)).resolves.toEqual({paused:true});expect(recoverComputerSetupJobs).toHaveBeenCalledOnce();
        expect(api).not.toHaveBeenCalledWith('worker/resume');
    });
});
