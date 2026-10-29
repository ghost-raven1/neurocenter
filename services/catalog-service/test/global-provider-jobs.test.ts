import {expect,it,vi} from 'vitest';
import {assertGlobalProvidersInput,assertGlobalProvidersJob,globalProvidersJobPayload,completeGlobalProviders,authorizeGlobalProvidersSession,assertGlobalProvidersAuthority} from '../src/devices/global-provider-jobs';
import {digest,type Device} from '../src/devices/device-store';
const deviceId='11111111-1111-4111-8111-111111111111',requestKey='22222222-2222-4222-8222-222222222222';
const device={id:deviceId,email:'developer@example.test',role:'Разработчик',report:{capabilities:['opencode-global-providers-v1']}} as Device;
const request={deviceId,kind:'inspect-opencode-global-providers',scope:'global',requestKey};
it('fixed public admission excludes secrets, caller expiry, folders and project scope before DB lookup',()=>{
    expect(()=>assertGlobalProvidersInput(request)).not.toThrow();
    for(const fields of [{apiKey:'SYNTHETIC_PRIVATE'},{expiresAt:'2026-10-29T00:15:00.000Z'},{projectId:'project'},{scope:'project'},{path:'/tmp/auth.json'}])expect(()=>assertGlobalProvidersInput({...request,...fields})).toThrow();
});
it('read and open bind the owned computer and independently require reader/writer roles and native capability',()=>{
    const payload=globalProvidersJobPayload(device,request,'Разработчик');expect(payload).toEqual({schemaVersion:1,scope:'global',deviceId});
    expect(()=>assertGlobalProvidersJob(device,{kind:request.kind,payload,project_id:null,device_id:deviceId,email:'other@example.test',role:'Разработчик'})).toThrow();
    expect(()=>globalProvidersJobPayload({...device,role:'Наблюдатель'},{...request,kind:'open-opencode-global-providers'},'Наблюдатель')).toThrow();
    expect(()=>globalProvidersJobPayload({...device,report:{capabilities:[]}},request,'Разработчик')).toThrow();
    const opened=globalProvidersJobPayload(device,{...request,kind:'open-opencode-global-providers'},'Разработчик');expect(Date.parse(String(opened?.expiresAt))).toBeGreaterThan(Date.now());
});
it('terminal recovery normalizes receipt identity and forbids unknown fields or overwriting a completed outcome',async()=>{
    const db={query:vi.fn()},payload={schemaVersion:1,scope:'global',deviceId},job={id:requestKey,kind:request.kind,payload,project_id:null,device_id:deviceId,email:device.email,role:device.role,state:'failed',result:{schemaVersion:1,scope:'global',deviceId,jobId:requestKey,kind:request.kind,checkedAt:'2026-10-29T00:00:00.000Z',status:'failed',issue:'unknown'}};
    await expect(completeGlobalProviders(db,job,{state:'failed',result:job.result,message:'ignored'} as never)).resolves.toMatchObject({ok:true,repeated:true});expect(db.query).not.toHaveBeenCalled();
    await expect(completeGlobalProviders(db,job,{state:'failed',result:{...job.result,apiKey:'SYNTHETIC_PRIVATE'},message:'ignored'} as never)).rejects.toThrow();
    await expect(completeGlobalProviders(db,job,{state:'failed',result:{...job.result,issue:'read-failed'},message:'ignored'} as never)).rejects.toThrow();expect(db.query).not.toHaveBeenCalled();
});
it('same-device bearer rotation while feature admission awaits prevents a final local-window permit',async()=>{
    const token='a'.repeat(64);let currentHash=digest(token),release!:()=>void,entered!:()=>void;
    const held=new Promise<void>(done=>{release=done;}),atFlag=new Promise<void>(done=>{entered=done;});
    const payload={schemaVersion:1,scope:'global',deviceId,expiresAt:new Date(Date.now()+60000).toISOString()};
    const job={id:requestKey,device_id:deviceId,email:device.email,role:device.role,kind:'open-opencode-global-providers',project_id:null,state:'succeeded',payload};
    const pool={query:vi.fn(async(sql:string,values:unknown[]=[])=>{
        if(sql.startsWith('SELECT * FROM bridge_jobs'))return{rows:[job]};
        if(sql.startsWith('SELECT * FROM bridge_devices'))return{rows:[device]};
        if(sql.startsWith('SELECT enabled,is_main_admin'))return{rows:[{enabled:true,is_main_admin:false}]};
        if(sql.startsWith('SELECT member.role'))return{rows:[{role:device.role}]};
        if(sql.startsWith('SELECT account.enabled'))return{rows:!sql.includes('device.token_hash')||values.includes(currentHash)?[{authorized:true}]:[]};
        throw Error('Unexpected SQL boundary');
    })};
    const pending=authorizeGlobalProvidersSession({pool} as never,device,{jobId:requestKey},async()=>{entered();await held;},token);
    await atFlag;currentHash=digest('b'.repeat(64));release();await expect(pending).rejects.toMatchObject({status:403});
});
it('running authorization binds the original request bearer after the caller’s asynchronous feature check',async()=>{
    const old='a'.repeat(64),currentHash=digest('b'.repeat(64)),db={query:vi.fn(async(sql:string,values:unknown[])=>({rows:!sql.includes('device.token_hash')||values.includes(currentHash)?[{authorized:true}]:[]}))};
    const input={id:requestKey,device_id:deviceId,email:device.email,role:device.role,lease:requestKey,kind:'inspect-opencode-global-providers',payload:{schemaVersion:1,scope:'global',deviceId}};
    await expect(assertGlobalProvidersAuthority(db as never,device,input as never,old)).rejects.toMatchObject({status:409});
});
