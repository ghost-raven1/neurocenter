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
function fixture(source) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'neurocenter-openapi-'));
    temporary.push(directory);
    const gateway = path.join(directory, 'services/api-gateway');
    const catalog = path.join(directory, 'services/catalog-service/src');
    fs.mkdirSync(gateway, {recursive: true});
    fs.mkdirSync(catalog, {recursive: true});
    fs.writeFileSync(path.join(gateway, 'package.json'), '{"version":"0.0.1-fixture"}');
    fs.symlinkSync(path.join(root, 'services/api-gateway/node_modules'), path.join(directory, 'node_modules'), 'dir');
    fs.writeFileSync(path.join(catalog, 'fixture.controller.ts'), source);
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
after(() => {for (const directory of temporary) fs.rmSync(directory, {recursive: true, force: true});});

const jsonResponse = (operation, status = '200') => operation.responses[status].content['application/json'].schema;

test('Static Nest decorators, aliases, prefix arrays and gateway boundaries define public routes', () => {
    assert.equal(fixtureDocument.info.version, '0.0.1-fixture');
    assert.ok(fixtureDocument.paths['/api/sample'].post);
    assert.ok(fixtureDocument.paths['/api/sample-alias'].post);
    assert.ok(fixtureDocument.paths['/api/feature-flags-extra'].get, 'Feature flags routing has an exact segment boundary');
    for (const hidden of ['/internal/secrets', '/health', '/api/fake', '/api/skills/orphan']) assert.equal(fixtureDocument.paths[hidden], undefined, hidden);
});

test('Typed bodies preserve required fields, literal unions, null, collections and explicit unknown data', () => {
    const schema = fixtureDocument.paths['/api/sample'].post.requestBody.content['application/json'].schema;
    assert.deepEqual(schema.required, ['name', 'kind', 'enabled', 'nullable', 'values', 'metadata', 'timestamp']);
    assert.deepEqual(schema.properties.kind, {type:'string', enum:['skill','plugin']});
    assert.equal(schema.properties.name.description, 'Human readable name.');
    assert.equal(schema.properties.nullable.nullable, true);
    assert.deepEqual(schema.properties.values, {type:'array', items:{type:'string'}});
    assert.deepEqual(schema.properties.timestamp, {type:'string', format:'date-time'});
    assert.equal(schema.properties.metadata.additionalProperties['x-neurocenter-untyped'], true);
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
    assert.equal(Object.keys(actual.paths).length, 169);
    assert.equal(Object.values(actual.paths).reduce((sum, item) => sum + Object.keys(item).length, 0), 207);
    for (const representative of ['/api/projects','/api/skills','/api/rag/sync','/api/feature-flags','/auth/me','/api/bridge/install.sh','/api/mcp-host/connect']) assert.ok(actual.paths[representative], representative);
    for (const pathname of Object.keys(actual.paths)) assert.match(pathname, /^\/(?:api|auth)\//);
    for (const privatePath of ['/api/{path}','/api/device-channel/mcp-host/authorize','/internal/device-channel/identity','/api/rag/health','/health','/metrics','/bridge/install.sh']) assert.equal(actual.paths[privatePath], undefined, privatePath);
    assert.equal(actual.paths['/api/rag/sync'].post['x-neurocenter-service'], 'catalog-service');
    assert.equal(actual.paths['/api/feature-flags'].get['x-neurocenter-service'], 'feature-flags-service');
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
