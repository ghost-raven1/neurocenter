import {describe,expect,it} from 'vitest';
import {openUserCredential,remoteAuthMode,remoteMutationHash,remoteProviderId,remoteProviderMutation,sealUserCredential} from '../src/remote-providers/remote-provider.identity';
const environment={NEUROCENTER_MODEL_CREDENTIAL_KEY:Buffer.alloc(32,11).toString('base64')};
const provider='a'.repeat(64),key='user-alice-private-key';
const input={providerId:provider,expectedConnectionRevision:2,expectedCredentialRevision:0,requestKey:'00000000-0000-0000-0000-000000000001',apiKey:key};
describe('personal remote provider identity and ciphertext',()=>{
    it('encrypts with distinct nonce and binds decryption to exact owner/provider/revision',()=>{
        const secret=sealUserCredential(key,'alice@test',provider,1,environment);
        expect(JSON.stringify(secret)).not.toContain(key);expect(openUserCredential(secret,'alice@test',provider,1,environment)).toBe(key);
        expect(sealUserCredential(key,'alice@test',provider,1,environment).nonce).not.toBe(secret.nonce);
        for(const [owner,id,revision]of[['bob@test',provider,1],['alice@test','b'.repeat(64),1],['alice@test',provider,2]]as const)
            expect(()=>openUserCredential(secret,owner,id,revision,environment)).toThrow();
    });
    it('changes provider identity only for model/runtime/recipient, never key or generation options',()=>{
        const model={id:'model-a',runtime:'remote-openai' as const},row={base_url:'https://provider.test/v1/'};
        const first=remoteProviderId(model,row);expect(remoteProviderId(model,{base_url:'https://provider.test/v1'})).toBe(first);
        expect(remoteProviderId({...model,id:'model-b'},row)).not.toBe(first);expect(remoteProviderId({...model,runtime:'remote-ollama'},row)).not.toBe(first);
        expect(remoteProviderId(model,{base_url:'https://another.test/v1'})).not.toBe(first);
    });
    it('does not infer an owner from legacy keys; maps only the documented authentication requirement',()=>{
        expect(remoteAuthMode({credential_kind:'none'})).toBe('none');expect(remoteAuthMode({credential_kind:'stored'})).toBe('required');expect(remoteAuthMode({credential_kind:'environment'})).toBe('required');
        expect(remoteAuthMode({credential_kind:'stored',auth_mode:'none'})).toBe('none');
    });
    it('binds private request HMAC to actor/provider/body and rejects owner/address/body injection',()=>{
        const fingerprint=remoteMutationHash('model-a','alice@test','save',input,environment);expect(fingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(remoteMutationHash('model-a','bob@test','save',input,environment)).not.toBe(fingerprint);
        expect(remoteMutationHash('model-a','alice@test','save',{...input,apiKey:'different'},environment)).not.toBe(fingerprint);
        expect(remoteProviderMutation(input,'save')).toEqual(input);
        for(const extra of[{ownerEmail:'bob@test'},{baseUrl:'https://evil.test'},{activeRole:'Главный админ'}])expect(()=>remoteProviderMutation({...input,...extra},'save')).toThrow();
        expect(()=>remoteProviderMutation({...input,apiKey:'a\nb'},'save')).toThrow();expect(()=>remoteProviderMutation(input,'delete')).toThrow();
    });
    it('delete identity is available even if the server encryption key is temporarily unavailable',()=>{
        const {apiKey:_secret,...remove}=input;
        expect(remoteMutationHash('model-a','alice@test','delete',remove,{})).toMatch(/^[a-f0-9]{64}$/);
    });
});
