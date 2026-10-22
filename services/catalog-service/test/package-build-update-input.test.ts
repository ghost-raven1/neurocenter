import {describe,expect,it} from 'vitest';
import {requestHash,validateBuildInput} from '../src/package-build/package-build.model';

const publication={catalogId:'ai-plug-11111111-1111-4111-8111-111111111111',expectedVersion:2,expectedSourceHash:'a'.repeat(64)};
const request={requestKey:'22222222-2222-4222-8222-222222222222',kind:'mcp',name:'Existing tool',description:'A new source version',source:{type:'files',entrypoint:'index.mjs',files:[{path:'index.mjs',content:'export default {}'}]}};

describe('Explicit publication target belongs to the durable build request',()=>{
    it('Accepts the exact catalog CAS context instead of treating the new version as a duplicate name',()=>{
        expect(validateBuildInput({...request,publication})).toMatchObject({publication});
    });
    it('Changing target consent changes request identity even when source bytes remain the same',()=>{
        const first=validateBuildInput({...request,publication});
        expect(requestHash(first)).not.toBe(requestHash(validateBuildInput({...request,publication:{...publication,expectedVersion:3}})));
    });
    it.each([{...publication,expectedVersion:0},{...publication,expectedSourceHash:'bad'},{...publication,catalogId:''},{...publication,origins:[]}])('Rejects an incomplete or client-extended target: %j',target=>{
        expect(()=>validateBuildInput({...request,publication:target})).toThrow();
    });
});
