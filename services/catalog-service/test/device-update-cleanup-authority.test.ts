import {afterEach,describe,expect,it,vi} from 'vitest';
const permission=vi.hoisted(()=>({check:vi.fn(async()=>{})}));
vi.mock('../src/features/require-feature-enabled',()=>({requireFeaturesEnabled:permission.check}));
import {DeviceController} from '../src/devices/device.controller';
const owner={id:'d',email:'qa@example.test',role:'Разработчик',report:{capabilities:['bridge-update-cleanup-v1']}};
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();permission.check.mockReset().mockResolvedValue(undefined);});
function fixture(){
 vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','qa-cleanup-only');
 const devices={identity:vi.fn(async()=>owner)};
 const controller=new DeviceController(devices as never,{} as never,{} as never,{} as never,{} as never);
 const request={headers:{'x-neurocenter-internal':'qa-cleanup-only',authorization:'Bearer qa'}};
 return {devices,run:()=>controller.cleanupAuthority(request as never)};
}
describe('Automatic update cleanup is subordinate to fresh authority',()=>{
 it('requires the feature between fresh device and role reads',async()=>{const f=fixture();await expect(f.run()).resolves.toEqual({ok:true});expect(permission.check).toHaveBeenCalledWith(['bridge_storage_cleanup']);expect(f.devices.identity).toHaveBeenCalledTimes(2);});
 it('defers when the flag service denies or cannot answer',async()=>{const f=fixture();permission.check.mockRejectedValueOnce(Error('offline'));await expect(f.run()).rejects.toThrow('offline');});
 it('rejects revoked identity or a role changed while the flag check awaited',async()=>{
  const f=fixture();f.devices.identity.mockResolvedValueOnce(owner).mockResolvedValueOnce({...owner,role:'Пользователь'});
  await expect(f.run()).rejects.toThrow(/изменилось/);
  f.devices.identity.mockRejectedValueOnce(Error('revoked'));await expect(f.run()).rejects.toThrow('revoked');
 });
 it('rejects a bridge capability lost while the flag check awaited',async()=>{
  const f=fixture();f.devices.identity.mockResolvedValueOnce(owner).mockResolvedValueOnce({...owner,report:{capabilities:[]}});
  await expect(f.run()).rejects.toThrow(/изменилось/);
 });
});
