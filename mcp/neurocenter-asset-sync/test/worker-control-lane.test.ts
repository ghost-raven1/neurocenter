import {describe,expect,it} from 'vitest';
import {idleSystemRoleMcpLane} from './worker-control-lane.fixture.js';

const origin='https://catalog.example.test',token='CONTROL_TOKEN_MUST_STAY_PRIVATE';
const route=origin+'/api/device-channel/system-role-mcp/claim';
const claim={requestId:'11111111-1111-4111-8111-111111111111',recoveryOnly:false};
const options:RequestInit={method:'POST',redirect:'error',headers:{authorization:'Bearer '+token},body:JSON.stringify(claim)};

describe('Worker fixture permits only idle MCP control traffic',()=>{
    it.each([false,true])('accepts a v2 claim without enabling tools (recovery: %s)',async recoveryOnly=>{
        const lane=idleSystemRoleMcpLane(origin,token);
        const response=await lane.network(route,{...options,body:JSON.stringify({...claim,recoveryOnly})});
        expect(await response.json()).toBeNull();
        expect(lane.claims).toHaveLength(1);expect(lane.unexpected).toEqual([]);
        expect(JSON.stringify(lane.claims)).not.toContain(token);
    });

    it.each<[string,string]>([
        ['old empty claim','{}'],
        ['invalid JSON','{'],
        ['missing request identifier',JSON.stringify({recoveryOnly:false})],
        ['invalid request identifier',JSON.stringify({...claim,requestId:'another-session'})],
        ['non-boolean recovery mode',JSON.stringify({...claim,recoveryOnly:'false'})],
        ['extra tool payload',JSON.stringify({...claim,tool:{name:'model-inference'}})],
    ])('rejects %s instead of hiding unexpected work',async(_label,body)=>{
        const lane=idleSystemRoleMcpLane(origin,token);
        await expect(lane.network(route,{...options,body})).rejects.toThrow('control-lane boundary');
        expect(lane.claims).toEqual([]);expect(lane.unexpected).toHaveLength(1);
        expect(JSON.stringify(lane.unexpected)).not.toContain(token);
    });

    it.each<[string,string,RequestInit]>([
        ['provider address','https://provider.example.test/v1/chat/completions',options],
        ['tool dispatch',origin+'/api/device-channel/system-role-mcp/dispatch',options],
        ['query string',route+'?tool=inference',options],
        ['fragment',route+'#tool',options],
        ['wrong method',route,{...options,method:'GET'}],
        ['replacement token',route,{...options,headers:{authorization:'Bearer replacement'}}],
        ['redirect following',route,{...options,redirect:'follow' as const}],
    ])('rejects %s even with a valid idle body',async(_label,address,input)=>{
        const lane=idleSystemRoleMcpLane(origin,token);
        await expect(lane.network(address,input)).rejects.toThrow('control-lane boundary');
        expect(lane.claims).toEqual([]);expect(lane.unexpected).toHaveLength(1);
    });
});
