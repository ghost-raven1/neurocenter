import {describe,expect,it} from 'vitest';
import {MIB,quotaBytes,requirePlatformQuota} from '../src/features/RagQuotaPolicy/model';
const policy={defaultBytes:MIB,maximumBytes:64*1024**3,revision:0,updatedAt:'2026-10-22T00:00:00Z',updatedBy:'admin'};
describe('Exact and confirmed platform quota settings',()=>{
    it('keeps exact bytes and allows an admin maximum above the pilot 16 GiB',()=>{
        expect(quotaBytes(64*1024)).toBe(64*1024**3);expect(quotaBytes(1/MIB)).toBe(1);expect(requirePlatformQuota(policy)).toEqual(policy);
    });
    it.each([undefined,null,'1',0,-1,Infinity,NaN,Number.MAX_SAFE_INTEGER,0.1])('rejects unsafe MiB input %j',value=>expect(()=>quotaBytes(value)).toThrow());
    it.each([null,{}, {...policy,revision:-1},{...policy,defaultBytes:0},{...policy,maximumBytes:1},{...policy,maximumBytes:Number.MAX_SAFE_INTEGER+1},
        {...policy,updatedAt:'invalid'},{...policy,updatedBy:null},{...policy,revision:'0'}])('does not render unconfirmed server values %j',value=>expect(()=>requirePlatformQuota(value)).toThrow());
});
