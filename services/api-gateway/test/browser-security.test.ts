import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import type {Request,Response} from 'express';
import {allowBrowserOrigin,browserSecurity,panelOrigin,publicApiOrigin} from '../src/security/browser-security';

beforeEach(()=>{vi.stubEnv('PANEL_URL','https://panel.example.test');vi.stubEnv('API_PUBLIC_URL','');vi.stubEnv('NODE_ENV','test');});
afterEach(()=>vi.unstubAllEnvs());

describe('Gateway cookie request boundary',()=>{
    it.each([
        ['GET','/api/projects',{},false],
        ['HEAD','/api/projects',{},false],
        ['OPTIONS','/api/projects',{},false],
        ['POST','/api/projects',{},true],
        ['GET','/auth/logout',{},true],
        ['POST','/api/projects',{'x-neurocenter-request':'1'},false],
        ['POST','/api/projects',{'x-neurocenter-request':'1',origin:'https://panel.example.test'},false],
        ['POST','/api/projects',{'x-neurocenter-request':'1',origin:'https://attacker.example.test'},true],
        ['POST','/api/projects',{'x-neurocenter-request':'1',origin:'null'},true],
        ['POST','/api/projects',{'x-neurocenter-request':'1','sec-fetch-site':'cross-site'},true],
        ['POST','/api/projects',{'x-neurocenter-request':'0',origin:'https://panel.example.test'},true],
        ['POST','/api/projects',{authorization:'Bearer own',origin:'https://other.example.test'},false],
    ])('%s %s enforces cookie origin/header/site: %j', (method,path,extra,denied)=>{
        const req={method,path,headers:{cookie:'other=1; bridge_session=owned',...extra}} as Request;
        const status=vi.fn(),json=vi.fn(),setHeader=vi.fn(),next=vi.fn(),res={status,json,setHeader};status.mockReturnValue(res);
        browserSecurity(req,res as unknown as Response,next);
        expect(setHeader.mock.calls).toEqual([['Cache-Control','no-store'],['X-Content-Type-Options','nosniff'],['Referrer-Policy','no-referrer']]);
        if(denied){expect(status).toHaveBeenCalledWith(403);expect(json).toHaveBeenCalledOnce();expect(next).not.toHaveBeenCalled();}
        else{expect(status).not.toHaveBeenCalled();expect(next).toHaveBeenCalledOnce();}
    });
    it.each([undefined,'other=1','fake_bridge_session=not-a-session'])('leaves non-session clients to authentication: cookie=%s',cookie=>{
        const next=vi.fn(),res={setHeader:vi.fn(),status:vi.fn()};
        browserSecurity({method:'POST',path:'/api/projects',headers:{cookie}} as Request,res as unknown as Response,next);
        expect(next).toHaveBeenCalledOnce();expect(res.status).not.toHaveBeenCalled();
    });
});

describe('Configured public origins',()=>{
    it('uses local defaults only outside production and ignores request headers',()=>{
        vi.stubEnv('PANEL_URL','');expect(panelOrigin()).toBe('http://localhost:5173');expect(publicApiOrigin()).toBe('http://localhost:4000');
        vi.stubEnv('NODE_ENV','production');vi.stubEnv('PANEL_URL','https://panel.example.test');expect(publicApiOrigin()).toBe('https://panel.example.test');
        vi.stubEnv('API_PUBLIC_URL','https://api.example.test:4443/');expect(publicApiOrigin()).toBe('https://api.example.test:4443');
    });
    it.each(['file:///tmp/local','https://user:secret@panel.example.test','not a URL'])('rejects an invalid panel address: %s',url=>{
        vi.stubEnv('PANEL_URL',url);expect(()=>panelOrigin()).toThrow();
    });
    it.each(['file:///tmp/local','https://user:secret@api.example.test','https://api.example.test/path',
        'https://api.example.test/?token=secret','https://api.example.test/#fragment','https://api.example.test/\n','not a URL'])('rejects a non-origin public API address: %s',url=>{
        vi.stubEnv('API_PUBLIC_URL',url);expect(()=>publicApiOrigin()).toThrow();
    });
    it.each([[undefined,true],['https://panel.example.test',true],['https://panel.example.test.attacker.test',false],[null,false],[42,false]])('compares the complete browser origin: %s', (origin,allowed)=>{
        expect(allowBrowserOrigin(origin)).toBe(allowed);
    });
});
