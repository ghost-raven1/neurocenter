import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {generateOpenApi} from '../openapi/generate.mjs';
import {normalizePaths,SERVICES} from '../openapi/routes.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const temporary = [];
let fixtureRoot, fixtureDocument, actual;

/** Fixtures are compiler inputs only: a top-level throw proves services are never executed. */
function fixture(source, filename = 'fixture.controller.ts') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neurocenter-openapi-'));
    temporary.push(directory);
    const gateway = path.join(directory, 'services/api-gateway');
    const catalog = path.join(directory, 'services/catalog-service/src');
    fs.mkdirSync(gateway, {recursive: true});
    fs.mkdirSync(catalog, {recursive: true});
    fs.writeFileSync(path.join(gateway, 'package.json'), '{"version":"0.0.1-fixture"}');
    fs.symlinkSync(path.join(root, 'services/api-gateway/node_modules'), path.join(directory, 'node_modules'), 'dir');
    const controller = path.join(catalog, filename);
    fs.mkdirSync(path.dirname(controller), {recursive: true});
    fs.writeFileSync(controller, source);
    return directory;
}

const source = `
import {Controller as RouteGroup, Get, Post, Put, HttpCode, Body, Param, Query, Headers, Res} from '@nestjs/common';
import {Controller as FakeController, Get as FakeGet} from 'not-nest';
import type {Response} from 'express';
throw new Error('A source scanner must not execute this module');
interface Input {
  /** Human readable name. */
  name: string;
  kind: 'skill' | 'plugin';
  enabled: boolean;
  optional?: number;
  absent: string | undefined;
  nullable: string | null;
  values: readonly string[];
  metadata: Record<string, unknown>;
  timestamp: Date;
  selected: Omit<{visible:string; secret:string}, 'secret'>;
}
interface Filters { required: string; optional?: 'on' | 'off' }
interface Recursive { next?: Recursive; value: string }
const prefix = ['api/sample', 'api/sample-alias'];
@RouteGroup(prefix)
class FixtureController {
  @Post() create(@Body() body: Input): Promise<Input> { return Promise.resolve(body); }
  @Put(':id') @HttpCode(202) update(@Param('id') id: string, @Body() body: unknown): Recursive { return {value:id}; }
  @Get('query') query(@Query() query: Filters): Filters { return query; }
  @Get('dictionary') dictionary(@Query() query: Record<string,string>): Record<string,string> { return query; }
  @Get('manual') manual(@Res() res: Response): void { res.json({ok:true as const, count:2}); }
  @Get('header') header(@Headers('x-neurocenter-internal') token:string, @Headers('x-bridge-actor') actor:string, @Headers('x-visible') visible:string): string { return visible; }
  @Get('files{/*parts}') wildcard(): string { return ''; }
  @Get('framework') framework(@Res() res: Response): Response { return res; }
}
@RouteGroup('internal/secrets') class PrivateController { @Get() get(): string { return ''; } }
@RouteGroup('health') class HealthController { @Get() get(): string { return ''; } }
@FakeController('api/fake') class Fake { @FakeGet() get(): string { return ''; } }
@RouteGroup('api/feature-flags-extra') class Boundary { @Get() get(): string { return ''; } }
@RouteGroup('api/skills/orphan') class WrongUpstream { @Get() get(): string { return ''; } }
`;

before(() => {
    fixtureRoot = fixture(source);
    fixtureDocument = generateOpenApi(fixtureRoot);
    actual = generateOpenApi(root);
});

test('Discussion files describe actual binary transport and target-bound upload metadata',()=>{
 const upload=actual.paths['/api/discussions/attachments'].post;
 assert.equal(upload.requestBody.content['application/octet-stream'].schema.format,'binary');
 for(const name of ['targetType','targetId','x-file-name','x-request-key','content-length'])assert.equal(upload.parameters.find(value=>value.name===name)?.required,true,name);
 const download=actual.paths['/api/discussions/attachments/{id}/content'].get;
 assert.equal(download.responses['200'].content['application/octet-stream'].schema.format,'binary');
 assert.deepEqual(upload.security,[{sessionCookie:[]}]);
});
after(() => {for (const directory of temporary) fs.rmSync(directory, {recursive: true, force: true});});

const jsonResponse = (operation, status = '200') => operation.responses[status].content['application/json'].schema;

test('PostgreSQL text knowledge exposes byte limits, exact receipt recovery and explicit revision search', async () => {
    const {TEXT_KNOWLEDGE_LIMITS}=await import('../../services/shared/project-text-knowledge.cjs');
    const base='/api/projects/{id}/knowledge/text', upload=actual.paths[base+'/documents'].post;
    const input=upload.requestBody.content['application/json'].schema;
    assert.deepEqual(input.required,['requestKey','expectedRevision','documents']);
    assert.equal(input.properties.documents.maxItems,TEXT_KNOWLEDGE_LIMITS.documents);
    assert.deepEqual(upload['x-neurocenter-utf8-limits'],TEXT_KNOWLEDGE_LIMITS);
    assert.match(upload.description,/without deleting absent files/);
    assert.match(upload.description,/committed receipt is returned before new-write feature checks/);
    assert.match(upload.description,/independent from model_hosting/);
    for(const path of [base,base+'/requests/{key}']){
        assert.match(actual.paths[path].get.description,/remain readable.*OFF/);
        assert.ok(actual.paths[path].get.security.length);
    }
    const search=actual.paths[base+'/search'].post;
    assert.deepEqual(search.requestBody.content['application/json'].schema.required,['query']);
    assert.match(search.description,/one consistent revision\/corpusHash/);
    assert.match(search.description,/No embedding\/model call/);
    assert.ok(search.responses['409']);
    assert.equal(actual.paths['/internal/project-text/authorize'],undefined);
});

test('Fixed computer OpenCode admission and observations reuse shared schemas without accepting generic command fields',async()=>{
    const {OPENCODE_CLI_SCHEMAS}=await import('../../services/shared/computer-setup.cjs');
    const create=actual.paths['/api/device-jobs'].post,schema=create.requestBody.content['application/json'].schema;
    assert.equal(schema.oneOf[1].$ref,'#/components/schemas/OpenCodeCliRequest');
    assert.deepEqual(schema.oneOf[0].allOf[1].properties.kind.not.enum,['inspect-opencode-cli']);
    assert.deepEqual(actual.components.schemas.OpenCodeCliRequest,OPENCODE_CLI_SCHEMAS.request);
    assert.equal(actual.components.schemas.OpenCodeCliRequest.additionalProperties,false);
    assert.deepEqual(actual.components.schemas.OpenCodeCliRequest.required,['deviceId','kind','scope','requestKey']);
    assert.deepEqual(actual.components.schemas.OpenCodeCliObservation,OPENCODE_CLI_SCHEMAS.observation);
    const lower='abcdefab-cdef-4abc-8def-abcdefabcdef',upper=lower.toUpperCase();
    for(const item of [OPENCODE_CLI_SCHEMAS.request.properties.deviceId,OPENCODE_CLI_SCHEMAS.payload.properties.deviceId,
        ...OPENCODE_CLI_SCHEMAS.observation.oneOf.flatMap(branch=>[branch.properties.deviceId,branch.properties.jobId])]){
        assert.equal(new RegExp(item.pattern).test(lower),true);assert.equal(new RegExp(item.pattern).test(upper),false);
    }
    const variants=actual.components.schemas.OpenCodeCliCompletion.oneOf;
    assert.deepEqual(variants.map(value=>value.properties.state.enum),[['succeeded'],['failed'],['failed']]);
    assert.equal(variants[2].properties.result.maxProperties,0);
    for(const status of ['400','403','409','429','503'])assert.ok(create.responses[status],status);
    assert.ok(create['x-neurocenter-job-kind-contracts']['inspect-opencode-cli'].errors['400'].includes('computer-setup-invalid-request'));
    assert.match(create.description,/exact accepted request/i);
});

test('Static Nest decorators, aliases, prefix arrays and gateway boundaries define public routes', () => {
    assert.equal(fixtureDocument.info.version, '0.0.1-fixture');
    assert.ok(fixtureDocument.paths['/api/sample'].post);
    assert.ok(fixtureDocument.paths['/api/sample-alias'].post);
    assert.ok(fixtureDocument.paths['/api/feature-flags-extra'].get, 'Feature flags routing has an exact segment boundary');
    for (const hidden of ['/internal/secrets', '/health', '/api/fake', '/api/skills/orphan']) assert.equal(fixtureDocument.paths[hidden], undefined, hidden);
});

test('Feature-owned controller.ts contributes its Nest routes without executing the source', () => {
    const directory = fixture(`
import {Controller, Get} from '@nestjs/common';
throw new Error('A source scanner must not execute this module');
@Controller('api/bare-feature') class FeatureController { @Get() read(): string { return 'ready'; } }
`, 'feature/controller.ts');
    const operation = generateOpenApi(directory).paths['/api/bare-feature']?.get;
    assert.ok(operation, 'The feature directory owns a bare controller.ts');
    assert.deepEqual(operation.security, [{sessionCookie:[]}]);
});

test('Typed bodies preserve required fields, literal unions, null, collections and explicit unknown data', () => {
    const schema = fixtureDocument.paths['/api/sample'].post.requestBody.content['application/json'].schema;
    assert.deepEqual(schema.required, ['name', 'kind', 'enabled', 'nullable', 'values', 'metadata', 'timestamp','selected']);
    assert.deepEqual(schema.properties.kind, {type:'string', enum:['skill','plugin']});
    assert.equal(schema.properties.name.description, 'Human readable name.');
    assert.equal(schema.properties.nullable.nullable, true);
    assert.deepEqual(schema.properties.values, {type:'array', items:{type:'string'}});
    assert.deepEqual(schema.properties.timestamp, {type:'string', format:'date-time'});
    assert.equal(schema.properties.metadata.additionalProperties['x-neurocenter-untyped'], true);
    assert.deepEqual(schema.properties.selected,{type:'object',properties:{visible:{type:'string'}},required:['visible']});
    const update = fixtureDocument.paths['/api/sample/{id}'].put;
    assert.equal(update.requestBody.content['application/json'].schema['x-neurocenter-untyped'], true);
    assert.equal(update.responses['202'].description, 'Successful response.');
    assert.equal(jsonResponse(update, '202').properties.next['x-neurocenter-untyped'], true, 'Recursive declarations remain bounded');
});

test('Typed query objects expand, dictionaries stay free-form and trusted headers stay private', () => {
    const query = fixtureDocument.paths['/api/sample/query'].get.parameters;
    assert.deepEqual(query.map(item => [item.name,item.required]), [['required',true],['optional',false]]);
    assert.deepEqual(fixtureDocument.paths['/api/sample/dictionary'].get.parameters[0].schema, {type:'object',additionalProperties:{type:'string'}});
    assert.deepEqual(fixtureDocument.paths['/api/sample/header'].get.parameters.map(item => item.name), ['x-visible']);
});

test('Optional Express catch-alls produce valid paths with required path parameters', () => {
    assert.deepEqual(normalizePaths('/api/files{/*parts}'), ['/api/files','/api/files/{parts}']);
    assert.deepEqual(normalizePaths('api//items/:id/'), ['/api/items/{id}']);
    assert.ok(fixtureDocument.paths['/api/sample/files'].get);
    const wildcard = fixtureDocument.paths['/api/sample/files/{parts}'].get.parameters[0];
    assert.equal(wildcard.required, true);
    assert.equal(wildcard['x-neurocenter-catch-all'], true);
});

test('Manual JSON responses infer their payload without exposing framework internals', () => {
    const manual = jsonResponse(fixtureDocument.paths['/api/sample/manual'].get);
    assert.deepEqual(manual.properties.ok, {type:'boolean',enum:[true]});
    assert.equal(manual.properties.count.type, 'number');
    const framework = jsonResponse(fixtureDocument.paths['/api/sample/framework'].get);
    assert.equal(framework['x-neurocenter-untyped'], true);
    assert.equal(framework.properties, undefined);
});

test('Unknown route expressions and duplicate public operations fail rather than hiding endpoints', () => {
    const dynamic = fixture("import {Controller,Get} from '@nestjs/common'; @Controller('api/test') class Test { @Get(process.env.ROUTE) get(){} }");
    assert.throws(() => generateOpenApi(dynamic), /Unsupported static route expression/);
    const duplicate = fixture("import {Controller,Get} from '@nestjs/common'; @Controller('api/test') class Test { @Get() a(){} @Get() b(){} }");
    assert.throws(() => generateOpenApi(duplicate), /Duplicate public OpenAPI operation/);
    const empty = fixture('export const noControllers = true;');
    assert.deepEqual(generateOpenApi(empty).paths, {});
});

test('Actual document covers the independently audited public surface without private routes', () => {
    assert.equal(Object.keys(actual.paths).length, 315);
    assert.equal(Object.values(actual.paths).reduce((sum, item) => sum + Object.keys(item).length, 0), 385);
    for (const representative of ['/api/projects','/api/skills','/api/rag/sync','/api/feature-flags','/auth/me','/api/bridge/install.sh','/api/mcp-host/connect','/api/catalog-requests','/api/catalog-requests/targets','/api/catalog-requests/{id}/actions']) assert.ok(actual.paths[representative], representative);
    for(const [pathname,methods] of Object.entries({'/api/models/{id}/token-quotas/{email}':['get','put'],'/api/models/{id}/token-quotas/{email}/requests/{requestKey}':['get']})) assert.deepEqual(Object.keys(actual.paths[pathname]).sort(),methods,pathname);
    for (const pathname of Object.keys(actual.paths)) assert.match(pathname, /^\/(?:api|auth)\//);
    for (const privatePath of ['/api/{path}','/api/device-channel/mcp-host/authorize','/internal/device-channel/identity','/api/rag/health','/health','/metrics','/bridge/install.sh']) assert.equal(actual.paths[privatePath], undefined, privatePath);
    assert.equal(actual.paths['/api/rag/sync'].post['x-neurocenter-service'], 'catalog-service');
    assert.equal(actual.paths['/api/feature-flags'].get['x-neurocenter-service'], 'feature-flags-service');
});

test('Each model rate policy has a browser-only independent CAS contract', () => {
    const route=actual.paths['/api/models/{id}/rate-limit'];
    assert.deepEqual(Object.keys(route).sort(),['get','put']);
    for(const method of ['get','put'])assert.deepEqual(route[method].security,[{sessionCookie:[]}]);
    const body=route.put.requestBody.content['application/json'].schema;
    assert.deepEqual(body.required,['expectedRevision','requests','windowMs','enabled']);
    const result=jsonResponse(route.get);
    for(const name of ['modelId','revision','requests','windowMs','enabled','canManage','featureEnabled'])assert.ok(result.properties[name],name);
    assert.equal(result.properties.requests.type,'number');assert.equal(result.properties.enabled.type,'boolean');
});

test('Personal token quotas describe exact receipts and decimal counters behind MainAdmin browser authority',()=>{
    const route=actual.paths['/api/models/{id}/token-quotas/{email}'];
    const receipt=actual.paths['/api/models/{id}/token-quotas/{email}/requests/{requestKey}'].get;
    assert.deepEqual(Object.keys(route).sort(),['get','put']);
    for(const operation of [route.get,route.put,receipt]){
        assert.deepEqual(operation.security,[{sessionCookie:[]}]);
        assert.equal(operation['x-neurocenter-service'],'catalog-service');
        assert.match(operation.description,/MainAdmin/);
        assert.match(operation.description,/OFF/);
        for(const name of ['id','email'])assert.equal(operation.parameters.find(value=>value.name===name)?.required,true,name);
    }
    const body=route.put.requestBody.content['application/json'].schema;
    assert.deepEqual(body.required,['requestKey','expectedRevision','enabled','tokenLimit','periodMs']);
    assert.equal(body.properties.requestKey.type,'string');
    assert.match(body.properties.tokenLimit.description,/Positive safe integer/);
    assert.match(body.properties.periodMs.description,/31536000000/);
    assert.match(route.put.description,/503.*unconfirmed/);
    assert.match(route.put.description,/unsupported model surfaces return 409/);
    const view=jsonResponse(route.get),counters=view.properties.counters.properties;
    for(const name of ['chargedTokens','activeReservedTokens','unknownHeldTokens','remainingTokens','overrunTokens'])assert.equal(counters[name].type,'string',name);
    assert.equal(counters.actualInputTokens.nullable,true);assert.equal(counters.actualOutputTokens.nullable,true);
    assert.equal(view.properties.coverage.properties.managedText.type,'boolean');
    for(const operation of [route.put,receipt]){
        const result=jsonResponse(operation);
        for(const name of ['modelId','userEmail','writerEmail','requestKey','requestFingerprint','input','policy'])assert.ok(result.properties[name],name);
    }
    assert.match(receipt.description,/404.*absence does not prove/);
});

test('Usage documents actor and API filters with scoped detail rather than exposing a user directory', () => {
    const operation=actual.paths['/api/model-usage'].get;
    assert.deepEqual(operation.security,[{sessionCookie:[]}]);
    for(const name of ['actorEmail','projectId','modelId','agentId','endpoint','provider'])assert.ok(operation.parameters.some(value=>value.in==='query'&&value.name===name),name);
    const result=jsonResponse(operation);
    for(const name of ['scope','facets','byActor','byProject','byAgent','byEndpoint','series'])assert.ok(result.properties[name],name);
    for(const name of ['dispatchCount','dispatchedAt','rateWaitMs','providerLatencyMs','failureCode'])assert.ok(result.properties.items.items.properties[name],name);
});

test('Shared project chat documents browser membership, explicit recipients and short durable receipts', () => {
    const root = '/api/projects/{projectId}/team-chat';
    for (const [suffix, method] of [['', 'get'], ['/history', 'get'], ['/participants', 'put'], ['/messages', 'post'],
        ['/messages/{messageId}/retry', 'post'], ['/messages/{messageId}/cancel', 'post']]) {
        const operation = actual.paths[root + suffix][method];
        assert.deepEqual(operation.security, [{sessionCookie:[]}]);
    }
    const post = actual.paths[root + '/messages'].post.requestBody.content['application/json'].schema;
    assert.ok(post.properties.requestKey); assert.ok(post.properties.prompt); assert.ok(post.properties.replyToId); assert.ok(post.properties.targetAgentIds);
    assert.equal(post.properties.targetAgentIds.type, 'array');
});

test('Agent diagnostics document their exact browser-only routes and asynchronous admission',()=>{
    const base='/api/projects/{projectId}/agents', trial=base+'/{agentId}/readiness-trials';
    for(const [pathname,method,status]of [[base+'/readiness','get','200'],[trial,'post','202'],[trial+'/{trialId}','get','200'],[trial+'/{trialId}/cancel','post','201']]){
        const operations=actual.paths[pathname];assert.deepEqual(Object.keys(operations),[method]);
        assert.deepEqual(operations[method].security,[{sessionCookie:[]}]);assert.ok(operations[method].responses[status]);
        assert.equal(operations[method]['x-neurocenter-service'],'catalog-service');
    }
});

test('Personal chat contracts expose bounded document inputs and CAS only to browser sessions',()=>{
    const base='/api/model-chats',chat=base+'/{id}';
    const expected={'':['get','post'],'/{id}':['delete','get','patch'],'/{id}/attachments':['post'],'/{id}/attachments/{attachmentId}':['delete','get'],
        '/{id}/history':['get'],'/{id}/context-preview':['post'],'/{id}/turns':['post'],'/{id}/turns/{turnId}':['delete'],'/{id}/turns/{turnId}/retry':['post'],'/{id}/turns/{turnId}/cancel':['post']};
    for(const [suffix,methods] of Object.entries(expected)){
        assert.deepEqual(Object.keys(actual.paths[base+suffix]).sort(),methods);
        for(const operation of Object.values(actual.paths[base+suffix]))assert.deepEqual(operation.security,[{sessionCookie:[]}]);
    }
    const upload=actual.paths[chat+'/attachments'].post.requestBody.content['application/json'].schema;
    assert.deepEqual([...upload.required].sort(),['contentBase64','name','requestId']);assert.equal(upload.properties.contentBase64.type,'string');
    const send=actual.paths[chat+'/turns'].post.requestBody.content['application/json'].schema;
    assert.ok(send.required.includes('expectedRevision'));assert.ok(send.required.includes('expectedModelPin'));assert.ok(send.required.includes('requestId'));
    assert.equal(send.properties.attachmentIds.type,'array');
    for(const operation of Object.values(actual.paths[chat]))assert.equal(operation.parameters.some(parameter=>/^x-(?:bridge|neurocenter-internal)/i.test(parameter.name)),false);
});

test('Learning separates browser review, four core device actions and owned sync channels', () => {
    const prefix='/api/projects/{id}/learning';
    const browser={
        '':['get'], '/context':['get'], '/history':['get'], '/requests/{key}':['get'],
        '/experiences':['get','post'], '/experiences/{recordId}':['get'],
        '/hypotheses':['get','post'], '/hypotheses/{recordId}':['get'],
        '/hypotheses/{hypothesisId}/checks':['get','post'], '/hypotheses/{hypothesisId}/checks/{checkId}':['get'],
        '/candidates':['get','post'], '/candidates/{recordId}':['get'],
        '/candidates/{candidateId}/approve':['post'], '/candidates/{candidateId}/reject':['post'],
        '/candidates/{candidateId}/revoke':['post'], '/candidates/{candidateId}/activate':['post'],
        '/analyses':['post'], '/analyses/{analysisId}':['get'], '/analyses/requests/{key}':['get'],
    };
    const device=['context','record','observe','propose'].map(suffix=>'/api/device-channel/learning/'+suffix);
    const sync=['/api/device-channel/learning-memory/context','/api/device-channel/learning-quirks/import'];
    const expected=[...Object.keys(browser).map(suffix=>prefix+suffix),...device,...sync].sort();
    assert.deepEqual(Object.keys(actual.paths).filter(pathname=>pathname.includes('/learning')).sort(),expected);
    for(const [suffix,methods] of Object.entries(browser)){
        const pathname=prefix+suffix,operations=actual.paths[pathname];
        assert.deepEqual(Object.keys(operations).sort(),[...methods].sort(),pathname);
        for(const operation of Object.values(operations))assert.deepEqual(operation.security,[{sessionCookie:[]}],pathname);
    }
    for(const pathname of [...device,...sync]){
        assert.deepEqual(Object.keys(actual.paths[pathname]),['post']);
        assert.deepEqual(actual.paths[pathname].post.security,[{deviceBearer:[]}]);
        assert.equal(actual.paths[pathname].post['x-neurocenter-service'],'catalog-service');
    }
    const quirks=actual.paths['/api/device-channel/learning-quirks/import'];
    assert.deepEqual(Object.keys(quirks),['post']);
    assert.deepEqual(quirks.post.security,[{deviceBearer:[]}]);
    for(const suffix of ['approve','reject','revoke','activate','analyses'])assert.equal(actual.paths['/api/device-channel/learning/'+suffix],undefined);
});

test('Learning requests expose their validated input contracts and CAS without trusting device review', () => {
    const prefix='/api/projects/{id}/learning';
    const body=pathname=>actual.paths[pathname].post.requestBody.content['application/json'].schema;
    const required=(schema,names)=>assert.deepEqual([...schema.required].sort(),[...names].sort());
    const experience=body(prefix+'/experiences');
    required(experience,['requestKey','expectedRevision','title','summary','outcome','evidence']);
    assert.equal(experience.properties.expectedRevision.type,'number');
    assert.deepEqual([...experience.properties.outcome.enum].sort(),['failed','mixed','succeeded','unknown']);
    required(experience.properties.evidence.items,['kind','status','summary']);
    const hypothesis=body(prefix+'/hypotheses');
    required(hypothesis,['requestKey','expectedRevision','subject','title','statement','rationale','verificationPlan','experienceIds']);
    assert.deepEqual([...hypothesis.properties.subject.enum].sort(),['agent','project']);
    const check=body(prefix+'/hypotheses/{hypothesisId}/checks');
    required(check,['requestKey','expectedRevision','method','result','summary','experienceIds']);
    assert.deepEqual([...check.properties.method.enum].sort(),['human_review','llm_assessment']);
    const candidate=body(prefix+'/candidates');
    required(candidate,['requestKey','expectedRevision','hypothesisId','checkId','key','kind','title','content']);
    assert.deepEqual([...candidate.properties.kind.enum].sort(),['instruction','lesson']);
    for(const action of ['approve','reject','revoke','activate']){
        const schema=body(prefix+'/candidates/{candidateId}/'+action);
        required(schema,['requestKey','expectedRevision']);assert.equal(schema.properties.reason.type,'string');
    }
    const analysis=body(prefix+'/analyses');
    required(analysis,['requestKey','expectedRevision','experienceIds']);assert.equal(analysis.properties.modelId.type,'string');
    const receipt=jsonResponse(actual.paths[prefix+'/analyses'].post,'201');
    assert.deepEqual([...receipt.properties.state.enum].sort(),['completed','failed','queued','running','unknown']);
    const context=body('/api/device-channel/learning/context');
    required(context,['projectId','bindingId','instanceId']);assert.equal(context.properties.input,undefined);
    for(const [channel,input] of [['record',experience],['propose',hypothesis]]){
        const schema=body('/api/device-channel/learning/'+channel);
        required(schema,['projectId','bindingId','instanceId','input']);
        assert.deepEqual(schema.properties.input,input);
    }
    const observation=body('/api/device-channel/learning/observe');
    required(observation,['projectId','bindingId','instanceId','input']);
    required(observation.properties.input,['requestKey','title','summary','outcome','evidence']);
    assert.equal(observation.properties.input.properties.expectedRevision,undefined,'Observed metadata appends without inventing a browser revision.');
});

test('Bridge installer configuration exposes the trusted public Gateway origin', () => {
    const config = actual.paths['/api/bridge/config'].get;
    assert.deepEqual(config.security, []);
    assert.equal(jsonResponse(config).properties.origin.type, 'string');
});
test('Bridge source documents revision-checked configuration, explicit imports and cached metadata checks',()=>{
    const source=actual.paths['/api/bridge-source'];
    assert.deepEqual(source.get.security,[{sessionCookie:[]}]);
    const view=jsonResponse(source.get);
    assert.equal(view.properties.url.type,'string');assert.equal(view.properties.revision.type,'number');
    assert.equal(view.properties.available.properties.repositoryCommit.type,'string');
    assert.equal(view.properties.imported.properties.targets.items.type,'string');
    const save=source.put.requestBody.content['application/json'].schema;
    assert.deepEqual(save.required,['url','expectedRevision']);
    const check=actual.paths['/api/bridge-source/check'].post;
    assert.deepEqual(check.requestBody.content['application/json'].schema.required,['expectedRevision']);
    assert.equal(check.requestBody.content['application/json'].schema.properties.force.type,'boolean');
    assert.equal(check.responses['201'],undefined);assert.ok(check.responses['200']);
    const selected=actual.paths['/api/bridge-source/import'].post.requestBody.content['application/json'].schema;
    assert.deepEqual(selected.required,['expectedRevision','commit','assetId','requestKey']);
});

test('Actual project and skill contracts include usable typed bodies, responses and queries', () => {
    const project = actual.paths['/api/projects'].post;
    assert.equal(project.requestBody.content['application/json'].schema.properties.name.type, 'string');
    assert.equal(jsonResponse(project, '201').properties.id.type, 'string');
    const skills = actual.paths['/api/skills'].get;
    assert.ok(skills.parameters.some(item => item.in === 'query' && item.name === 'path'));
    const skillPackage = actual.paths['/api/skills/_package/{skillPath}'].get;
    assert.equal(skillPackage.parameters.find(item => item.name === 'version').required, true);
    assert.equal(jsonResponse(skillPackage).properties.path.type, 'string');
    assert.equal(skillPackage.responses['200'].content['application/octet-stream'], undefined);
    const pluginPackage = actual.paths['/api/ai-plugins/{id}/package'].get;
    assert.ok(jsonResponse(pluginPackage).properties.manifest);
    assert.equal(pluginPackage.parameters.find(item => item.name === 'version').required, false);
    for (const [pathname, methods] of Object.entries(actual.paths)) if(pathname.startsWith('/api/rag/')) for (const item of Object.values(methods)) for(const parameter of item.parameters) if(parameter.name === 'projectKey') assert.equal(parameter.required, true, pathname);
});

test('Catalog requests document typed submissions, review actions and scoped filters', () => {
    const requests = actual.paths['/api/catalog-requests'];
    const create = requests.post.requestBody.content['application/json'].schema;
    assert.deepEqual(create.required, ['requestKey','kind','assetType','title','description']);
    assert.deepEqual([...create.properties.kind.enum].sort(), ['add','issue','update']);
    assert.deepEqual([...create.properties.assetType.enum].sort(), ['mcp','model','plugin','skill']);
    assert.equal(create.properties.target.nullable, true);
    assert.deepEqual(create.properties.target.required, ['type','id']);
    const filters = requests.get.parameters.filter(item => item.in === 'query');
    assert.deepEqual(filters.map(item => item.name), ['scope','status','kind','assetType','projectId','page','size']);
    assert.ok(filters.every(item => item.required === false));
    const action = actual.paths['/api/catalog-requests/{id}/actions'].post.requestBody.content['application/json'].schema;
    assert.deepEqual(action.required, ['requestKey','expectedRevision','action']);
    assert.deepEqual([...action.properties.action.enum].sort(), ['cancel','complete','needs_info','reject','resubmit','start']);
    assert.equal(action.properties.expectedRevision.type, 'number');
    assert.ok(jsonResponse(requests.get).properties.items.items.properties.permissions);
    assert.ok(jsonResponse(actual.paths['/api/catalog-requests/{id}'].get).properties.history.items.properties.actor);
});

test('Redirects, manual OAuth JSON, binary streams and HEAD reflect the actual HTTP transport', () => {
    for (const pathname of ['/auth/login','/auth/callback','/auth/logout']) {
        const response = actual.paths[pathname].get.responses['302'];
        assert.ok(response.headers.Location);
        assert.equal(response.content, undefined);
    }
    assert.ok(jsonResponse(actual.paths['/auth/me'].get).properties.user);
    assert.ok(actual.paths['/auth/switch-role'].post.responses['200']);
    assert.equal(actual.paths['/auth/switch-role'].post.responses['201'], undefined);
    const upload = actual.paths['/api/tool-builds/uploads/{id}/content'].put;
    assert.equal(upload.requestBody.content['application/octet-stream'].schema.format, 'binary');
    const assetArchive=actual.paths['/api/asset-sources/archive'].put;
    assert.equal(assetArchive.requestBody.content['application/octet-stream'].schema.format,'binary');
    const supply = actual.paths['/api/tool-builds/{id}/supply'];
    assert.equal(supply.get.responses['200'].content['application/gzip'].schema.format, 'binary');
    assert.deepEqual(supply.head.responses['204'], {description:'No response body.'});
    const asset = jsonResponse(actual.paths['/api/tool-builds/{id}/asset'].get);
    assert.ok(asset.anyOf.length >= 5);
    for(const variant of asset.anyOf) {
        assert.equal(variant.type, 'object');
        assert.deepEqual(variant.properties.schemaVersion, {type:'number',enum:[1]});
    }
    const reindex = actual.paths['/api/projects/{projectId}/embedding/reindex'].get;
    assert.equal(jsonResponse(reindex)['x-neurocenter-untyped'], undefined, 'res.json without explicit status is HTTP 200');
});

test('Device and MCP routes expose the actual public authentication and protocol requirements', () => {
    assert.deepEqual(actual.paths['/api/device-channel/pair/start'].post.security, []);
    assert.deepEqual(actual.paths['/api/device-channel/identity'].post.security, [{deviceBearer:[]}]);
    const presence=actual.paths['/api/device-channel/presence'].post;
    assert.deepEqual(presence.security,[{deviceBearer:[]}]);
    const presenceBody=presence.requestBody.content['application/json'].schema;
    for(const key of ['platform','arch','runtimeVersion','bridgeVersion','buildId','protocolVersion'])assert.ok(presenceBody.required.includes(key));
    const runtime = actual.paths['/api/device-channel/jobs/{id}/runtime/{sha256}'].get;
    assert.equal(runtime.responses['200'].content['application/gzip'].schema.format, 'binary');
    assert.equal(runtime.parameters.find(item => item.name === 'x-neurocenter-job-lease').required, true);
    for (const item of Object.values(actual.paths['/api/projects/{id}/snapshot-uploads/{sid}/status'])) {
        assert.ok(item.security.some(scheme => scheme.deviceBearer));
        for (const name of ['x-neurocenter-job-id','x-neurocenter-job-lease']) {
            const header = item.parameters.find(parameter => parameter.name === name);
            assert.equal(header.required, false);
            assert.match(header.description, /Required when using deviceBearer/);
        }
    }
    const mcp = actual.paths['/api/mcp-host/m/{ticket}'];
    assert.deepEqual(Object.keys(mcp).sort(), ['delete','get','post']);
    assert.deepEqual(mcp.post.security, []);
    assert.equal(mcp.post.requestBody.content['application/json'].schema['x-neurocenter-untyped'], true);
    assert.equal(mcp.post.responses['200'].content['text/event-stream'].schema.type, 'string');
    assert.ok(mcp.post.responses['202']);
    assert.ok(mcp.post.responses['405']);
});

test('Retained disabled endpoints advertise their error instead of a fabricated successful response', () => {
    for (const [pathname, method, status] of [['/api/ai-plugins/import-local','post','410'],['/api/local-assets/scan','get','410'],['/api/local-assets/install','post','409']]) {
        const item = actual.paths[pathname][method];
        assert.equal(item.deprecated, true);
        assert.ok(item.responses[status]);
        assert.ok(Object.keys(item.responses).every(code => !/^2/.test(code)));
    }
    assert.ok(actual.paths['/api/projects/import-local'].post.responses['201']);
});

test('Remote connection docs expose bounded generation defaults and a write-only key with the model CAS receipt', () => {
    const item = actual.paths['/api/models/{id}/connection'];
    const body = item.put.requestBody.content['application/json'].schema;
    const options = body.properties.options.properties;
    assert.deepEqual(Object.keys(options).sort(), ['apiFormat','contextWindow','maxOutputTokens','providerParameters','reasoningEffort','responseModel','store','temperature','tokenLimitParameter','topP']);
    assert.deepEqual(options.apiFormat.enum,['chat-completions','responses']);
    assert.deepEqual(options.reasoningEffort.enum,['none','minimal','low','medium','high','xhigh','max']);
    assert.equal(options.store.type,'boolean');
    assert.deepEqual(options.store.enum,[false,true]);
    assert.equal(options.providerParameters.type,'object');
    assert.ok(options.providerParameters.additionalProperties);
    assert.deepEqual(options.tokenLimitParameter.enum,['max_tokens','max_completion_tokens']);
    assert.match(options.responseModel.description,/exact response identity/);
    assert.match(options.contextWindow.description, /Remote Ollama/);
    assert.match(body.properties.timeoutMs.description, /1000 to 300000/);
    assert.match(body.properties.apiKey.description, /Write-only/);
    assert.ok(!body.required.includes('options')); assert.ok(!body.required.includes('apiKey'));
    for (const method of ['get','put']) {
        const result = jsonResponse(item[method]);
        assert.equal(result.properties.modelRevision.type, 'number');
        assert.ok(result.required.includes('modelRevision'));
        assert.ok(!Object.hasOwn(result.properties, 'apiKey'));
    }
});

test('All path parameters are required, operation IDs unique, schemas local and generation deterministic', () => {
    const ids = new Set();
    for (const [pathname, methods] of Object.entries(actual.paths)) for (const item of Object.values(methods)) {
        assert.ok(!ids.has(item.operationId)); ids.add(item.operationId);
        for (const [,name] of pathname.matchAll(/\{([^{}]+)\}/g)) assert.equal(item.parameters.find(parameter => parameter.name === name && parameter.in === 'path')?.required, true, pathname);
        for (const parameter of item.parameters) assert.doesNotMatch(parameter.name, /^x-(?:neurocenter-internal|bridge-)/i);
    }
    const serialized = JSON.stringify(actual);
    assert.doesNotMatch(serialized, /\/Users\/|node_modules|localhost:|process\.env/);
    assert.deepEqual(actual.servers, [{url:'/',description:'Current Neurocenter site'}]);
    assert.deepEqual(generateOpenApi(fixtureRoot), fixtureDocument);
});

test('Source-only Docker context and full checkout produce identical complete contracts', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neurocenter-openapi-context-'));
    temporary.push(directory);
    for (const service of SERVICES) {
        const destination = path.join(directory,'services',service);
        fs.mkdirSync(destination,{recursive:true});
        fs.cpSync(path.join(root,'services',service,'src'),path.join(destination,'src'),{recursive:true});
    }
    fs.cpSync(path.join(root,'services/shared'),path.join(directory,'services/shared'),{recursive:true});
    fs.copyFileSync(path.join(root,'services/api-gateway/package.json'),path.join(directory,'services/api-gateway/package.json'));
    fs.symlinkSync(path.join(root,'services/api-gateway/node_modules'),path.join(directory,'node_modules'),'dir');
    assert.deepEqual(generateOpenApi(directory),actual);
});

test('CLI requires an explicit destination, supports build root override and writes only the requested artifact', () => {
    const generator = path.join(root, 'scripts/openapi/generate.mjs');
    for (const args of [[], ['--output'], ['--unsupported','value']]) {
        const result = spawnSync(process.execPath, [generator,...args], {encoding:'utf8'});
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /output path is required|Usage:/);
    }
    const output = path.join(fixtureRoot, 'artifact/openapi.json');
    const result = spawnSync(process.execPath, [generator,'--root',fixtureRoot,'--output',output], {
        encoding:'utf8', env:{...process.env,NEUROCENTER_OPENAPI_ROOT:'/missing-root-ignored-by-explicit-flag'},
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(output,'utf8')), fixtureDocument);
    fs.unlinkSync(output);
    const fallback = spawnSync(process.execPath, [generator,'--output',output], {encoding:'utf8',env:{...process.env,NEUROCENTER_OPENAPI_ROOT:fixtureRoot}});
    assert.equal(fallback.status, 0, fallback.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(output,'utf8')), fixtureDocument);
});
