import {describe,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {actionInput,createInput,editInput,listInput,targetQuery,target,uuid} from '../src/catalog-requests/request.validation';

const key=randomUUID(),base={requestKey:key,kind:'add',assetType:'mcp',title:'Useful server',description:'Needed by the project'};
describe('Catalog request input boundaries — source contracts',()=>{
    it('normalizes UUID, whitespace, optional fields and inert credential-free HTTP URLs',()=>{
        expect(createInput({...base,requestKey:key.toUpperCase(),title:'  Tool  ',sourceUrl:'HTTPS://EXAMPLE.TEST/path'})).toEqual({...base,title:'Tool',sourceUrl:'https://example.test/path',projectId:null,target:null});
        expect(uuid(key.toUpperCase())).toBe(key);
        for(const value of [undefined,null,''])expect(createInput({...base,projectId:value,sourceUrl:value})).toMatchObject({projectId:null,sourceUrl:null,target:null});
        expect(createInput({...base,title:'x'.repeat(160),description:'x'.repeat(10000),projectId:'prj-allowed'})).toMatchObject({projectId:'prj-allowed'});
    });
    it.each(['javascript:alert(1)','file:///private/config','ftp://example.test/code','https://user:secret@example.test/','relative/path','https://example.test/\nprivate',false])('rejects invalid submitted source URL %#',sourceUrl=>{
        expect(()=>createInput({...base,sourceUrl})).toThrow(expect.objectContaining({status:400}));
    });
    it.each([null,[],{...base,createdBy:'forged@fixture.test'},{...base,status:'completed'},{...base,description:''},{...base,title:42},{...base,title:'x'.repeat(161)},{...base,description:'x'.repeat(10001)},{...base,title:'bad\u0000title'},{...base,requestKey:'invalid'},{...base,kind:'delete'},{...base,assetType:'agent'},{...base,projectId:'other-project'}])('rejects unsupported, forged or oversized intent before persistence %#',raw=>{
        expect(()=>createInput(raw)).toThrow(expect.objectContaining({status:400}));
    });
    it('preserves explicit target identity for every supported kind and asset type',()=>{
        for(const assetType of ['mcp','plugin','skill','model'])expect(createInput({...base,assetType}).assetType).toBe(assetType);
        for(const kind of ['update','issue'])expect(createInput({...base,kind,target:{type:'mcp',id:'existing'}})).toMatchObject({kind,target:{type:'mcp',id:'existing'}});
        for(const id of ['common/my_skill','common/folder_name/skill-name','project-prj-test/a_b'])expect(target({type:'skill',id})).toEqual({type:'skill',id});
        expect(target(null)).toBeNull();expect(target(undefined)).toBeNull();
    });
    it.each([{kind:'update'},{kind:'issue'},{target:{type:'mcp',id:'existing'}},{kind:'update',target:{type:'plugin',id:'existing'}},{kind:'issue',target:{type:'mcp',id:'valid',version:2}}])('requires a typed existing-card reference without accepting forged version fields %#',extra=>{
        expect(()=>createInput({...base,...extra})).toThrow(expect.objectContaining({status:400}));
    });
    it.each(['common/../secret','common//skill','common/a/','common/Upper','other/skill','common/.hidden','common/a\nb'])('rejects unsafe or ambiguous skill path %#',id=>{
        expect(()=>target({type:'skill',id})).toThrow(expect.objectContaining({status:400}));
    });
    it.each([0,-1,1.2,'1',null,undefined,Number.MAX_SAFE_INTEGER+1])('requires a real positive integer CAS revision %#',expectedRevision=>{
        expect(()=>editInput({requestKey:key,expectedRevision,title:'New title',description:'New description'})).toThrow(expect.objectContaining({status:400}));
    });
    it('does not allow an edit to retarget the original owner, scope, kind or request history',()=>{
        const input={requestKey:key,expectedRevision:1,title:'New title',description:'New description'};expect(editInput(input)).toMatchObject({expectedRevision:1});
        for(const extra of [{projectId:'prj-other'},{kind:'issue'},{assetType:'model'},{createdBy:'other@fixture.test'},{history:[]}])expect(()=>editInput({...input,...extra})).toThrow(expect.objectContaining({status:400}));
    });
    it('requires explanation for review decisions and accepts a result target only on completion',()=>{
        for(const action of ['needs_info','reject','complete']){
            for(const comment of [undefined,' ','x'.repeat(4001)])expect(()=>actionInput({requestKey:key,expectedRevision:1,action,comment})).toThrow(expect.objectContaining({status:400}));
            expect(actionInput({requestKey:key,expectedRevision:1,action,comment:' Reason '})).toMatchObject({comment:'Reason'});
        }
        for(const action of ['start','cancel','resubmit']){
            expect(actionInput({requestKey:key,expectedRevision:1,action}).comment).toBe('');
            expect(()=>actionInput({requestKey:key,expectedRevision:1,action,target:null})).toThrow(expect.objectContaining({status:400}));
        }
        expect(actionInput({requestKey:key,expectedRevision:1,action:'complete',comment:'Done',target:{type:'model',id:'model-result'}}).target).toEqual({type:'model',id:'model-result'});
    });
    it('keeps query defaults bounded and supports only real statuses and filters',()=>{
        expect(listInput({})).toEqual({scope:'mine',page:1,size:20});
        expect(targetQuery({assetType:'skill',q:null})).toMatchObject({q:'',limit:50,projectId:null});
        for(const status of ['submitted','in_progress','needs_info','rejected','completed','cancelled'])expect(listInput({scope:'all',status,kind:'issue',assetType:'model',projectId:'prj-example',size:'100',page:'1000000'})).toMatchObject({status,scope:'all',size:100,page:1000000});
        expect(listInput({projectId:''}).projectId).toBeUndefined();expect(targetQuery({assetType:'mcp',limit:'100',q:'x'.repeat(120)}).q).toHaveLength(120);
    });
    it.each([{page:'0'},{size:'101'},{size:['20']},{page:'NaN'},{page:'1.5'},{page:1},{page:'9007199254740992'},{scope:'global'},{status:'approved'},{kind:'delete'},{assetType:'all'},{projectId:'other-project'},{cursor:'unsupported'}])('rejects unsupported list query instead of silently broadening its scope %#',query=>{
        expect(()=>listInput(query)).toThrow(expect.objectContaining({status:400}));
    });
    it.each([{assetType:'all'},{assetType:'mcp',limit:'101'},{assetType:'model',q:'x'.repeat(121)},{assetType:'mcp',limit:10},{assetType:'skill',projectId:'bad-scope'}])('rejects unsupported target discovery query %#',query=>{
        expect(()=>targetQuery(query)).toThrow(expect.objectContaining({status:400}));
    });
});
