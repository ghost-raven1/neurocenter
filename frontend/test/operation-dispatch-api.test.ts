import {beforeEach,expect,it,vi} from 'vitest';
import api from '../src/core/api/base';
import bff from '../src/core/api/bff';
vi.mock('../src/core/api/base',()=>({default:{post:vi.fn(async()=>({data:{state:'QUEUED'}}))}}));
beforeEach(()=>vi.clearAllMocks());
it.each(['retryOperation','cancelOperation'] as const)('%s sends the operation identity, fresh CAS and retry key with bounded wait',async action=>{
    await bff[action]('operation/1','request-key','a'.repeat(64));
    expect(api.post).toHaveBeenCalledExactlyOnceWith('/api/operations/operation%2F1/'+(action==='retryOperation'?'retry':'cancel'),{requestKey:'request-key',expectedDigest:'a'.repeat(64)},{timeout:10000});
});
