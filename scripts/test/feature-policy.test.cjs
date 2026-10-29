'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {FEATURE_FLAGS,FEATURE_FLAG_KEYS,defaultFeatureFlags,evaluateFeatureFlags,parseEvaluatedFeatureFlags}=require('../../services/shared/feature-flags.cjs');
const {FeatureFlagError,readFeatures,requireFeaturesEnabled}=require('../../services/shared/feature-client.cjs');
const {requiredRouteFeatures,requiredJobFeatures,requiredInferenceFeatures}=require('../../services/shared/feature-policy.cjs');
const response=flags=>new Response(JSON.stringify(evaluateFeatureFlags(flags)));
const env={FEATURE_FLAGS_SERVICE_URL:'http://flags.test',NEUROCENTER_INTERNAL_TOKEN:'qa-only'};
test('Personal token quota enforcement defaults OFF without blocking policy receipts or exact recovery',()=>{
 const definition=FEATURE_FLAGS.find(flag=>flag.key==='user_model_token_quotas');
 assert.ok(definition);assert.equal(defaultFeatureFlags().user_model_token_quotas,false);
 assert.deepEqual(definition.dependsOn,[]);
 for(const [method,route]of [['GET','/api/models/model/token-quotas/person%40example.test'],['PUT','/api/models/model/token-quotas/person%40example.test'],['GET','/api/models/model/token-quotas/person%40example.test/requests/key']])assert.deepEqual(requiredRouteFeatures(method,route,{}),[]);
 assert.deepEqual(requiredRouteFeatures('POST','/api/models',{}),['model_catalog']);
});
test('Encoded slash in a valid quota email preserves recovery without exempting another route',()=>{
 for(const email of ['first/last@example.test','person+tag@example.test','person%name@example.test']){
  const route='/api/models/model/token-quotas/'+encodeURIComponent(email);
  assert.deepEqual(requiredRouteFeatures('PUT',route,{}),[],email);
  assert.deepEqual(requiredRouteFeatures('PUT',route+'/unexpected',{}),['model_catalog']);
 }
 assert.deepEqual(requiredRouteFeatures('PUT','/api/%6dodels/model/token-quotas/first%2Flast%40example.test',{}),[]);
});
for(const key of FEATURE_FLAG_KEYS)test('Every capability has a complete immutable definition and enforces '+key,async()=>{
 const definition=FEATURE_FLAGS.find(flag=>flag.key===key);assert.ok(Object.isFrozen(definition));assert.ok(Object.isFrozen(definition.dependsOn));assert.ok(definition.name&&definition.description&&definition.group);
 const configured={...defaultFeatureFlags(),[key]:false},evaluated=evaluateFeatureFlags(configured);assert.equal(evaluated.flags[key],false);assert.equal(configured[key],false);
 await assert.rejects(requireFeaturesEnabled([key],env,async()=>response(configured)),error=>error instanceof FeatureFlagError&&error.status===403&&error.feature===key);
 await requireFeaturesEnabled([key],env,async()=>response(Object.fromEntries(FEATURE_FLAG_KEYS.map(key=>[key,true]))));
});
test('Dependencies disable descendants without rewriting configured choices',()=>{
 const state=evaluateFeatureFlags({...defaultFeatureFlags(),model_hosting:false});
 for(const key of ['model_chat','group_chat','project_search']){assert.equal(state.flags[key],false);assert.equal(state.configured[key],true);assert.deepEqual(state.blockedBy[key],['model_hosting']);}
 const direct=evaluateFeatureFlags({...defaultFeatureFlags(),agents:false});assert.equal(direct.flags.group_chat,false);assert.equal(direct.flags.model_chat,true);
 const recovered=evaluateFeatureFlags({...state.configured,model_hosting:true});assert.equal(recovered.flags.group_chat,true);
});
test('Permission transport returns booleans only, rejects missing/inconsistent flags and private metadata',async()=>{
 const snapshot={...evaluateFeatureFlags(defaultFeatureFlags()),updatedBy:'secret@example.test',credentials:'never-copy'};
 assert.deepEqual(Object.keys(await readFeatures(env,async()=>new Response(JSON.stringify(snapshot)))).sort(),['blockedBy','flags']);
 for(const value of [{flags:{model_hosting:true}},{flags:{...defaultFeatureFlags(),model_hosting:false}},{...snapshot,flags:{...snapshot.flags,agents:'true'}}])await assert.rejects(readFeatures(env,async()=>new Response(JSON.stringify(value))),{status:503});
 assert.throws(()=>parseEvaluatedFeatureFlags(null));
});
test('One fresh bounded lookup covers multiple dependencies and recovery performs no lookup',async()=>{
 let calls=0,enabled=false;
 const fetch=async(url,options)=>{calls++;assert.equal(url,'http://flags.test/internal/feature-flags/evaluated');assert.equal(options.redirect,'error');assert.equal(options.headers['x-neurocenter-internal'],'qa-only');return response({...defaultFeatureFlags(),agents:enabled});};
 await requireFeaturesEnabled([],env,()=>{throw Error('Recovery must not fetch');});
 await assert.rejects(requireFeaturesEnabled(['model_chat','group_chat'],env,fetch),error=>error.feature==='group_chat'&&error.blockedBy.includes('agents'));
 enabled=true;await requireFeaturesEnabled(['model_chat','group_chat'],env,fetch);assert.equal(calls,2);
});
test('Transport failures and oversized bodies fail closed without exposing secrets',async()=>{
 for(const request of [async()=>{throw Error('private.example?key=SECRET');},async()=>new Response('{}',{status:503}),async()=>new Response('x'.repeat(65537)),async()=>new Response('{')])await assert.rejects(readFeatures(env,request),error=>error.status===503&&!error.message.includes('SECRET'));
 const abort=new AbortController();abort.abort(new Error('qa-cancel'));await assert.rejects(readFeatures(env,async()=>{throw Error('transport');},abort.signal),/qa-cancel/);
});
const routes=[
 ['POST','/api/projects/p/embedding/reindex',{},[]],
 ['POST','/api/projects/p/embedding/reindex/id/start',{},['rag_sync']],
 ['POST','/api/projects/p/embedding/reindex/id/retry',{},['rag_sync']],
 ['POST','/api/projects/p/embedding/reindex/id/cancel',{},[]],
 ['PUT','/api/help/getting-started',{},['help_center']],
 ['POST','/api/discussions/comments',{},[]],
 ['PATCH','/api/discussions/comments/id',{},['discussions']],
 ['POST','/api/discussions/attachments',{},['discussions','discussion_attachments']],
 ['PUT','/api/catalog-reactions',{},[]],
 ['POST','/api/projects',{},['projects']],['POST','/api/device-channel/pair/start',{},['computer_connections']],
 ['POST','/api/ai-plugins',{},['tool_catalog']],['PUT','/api/skills/common/qa',{},['tool_catalog']],
 ['POST','/api/asset-imports',{},['asset_sources']],['POST','/api/device-install-plans',{},['tool_installation']],
 ['POST','/api/models',{},['model_catalog']],['POST','/api/models/import-opencode',{},['opencode_model_sync']],
 ['POST','/api/agents',{},['agents']],['POST','/api/model-chats',{},['model_chat']],['POST','/api/model-chats',{mode:'group'},['group_chat']],
 ['POST','/api/projects/p/learning/analyses',{},['project_learning','model_hosting']],
 ['POST','/api/projects/p/versions',{},['project_snapshots']],['POST','/api/projects/p/backups',{},['project_backups']],
 ['POST','/api/catalog-requests',{},['catalog_requests']],['GET','/api/model-usage',{},['model_usage']],
 ['POST','/api/device-jobs',{kind:'prepare-local-change'},['local_changes']],['POST','/api/device-channel/agents/compile',{},[]],
 ['POST','/api/device-jobs',{kind:'run-agent-method-workflow'},['agent_method_workflows']],
 ['POST','/api/device-jobs',{kind:'run-agent-method-workflow',workflow:{agentId:'agent-qa',expectedAgentsRevision:1}},['agent_method_workflows','project_agent_workflows']],
 ['POST','/api/models/m/ollama/v1/chat/completions',{},['model_hosting']],['GET','/api/tool-builds/repository',{},['tool_builds']],['POST','/api/rag/sync',{},['rag_sync']],
];
test('Discussion attachment dependency preserves published history and cleanup',()=>{
 const state=evaluateFeatureFlags({...defaultFeatureFlags(),discussions:false});
 assert.equal(state.flags.discussion_attachments,false);assert.equal(state.configured.discussion_attachments,true);
 assert.deepEqual(state.blockedBy.discussion_attachments,['discussions']);
 for(const [method,path]of [['GET','/api/help/start'],['GET','/api/discussions'],['GET','/api/discussions/attachments/id/content'],['DELETE','/api/discussions/comments/id'],['DELETE','/api/discussions/attachments/id'],['DELETE','/api/catalog-reactions']])assert.deepEqual(requiredRouteFeatures(method,path),[]);
});
for(const [method,path,body,keys]of routes)test('Native and Gateway admission agree for '+method+' '+path,()=>assert.deepEqual(requiredRouteFeatures(method,path,body),keys));
test('Reads, cancellation, revocation, role controls and recovery never depend on business flags',()=>{
 for(const [method,path]of [['GET','/api/device-jobs'],['GET','/api/device-jobs/requests/accepted-key'],['DELETE','/api/device-jobs/id']])assert.deepEqual(requiredRouteFeatures(method,path),[]);
 for(const [method,path,body]of [['GET','/api/agents'],['GET','/api/model-chats/id'],['GET','/api/model-chats/id/history'],['POST','/api/model-chats/id/turns/t/cancel'],['POST','/api/model-chats/id/turns/t/complete'],['DELETE','/api/models/m/connection'],['POST','/api/models/m/hosting',{action:'stop'}],['PATCH','/api/feature-flags/model_hosting',{enabled:true}],['POST','/api/projects/p/versions/v/activate'],['POST','/api/device-jobs',{kind:'uninstall'}],['POST','/api/device-jobs',{kind:'bind-project',bindingMode:'resume'}]])assert.deepEqual(requiredRouteFeatures(method,path,body),[],path);
 for(const input of [{mode:'resume'},{bindingMode:'resume'}])assert.deepEqual(requiredJobFeatures('bind-project',input),[]);
 assert.deepEqual(requiredRouteFeatures('POST','/api/projects/p/learning/%61nalyses/',{}),['project_learning','model_hosting']);
});
test('Every real inference purpose maps to a business capability',()=>{
 for(const purpose of ['direct','verification','device-embedding','reindex'])assert.deepEqual(requiredInferenceFeatures(purpose),['model_hosting']);
 assert.deepEqual(requiredInferenceFeatures('chat'),['model_chat']);assert.deepEqual(requiredInferenceFeatures('agent'),['group_chat']);assert.deepEqual(requiredInferenceFeatures('compaction','agent-id'),['group_chat']);assert.deepEqual(requiredInferenceFeatures('project-search'),['project_search']);assert.deepEqual(requiredInferenceFeatures('learning'),['project_learning','model_hosting']);
});
test('Per-model policy stays configurable when enforcement or the catalog feature is disabled',()=>{
 const state=evaluateFeatureFlags({...defaultFeatureFlags(),model_rate_limits:false,model_catalog:false});
 assert.equal(state.flags.model_rate_limits,false);assert.equal(state.flags.model_catalog,false);
 for(const method of ['GET','PUT'])assert.deepEqual(requiredRouteFeatures(method,'/api/models/model-a/rate-limit'),[]);
 assert.equal(evaluateFeatureFlags({...defaultFeatureFlags(),model_hosting:false}).flags.model_rate_limits,true);
});

test('Research admission depends on selected sources; saved retry uses server snapshot',()=>{assert.deepEqual(requiredRouteFeatures('POST','/api/model-chats/id/turns',{research:{project:true,external:{assetId:'x'}}}),['model_chat','research_tools','project_search','tool_catalog']);assert.deepEqual(requiredRouteFeatures('GET','/api/model-chats/id/research-tools'),[]);assert.deepEqual(requiredRouteFeatures('POST','/internal/research-mcp/call',{}),['research_tools','tool_catalog']);});

test('System roles have independent admission flags and retain history, cancellation and rollback',()=>{
 for(const [id,flag]of [['agent-packager','tool_build_agent'],['agent-ai-admin','system_ai_admin'],['agent-autoconfigurator','system_autoconfigurator'],['agent-indexer','system_indexer']]){
  assert.deepEqual(requiredInferenceFeatures('agent',id),[flag]);
  for(const suffix of ['prepare','runs/run-id/apply'])assert.deepEqual(requiredRouteFeatures('POST','/api/system-roles/'+id+'/'+suffix),[flag]);
  for(const [method,suffix]of [['POST','runs'],['GET','runs'],['GET','runs/run-id'],['POST','runs/run-id/cancel'],['POST','runs/run-id/rollback']])assert.deepEqual(requiredRouteFeatures(method,'/api/system-roles/'+id+'/'+suffix),[]);
 }
});


test('Only trusted normalized agent cleanup bypasses disabled capabilities',()=>{
 for(const agents of [[],[{id:'a',enabled:false}]]){assert.deepEqual(requiredJobFeatures('configure-project-agents',{schemaVersion:2,agents},true),[]);assert.deepEqual(requiredJobFeatures('configure-project-agents',{schemaVersion:2,agents}),['agents','computer_connections']);}
 for(const agents of [[{enabled:true}],[{}],null])assert.deepEqual(requiredJobFeatures('configure-project-agents',{agents},true),['agents','computer_connections']);
});

test('Selected-agent workflow gates dispatch while retaining the legacy protocol and recovery',()=>{
 assert.deepEqual(requiredJobFeatures('run-agent-method-workflow',{agent:{agentId:'qa'}},true),['agent_method_workflows','project_agent_workflows']);
 assert.deepEqual(requiredJobFeatures('run-agent-method-workflow',{},true),['agent_method_workflows']);
 assert.deepEqual(requiredJobFeatures('run-agent-method-workflow',{agent:{agentId:'untrusted'}}),['agent_method_workflows']);
 const flags=evaluateFeatureFlags({...defaultFeatureFlags(),agent_method_workflows:true,project_agent_workflows:true,agents:false});
 assert.equal(flags.flags.project_agent_workflows,false);
 for(const [verb,path]of [['GET','/api/device-jobs/requests/existing'],['GET','/api/device-jobs'],['DELETE','/api/device-jobs/existing']])assert.deepEqual(requiredRouteFeatures(verb,path),[]);
});

test('Chat-linked workflow checks new admission in its owner after exact replay lookup',()=>{
 const workflow={agentId:'qa',expectedAgentsRevision:1,origin:{roomId:'room',messageId:'message'}};
 assert.deepEqual(requiredRouteFeatures('POST','/api/device-jobs',{kind:'run-agent-method-workflow',workflow}),[]);
 assert.deepEqual(requiredJobFeatures('run-agent-method-workflow',{workflow}),['agent_method_workflows','project_agent_workflows','project_agent_chat_workflows']);
 // The origin is kept in a server-only relation, never added to the native bridge protocol.
 assert.deepEqual(requiredJobFeatures('run-agent-method-workflow',{agent:{agentId:'qa'}},true),['agent_method_workflows','project_agent_workflows']);
 assert.deepEqual(requiredJobFeatures('run-agent-method-workflow',{workflow:{origin:null}}),['agent_method_workflows','project_agent_chat_workflows']);
 const configured={...defaultFeatureFlags(),agent_method_workflows:true,project_agent_workflows:true,project_agent_chat_workflows:true};
 assert.equal(defaultFeatureFlags().project_agent_chat_workflows,false);
 assert.equal(evaluateFeatureFlags(configured).flags.project_agent_chat_workflows,true);
 for(const dependency of ['project_agent_workflows','project_chat'])assert.equal(evaluateFeatureFlags({...configured,[dependency]:false}).flags.project_agent_chat_workflows,false);
 for(const [verb,path]of [['GET','/api/projects/p/team-chat'],['GET','/api/projects/p/team-chat/rooms/r/history'],['DELETE','/api/device-jobs/existing']])assert.deepEqual(requiredRouteFeatures(verb,path),[]);
});

test('Unified setup gates only its new bootstrap and retains existing installers and recovery',()=>{
 for(const ext of ['sh','ps1']){
  assert.deepEqual(requiredRouteFeatures('GET',`/api/bridge/install_workspace.${ext}`),['unified_project_setup']);
  for(const name of ['install','install_opencode','connect'])assert.deepEqual(requiredRouteFeatures('GET',`/api/bridge/${name}.${ext}`),[]);
 }
 assert.equal(defaultFeatureFlags().unified_project_setup,true);
 const flags=evaluateFeatureFlags({...defaultFeatureFlags(),unified_project_setup:true,computer_connections:false});
 assert.equal(flags.flags.unified_project_setup,false);
});

test('Computer setup gates new jobs in their queue owner while retaining exact receipt and cancellation routes',()=>{
 assert.equal(defaultFeatureFlags().computer_setup,true);
 assert.deepEqual(requiredJobFeatures('inspect-opencode-cli'),['computer_setup']);
 assert.deepEqual(requiredJobFeatures('inspect-opencode-cli',{},true),['computer_setup']);
 assert.equal(evaluateFeatureFlags({...defaultFeatureFlags(),computer_connections:false}).flags.computer_setup,false);
 for(const [method,path]of [['POST','/api/device-jobs'],['GET','/api/device-jobs'],['GET','/api/device-jobs/requests/existing'],['DELETE','/api/device-jobs/existing'],['POST','/api/device-channel/jobs/id/complete']]){
  assert.deepEqual(requiredRouteFeatures(method,path,{kind:'inspect-opencode-cli'}),[]);
 }
});

test('System chat admission remains stateful so exact replay, history and cancellation survive flag changes',()=>{
 for(const [verb,path]of [['POST','/api/system-role-chats'],['POST','/api/system-role-chats/dialog/messages'],['POST','/api/system-role-chats/dialog/messages/turn/retry'],['POST','/api/system-role-chats/dialog/messages/turn/cancel'],['GET','/api/system-role-chats/dialog']])assert.deepEqual(requiredRouteFeatures(verb,path),[]);
 for(const flag of ['system_indexer','system_role_chat'])assert.equal(evaluateFeatureFlags({...defaultFeatureFlags(),agents:false}).flags[flag],false);
});
