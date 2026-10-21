const {test}=require('node:test');
const assert=require('node:assert/strict');
const path=require('node:path');
const {createRequire}=require('node:module');
const requireCatalog=createRequire(path.resolve('services/catalog-service/package.json'));
requireCatalog('ts-node').register({transpileOnly:true,project:path.resolve('services/catalog-service/tsconfig.json')});
const {createInput,editInput,actionInput,listInput,targetQuery,target}=requireCatalog('./src/catalog-requests/request.validation.ts');
const {currentActor}=requireCatalog('./src/catalog-requests/request.access.ts');
const key='11111111-1111-4111-8111-111111111111';
const base={requestKey:key,kind:'add',assetType:'mcp',title:'Useful server',description:'Needed for project work'};
const bad=action=>assert.throws(action,error=>error.getStatus?.()===400);

test('Request inputs normalize text and keep submitted source URLs inert and credential-free',()=>{
 assert.deepEqual(createInput({...base,title:'  Server  ',sourceUrl:'https://github.com/example/server'}),{...base,title:'Server',sourceUrl:'https://github.com/example/server',projectId:null,target:null});
 for(const sourceUrl of ['javascript:alert(1)','file:///private/config','ftp://example.test/code','https://user:secret@example.test/code','relative/path','https://example.test/\nprivate'])bad(()=>createInput({...base,sourceUrl}));
 for(const raw of [null,[],{...base,createdBy:'other@example.test'},{...base,status:'completed'},{...base,revision:2},{...base,description:''},{...base,title:'x'.repeat(161)},{...base,description:'x'.repeat(10001)},{...base,requestKey:'bad'}])bad(()=>createInput(raw));
});

test('Known request kinds and all four asset types use explicit typed targets',()=>{
 for(const assetType of ['mcp','plugin','skill','model'])assert.equal(createInput({...base,assetType}).assetType,assetType);
 for(const kind of ['update','issue']){
  bad(()=>createInput({...base,kind}));
  assert.equal(createInput({...base,kind,target:{type:'mcp',id:'existing'}}).target.id,'existing');
 }
 bad(()=>createInput({...base,target:{type:'mcp',id:'existing'}}));
 bad(()=>createInput({...base,kind:'update',target:{type:'plugin',id:'existing'}}));
 for(const id of ['common/my_skill','common/folder_name/skill-name','project-prj-test/folder_name/a_b'])assert.equal(target({type:'skill',id}).id,id);
 for(const id of ['common/../secret','common//skill','common/a/','common/Upper','other/skill','common/.hidden'])bad(()=>target({type:'skill',id}));
});

test('Edits require CAS and reject attempts to change request ownership, type or project',()=>{
 const edit={requestKey:key,expectedRevision:1,title:'New title',description:'New description'};
 assert.equal(editInput(edit).expectedRevision,1);
 for(const expectedRevision of [0,-1,1.2,'1',null,Number.MAX_SAFE_INTEGER+1])bad(()=>editInput({...edit,expectedRevision}));
 for(const extra of [{projectId:'prj-other'},{kind:'issue'},{assetType:'model'},{createdBy:'other@example.test'}])bad(()=>editInput({...edit,...extra}));
});

test('Review decisions require explanatory text; only completion accepts a result card',()=>{
 for(const action of ['needs_info','reject','complete']){
  bad(()=>actionInput({requestKey:key,expectedRevision:1,action}));
  bad(()=>actionInput({requestKey:key,expectedRevision:1,action,comment:'   '}));
  assert.equal(actionInput({requestKey:key,expectedRevision:1,action,comment:'Reason'}).comment,'Reason');
 }
 for(const action of ['start','cancel','resubmit']){
  assert.equal(actionInput({requestKey:key,expectedRevision:1,action}).action,action);
  bad(()=>actionInput({requestKey:key,expectedRevision:1,action,target:{type:'model',id:'model'}}));
 }
 bad(()=>actionInput({requestKey:key,expectedRevision:1,action:'delete'}));
});

test('Queue and target discovery queries are bounded and reject unsupported filters',()=>{
 assert.deepEqual(listInput({}),{scope:'mine',page:1,size:20});
 assert.equal(targetQuery({assetType:'skill',limit:'100',q:'folder_'}).limit,100);
 for(const raw of [{page:'0'},{size:'101'},{size:['20']},{page:'NaN'},{scope:'global'},{status:'approved'},{projectId:'other-project'},{secret:'x'}])bad(()=>listInput(raw));
 for(const raw of [{assetType:'all'},{assetType:'mcp',limit:'101'},{assetType:'model',q:'x'.repeat(121)}])bad(()=>targetQuery(raw));
});

test('A malformed project membership cannot grant platform-wide main administrator rights',async()=>{
 const db={query:async sql=>({rows:sql.includes('FROM platform_users')?[{enabled:true,is_main_admin:false}]:[{projectId:'prj-own',projectName:'Own',role:'Главный админ'}]})};
 await assert.rejects(currentActor(db,{email:'member@example.test',activeRole:'Главный админ'}),error=>error.getStatus?.()===403);
});
