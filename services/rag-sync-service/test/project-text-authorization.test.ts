import {afterEach,describe,expect,it,vi} from 'vitest';
import {authorizeTextUpload} from '../src/project-text/text-authorization';
const value={projectId:'prj-text',actor:{email:'owner@test',activeRole:'developer'},requestKey:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',requestHash:'a'.repeat(64)};
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});

describe('Fresh text authority callback',()=>{
    it('uses the fixed Catalog endpoint, shared token and explicit actor without following redirects',async()=>{
        vi.stubEnv('CATALOG_SERVICE_URL','http://127.0.0.1:4100/');vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','fixture-internal');
        const fetch=vi.fn(async()=>Response.json({ok:true}));vi.stubGlobal('fetch',fetch);
        await authorizeTextUpload(value);expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:4100/internal/project-text/authorize',expect.objectContaining({
            method:'POST',redirect:'error',headers:{'content-type':'application/json','x-neurocenter-internal':'fixture-internal'},body:JSON.stringify(value),
        }));
    });
    it('fresh permission denial preserves HTTP 403',async()=>{
        vi.stubGlobal('fetch',vi.fn(async()=>Response.json({message:'private policy'},{status:403})));
        await expect(authorizeTextUpload(value)).rejects.toMatchObject({status:403});
    });
    it.each([Response.json({ok:false}),Response.json({}),Response.json({ok:true},{status:503}),new Response('not json'),new Response(null,{status:302})])(
        'unconfirmed or unavailable Catalog fails closed without leaking its response body',async response=>{
            vi.stubGlobal('fetch',vi.fn(async()=>response));await expect(authorizeTextUpload(value)).rejects.toMatchObject({status:503});
        });
    it('transport errors fail closed',async()=>{
        vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('private host secret');}));
        await expect(authorizeTextUpload(value)).rejects.toMatchObject({status:503});
    });
});
