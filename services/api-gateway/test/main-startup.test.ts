import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const fixture=vi.hoisted(()=>({
    uses:[] as unknown[][],handlers:new Map<string,Function>(),socketMiddleware:null as Function|null,
    socketOptions:null as Record<string,any>|null,authenticate:vi.fn(),bridge:vi.fn(),attach:vi.fn(),
    listen:vi.fn(),shutdown:vi.fn(),json:vi.fn(),create:vi.fn(),docs:vi.fn(),server:{},
}));
vi.mock('../../shared/runtime.cjs',()=>({}));
vi.mock('../../shared/observability.cjs',()=>({createObservability:()=>({middleware:vi.fn()})}));
vi.mock('../src/app.module',()=>({AppModule:class AppModule{}}));
vi.mock('../src/auth/auth-guard.service',()=>({AuthGuardService:class AuthGuardService{}}));
vi.mock('../src/live/live.service',()=>({LiveService:class LiveService{}}));
vi.mock('../src/docs/setup-api-documentation',()=>({setupApiDocumentation:fixture.docs}));
vi.mock('../src/proxy/source-upload-stream',()=>({sourceUploadConnection:vi.fn()}));
vi.mock('express',()=>({default:{json:fixture.json}}));
vi.mock('@nestjs/core',()=>({NestFactory:{create:fixture.create}}));
vi.mock('socket.io',()=>({Server:class {
    constructor(server:unknown,options:Record<string,any>){expect(server).toBe(fixture.server);fixture.socketOptions=options;}
    use(callback:Function){fixture.socketMiddleware=callback;}
    on(event:string,callback:Function){fixture.handlers.set(event,callback);}
}}));

/** Boots the actual entrypoint while keeping the listener and transports in this test process. */
async function boot(configured=false){
    if(configured){vi.stubEnv('PORT','48123');vi.stubEnv('BIND_HOST','0.0.0.0');}
    await import('../src/main');
    await vi.waitFor(()=>expect(fixture.listen).toHaveBeenCalledOnce());
}
function socket(user:unknown=null){
    const events=new Map<string,Function>();
    return {data:{user,authRequest:{headers:{cookie:'bridge_session=own'}}} as Record<string,any>,
        request:{headers:{cookie:'bridge_session=own'}},handshake:{auth:{} as Record<string,unknown>},
        join:vi.fn(),disconnect:vi.fn(),on:vi.fn((event:string,callback:Function)=>events.set(event,callback)),events};
}
beforeEach(()=>{
    vi.resetModules();vi.clearAllMocks();vi.useFakeTimers();
    vi.stubEnv('NODE_ENV','test');vi.stubEnv('PORT','');vi.stubEnv('BIND_HOST','');vi.stubEnv('PANEL_URL','https://panel.example.test');
    fixture.uses=[];fixture.handlers.clear();fixture.socketMiddleware=null;fixture.socketOptions=null;
    fixture.json.mockImplementation(()=>vi.fn((_req,_res,next)=>next()));
    fixture.listen.mockResolvedValue(undefined);
    fixture.create.mockResolvedValue({enableShutdownHooks:fixture.shutdown,use:(...args:unknown[])=>fixture.uses.push(args),
        listen:fixture.listen,getHttpServer:()=>fixture.server,
        get:(token:Function)=>token.name==='AuthGuardService'?{authenticate:fixture.authenticate}:{attach:fixture.attach,bridge:fixture.bridge}});
    vi.spyOn(console,'log').mockImplementation(()=>{});
});
afterEach(()=>{vi.useRealTimers();vi.unstubAllEnvs();vi.restoreAllMocks();});

describe('Gateway startup and stream boundaries',()=>{
    it.each([false,true])('uses the selected bind address without opening a real listener: configured=%s',async configured=>{
        await boot(configured);
        expect(fixture.listen).toHaveBeenCalledWith(configured?48123:4000,configured?'0.0.0.0':'127.0.0.1');
        expect(fixture.shutdown).toHaveBeenCalledOnce();
        expect(fixture.json).toHaveBeenNthCalledWith(1,{limit:'512kb'});
        expect(fixture.json).toHaveBeenNthCalledWith(2,{limit:'50mb'});
        expect(fixture.uses.some(args=>args[0]==='/api/device-channel')).toBe(true);
        expect(fixture.attach).toHaveBeenCalledOnce();
        expect(fixture.docs).toHaveBeenCalledOnce();
    });
    it.each([
        ['PUT','/api/asset-sources/archive',true],
        ['PUT','/api/tool-builds/uploads/01234567-89ab-4cde-8f01-23456789abcd/content',true],
        ['PUT','/api/projects/prj-owned/snapshot-uploads/01234567-89ab-4cde-8f01-23456789abcd/blobs/'+'a'.repeat(64),true],
        ['POST','/api/asset-sources/archive',false],
        ['PUT','/api/tool-builds/uploads/not-a-uuid/content',false],
        ['POST','/api/projects/prj-owned/snapshot-uploads/01234567-89ab-4cde-8f01-23456789abcd/manifest',false],
        ['POST','/api/model-chat/conversations',false],
    ])('keeps only exact raw uploads outside the JSON parser: %s %s',async(method,path,raw)=>{
        await boot();const parser=fixture.json.mock.results[1].value,next=vi.fn();
        const dispatch=fixture.uses.at(-1)![0] as Function;
        dispatch({method,path},{},next);
        expect(next).toHaveBeenCalledOnce();
        expect(parser.mock.calls.length).toBe(raw?0:1);
    });
    it.each([
        [undefined,true],['https://panel.example.test',true],['https://attacker.example.test',false],['null',false],
    ])('checks WebSocket Origin before authentication: %s',async(origin,allowed)=>{
        await boot();const done=vi.fn();
        fixture.socketOptions!.allowRequest({headers:{origin}},done);
        expect(done).toHaveBeenCalledWith(null,allowed);
        expect(fixture.socketOptions!.cors).toEqual({origin:'https://panel.example.test',credentials:true});
    });
});

describe('Socket session ownership and revocation',()=>{
    it.each([false,true])('authenticates only the handshake credential: bearer=%s',async bearer=>{
        await boot();const peer=socket(),next=vi.fn(),user={email:'owner@example.test'};
        if(bearer)peer.handshake.auth.token='owned-token';
        fixture.authenticate.mockResolvedValue(user);
        await fixture.socketMiddleware!(peer,next);
        const request=bearer?{headers:{authorization:'Bearer owned-token'}}:peer.request;
        expect(fixture.authenticate).toHaveBeenCalledWith(request);
        expect(peer.data.authRequest).toEqual(request);expect(peer.data.user).toBe(user);expect(next).toHaveBeenCalledWith();
    });
    it.each(['missing','unavailable'])('denies a handshake when authentication is %s',async mode=>{
        await boot();const peer=socket(),next=vi.fn();
        if(mode==='missing')fixture.authenticate.mockResolvedValue(null);else fixture.authenticate.mockRejectedValue(Error('private provider detail'));
        await fixture.socketMiddleware!(peer,next);
        expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
        expect(next.mock.calls[0][0].message).not.toContain('private provider detail');
        expect(peer.join).not.toHaveBeenCalled();
    });
    it('disconnects a connection without an authenticated owner and creates no timer',async()=>{
        await boot();const peer=socket();fixture.handlers.get('connection')!(peer);
        expect(peer.disconnect).toHaveBeenCalledWith(true);expect(peer.join).not.toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);
    });
    it.each([false,true])('joins only its own room and clears session checks on disconnect: device=%s',async device=>{
        await boot();const user={email:'owner@example.test',...(device?{deviceId:'device-owned'}:{})},peer=socket(user);
        fixture.authenticate.mockResolvedValue(user);fixture.handlers.get('connection')!(peer);
        expect(peer.join).toHaveBeenCalledExactlyOnceWith(device?'device:device-owned':'user:owner@example.test');
        expect(fixture.bridge.mock.calls.length).toBe(device?1:0);
        await vi.advanceTimersByTimeAsync(25000);
        expect(fixture.authenticate).toHaveBeenCalledWith(peer.data.authRequest);expect(peer.disconnect).not.toHaveBeenCalled();
        peer.events.get('disconnect')!();expect(vi.getTimerCount()).toBe(0);
        expect(fixture.bridge.mock.calls.length).toBe(device?2:0);
        await vi.advanceTimersByTimeAsync(50000);expect(fixture.authenticate).toHaveBeenCalledOnce();
    });
    it.each(['revoked','unavailable'])('disconnects an existing socket when session is %s',async mode=>{
        await boot();const peer=socket({email:'owner@example.test'});
        if(mode==='revoked')fixture.authenticate.mockResolvedValue(null);else fixture.authenticate.mockRejectedValue(Error('offline'));
        fixture.handlers.get('connection')!(peer);await vi.advanceTimersByTimeAsync(25000);
        expect(peer.disconnect).toHaveBeenCalledWith(true);
        peer.events.get('disconnect')!();expect(vi.getTimerCount()).toBe(0);
    });
});
