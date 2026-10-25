import {afterEach,beforeEach,it,expect,vi} from 'vitest';
import {fileURLToPath} from 'node:url';

const {execute}=vi.hoisted(()=>({execute:vi.fn()}));
vi.mock('node:child_process',()=>({spawn:vi.fn(),execFile:Object.assign(vi.fn(),{[Symbol.for('nodejs.util.promisify.custom')]:execute})}));
import {findRoleMcpProcess,roleMcpProcessOwner} from '../src/features/system-role-mcp/owned-process.js';

const runner=fileURLToPath(new URL('../src/features/system-role-mcp/owned-runner.ts',import.meta.url));
const nonce='5da239be-50b3-4715-ab8f-d14ff8a7d936',receipt='/tmp/роль с пробелами/закрыто.json',pid=87654;
const birth='Sun Oct 25 22:00:23 2026',command=process.execPath+' '+runner+' --role-mcp-owner '+nonce+' '+receipt;
const status={stdout:`${process.getuid!()} ${pid} ${birth} S ${command}\n`};
beforeEach(()=>{execute.mockReset();vi.stubEnv('LC_ALL','ru_RU.UTF-8');vi.stubEnv('LC_CTYPE','C');});
afterEach(()=>vi.unstubAllEnvs());

it('pins ps to UTF-8 with stable English dates instead of inheriting the caller locale',async()=>{
 execute.mockResolvedValue(status);
 expect(await roleMcpProcessOwner(pid,runner)).toEqual({pid,uid:process.getuid!(),birth,entry:runner});
 expect(execute).toHaveBeenCalledWith('/bin/ps',['-ww','-p',String(pid),'-o','uid=,pgid=,lstart=,stat=,command='],
  expect.objectContaining({env:{PATH:'/usr/bin:/bin',LC_ALL:'C.UTF-8'}}));
});

it('uses the same deterministic UTF-8 locale when recovering the exact Unicode ownership command',async()=>{
 execute.mockResolvedValueOnce({stdout:`${pid} ${process.getuid!()} ${command}\n`}).mockResolvedValueOnce(status);
 expect(await findRoleMcpProcess(nonce,receipt)).toEqual({pid,uid:process.getuid!(),birth,entry:runner});
 expect(execute).toHaveBeenCalledTimes(2);
 for(const [, ,options]of execute.mock.calls)expect(options.env).toEqual({PATH:'/usr/bin:/bin',LC_ALL:'C.UTF-8'});
});
