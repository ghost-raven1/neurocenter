import {beforeEach,describe,expect,it,vi} from 'vitest';
import api from '../src/core/api/base';
import {personalProviderApi} from '../src/features/RemoteProviderAccess/api';
import type {PersonalProviderIntent} from '../src/features/RemoteProviderAccess/model';

vi.mock('../src/core/api/base',()=>({default:{get:vi.fn(),put:vi.fn(),delete:vi.fn()}}));
const id='model/name with spaces',providerId='a'.repeat(64),requestKey='00000000-0000-0000-0000-000000000001';
const view={modelId:id,providerId,providerUrl:'https://provider.test/v1',connectionRevision:4,authMode:'required',credentialRevision:2,hasKey:true,updatedAt:'2026-10-29T10:00:00Z',canStoreKey:true,legacySharedKeyRetained:false};
const receipt={modelId:id,providerId,requestKey,requestHash:'b'.repeat(64),connectionRevision:4,credentialRevision:3,hasKey:true,acceptedAt:'2026-10-29T10:00:00Z'};
const intent:PersonalProviderIntent={version:1,action:'save',providerId,expectedConnectionRevision:4,expectedCredentialRevision:2,requestKey};
beforeEach(()=>vi.resetAllMocks());

describe('personal provider transport keeps the secret only in an explicit own write',()=>{
    it('sends exact save identity and abort signal to the authenticated encoded route',async()=>{
        const abort=new AbortController();vi.mocked(api.put).mockResolvedValueOnce({data:receipt});
        expect(await personalProviderApi.write(id,intent,'key-only-in-body',abort.signal)).toEqual(receipt);
        expect(api.put).toHaveBeenCalledWith('/api/models/model%2Fname%20with%20spaces/my-access',{
            providerId,expectedConnectionRevision:4,expectedCredentialRevision:2,requestKey,apiKey:'key-only-in-body',
        },{signal:abort.signal,timeout:15000});
        expect(api.get).not.toHaveBeenCalled();expect(api.delete).not.toHaveBeenCalled();
    });
    it('DELETE cannot forward a password draft, action or journal version',async()=>{
        vi.mocked(api.delete).mockResolvedValueOnce({data:{...receipt,hasKey:false}});
        await personalProviderApi.write(id,{...intent,action:'delete'},'unsent-new-draft');
        expect(api.delete).toHaveBeenCalledWith('/api/models/model%2Fname%20with%20spaces/my-access',{
            data:{providerId,expectedConnectionRevision:4,expectedCredentialRevision:2,requestKey},signal:undefined,timeout:15000,
        });
        expect(api.put).not.toHaveBeenCalled();
    });
    it('recovery is only GET and distinguishes JSON null from malformed empty transport',async()=>{
        vi.mocked(api.get).mockResolvedValueOnce({data:null}).mockResolvedValueOnce({data:receipt}).mockResolvedValueOnce({data:''});
        expect(await personalProviderApi.receipt(id,requestKey)).toBeNull();
        expect(await personalProviderApi.receipt(id,requestKey)).toEqual(receipt);
        await expect(personalProviderApi.receipt(id,requestKey)).rejects.toThrow('Квитанция');
        expect(api.get).toHaveBeenCalledWith(`/api/models/model%2Fname%20with%20spaces/my-access/requests/${requestKey}`,{signal:undefined,timeout:10000});
        expect(api.put).not.toHaveBeenCalled();expect(api.delete).not.toHaveBeenCalled();
    });
    it('refuses GET plaintext, wrong model/provider shape and unsafe provider URL',async()=>{
        for(const forged of [{...view,apiKey:'must-not-display'},{...view,modelId:'other'},
            {...view,providerId:'invalid'},{...view,authMode:['required']},{...view,providerUrl:'https://user:pass@provider.test/v1'},
            {...view,providerUrl:'https://provider.test/v1?apiKey=secret'}]){
            vi.mocked(api.get).mockResolvedValueOnce({data:forged});await expect(personalProviderApi.read(id)).rejects.toThrow();
        }
        vi.mocked(api.get).mockResolvedValueOnce({data:view});expect(await personalProviderApi.read(id)).toEqual(view);
    });
    it('does not accept receipt plaintext or a receipt belonging to another model',async()=>{
        for(const forged of [{...receipt,apiKey:'secret'},{...receipt,modelId:'other'},{...receipt,credentialRevision:0}]){
            vi.mocked(api.put).mockResolvedValueOnce({data:forged});await expect(personalProviderApi.write(id,intent,'draft')).rejects.toThrow('Квитанция');
        }
    });
});
