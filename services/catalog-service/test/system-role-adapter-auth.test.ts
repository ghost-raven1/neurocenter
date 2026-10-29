import {describe,expect,it,vi} from 'vitest';
import {SystemRoleTargets} from '../src/system-roles/system-role.targets';
import {RemoteConnectionRepository,type IRemoteConnectionRow} from '../src/models/remote-connection.repository';
import {remoteConnectionInput} from '../src/models/remote-model-validation';

describe('system-role adapter changes preserve personal provider authorization',()=>{
    it.each([
        {authMode:'required',credential:'none'},
        {authMode:'optional',credential:'none'},
        {authMode:'required',credential:'stored'},
        {authMode:'required',credential:'environment'},
    ]as const)('applies and rolls back options without downgrading $authMode or forwarding $credential legacy credentials',async({authMode,credential})=>{
        const id='model-role-adapter',actor={email:'main@role.test',activeRole:'Главный админ'},req={}as never;
        const row={model_id:id,revision:1,base_url:'https://provider.test/v1',request_dimensions:false,options:{temperature:0.4},timeout_ms:90000,
            auth_mode:credential==='none'?authMode:null,credential_kind:credential,credential:credential==='stored'?{}:null,credential_env:credential==='environment'?'LEGACY_SECRET_ENV':null,
            semantic_sha:'a'.repeat(64),verified_at:'2026-10-29',revoked_at:null,failure_message:null}as IRemoteConnectionRow;
        let view=new RemoteConnectionRepository({}as never,{LEGACY_SECRET_ENV:'must-not-forward'}).view(id,row,3);
        const read=vi.fn(async()=>view),save=vi.fn(async(_id:string,raw:unknown,_actor:string,authorize:()=>Promise<unknown>)=>{
            await authorize();const parsed=remoteConnectionInput(raw);
            expect(parsed.authMode).toBe(authMode);expect(parsed.credential).toBe('none');
            expect(raw).not.toHaveProperty('apiKey');expect(raw).not.toHaveProperty('credential');expect(raw).not.toHaveProperty('credentialEnv');
            expect(JSON.stringify(raw)).not.toContain('LEGACY_SECRET_ENV');expect(JSON.stringify(raw)).not.toContain('must-not-forward');
            view={...view,revision:view.revision+1,modelRevision:view.modelRevision+1,options:parsed.options??{},authMode:parsed.authMode};return view;
        });
        const requireMain=vi.fn(async()=>actor),policy={actor:async()=>actor,models:{get:async()=>({runtime:'remote-openai',capability:'chat'}),requireMain}};
        const targets=new SystemRoleTargets(policy as never,{}as never,{}as never,{read,save}as never);
        const selection={projectId:null,targets:[{kind:'adapter',id}]},target=await targets.read(req,selection as never,selection.targets[0]as never);
        const prepared={selection,targets:[target]}as never;
        const receipt=await targets.write(req,prepared,target,JSON.stringify({temperature:0.2}),'apply');
        expect(view.authMode).toBe(authMode);expect(view.options).toEqual({temperature:0.2});
        await targets.write(req,prepared,target,'unused','rollback',receipt);
        expect(view.authMode).toBe(authMode);expect(view.options).toEqual({temperature:0.4});expect(save).toHaveBeenCalledTimes(2);expect(requireMain).toHaveBeenCalledTimes(2);
    });
});
