import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import { packRuntime } from '../catalog-plugins/pack.mjs';
import { startSkillPackagingFixture } from './skill-packaging.fixture.mjs';

const require = createRequire(new URL('../../services/api-gateway/package.json', import.meta.url));
const catalogRequire = createRequire(new URL('../../services/catalog-service/package.json', import.meta.url));
require('reflect-metadata');
const { Module } = require('@nestjs/common'),
    { NestFactory } = require('@nestjs/core'),
    { ConfigService } = require('@nestjs/config');
const { AuthGuardService } = require('./dist/auth/auth-guard.service.js');
const { McpHostController } = require('./dist/features/mcp-host/mcp-host.controller.js');
const { hostRuntimeTarget } = require('./dist/features/mcp-host/host-target.js');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { buildPackage } = catalogRequire('./dist/catalog/bundle-package.js');
const { RuntimeArtifacts } = catalogRequire('./dist/runtime-artifacts/runtime-artifacts.js');
const { normalizeRuntimeArtifacts, runtimeDescriptorDigest } = catalogRequire('../shared/runtime-artifacts.cjs');

test(
    'Hosted MCP real Gateway → Catalog → artifact → SDK channel checks fresh project access',
    { skip: !process.env.CATALOG_TEST_PG_URL, timeout: 120000 },
    async (t) => {
        const f = await startSkillPackagingFixture({ adminUrl: process.env.CATALOG_TEST_PG_URL });
        let app, client, client2;
        t.after(async () => {
            await client?.close();
            await client2?.close();
            await app?.close();
            await f.close();
        });
        process.env.NEUROCENTER_MCP_HOST_DIR = path.join(f.temporary, 'host-cache');
        // AD-5: сервер выпускает билеты только от независимого секрета хоста (без fallback на internal token).
        process.env.NEUROCENTER_MCP_HOST_SECRET = randomBytes(32).toString('hex');
        // AD-4: окно отзыва = TTL единого кэша re-check; в тесте окно сужаем (в production ≤60s).
        process.env.NEUROCENTER_MCP_HOST_AUTHZ_TTL_MS = '150';
        const source = path.join(f.temporary, 'host-source');
        await fs.mkdir(source);
        const code = `const r=require('node:readline').createInterface({input:process.stdin});let calls=0;r.on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;const result=q.method==='initialize'?{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'qa-mcp',version:'1'}}:q.method==='tools/list'?{tools:[{name:'qa_read',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true,destructiveHint:false}}]}:q.method==='tools/call'?{content:[{type:'text',text:'synthetic call '+(++calls)}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');});`;
        await fs.writeFile(path.join(source, 'server.cjs'), code);
        const archive = path.join(f.temporary, 'host.tar.gz');
        const descriptor = await packRuntime({
            directory: source,
            archivePath: archive,
            target: hostRuntimeTarget(),
            entrypoint: 'server.cjs',
        });
        await f.catalog.get(RuntimeArtifacts).importArchive(archive, descriptor);
        // AD-16: закреплённый пакет обязан соответствовать версии каталога, поэтому хост-карточка
        // создаётся через API (строка ai_plugin_versions существует и проверяется гейтом отзыва).
        const card = await f.request('main', '/api/ai-plugins', {
            method: 'POST',
            status: 201,
            body: {
                name: 'Hosted QA',
                kind: 'mcp',
                description: 'QA hosted MCP card',
                config: { transport: 'stdio', args: [], extra: { hostedMcp: true, runtimeArtifacts: [descriptor] } },
            },
        });
        const pkg = buildPackage(
            { id: card.id, kind: 'mcp', name: 'Hosted QA', version: 1 },
            [],
            '',
            { transport: 'stdio', args: [], extra: { hostedMcp: true, runtimeArtifacts: [descriptor] } },
        );
        const pin = async (current = pkg, projectId = f.projectId) =>
            f.pool.query(
                `INSERT INTO project_assets(project_id,asset_id,asset_kind,added_by,asset_version,asset_manifest,pin_origin,pin_snapshot)
 VALUES($1,$2,'mcp',$3,$4,$5,'assigned',$6) ON CONFLICT(project_id,asset_kind,asset_id) DO UPDATE SET asset_version=excluded.asset_version,asset_manifest=excluded.asset_manifest,pin_snapshot=excluded.pin_snapshot`,
                [
                    projectId,
                    current.plugin.id,
                    f.actors.main.email,
                    current.plugin.version,
                    current.manifest.sha256,
                    { card: { id: current.plugin.id }, package: current },
                ],
            );
        await pin();
        const deviceId = randomUUID(),
            token = randomBytes(32).toString('hex'),
            report = {
                protocolVersion: 2,
                capabilities: ['durable-completions', 'managed-installations'],
                bindings: [{ projectId: f.projectId, bindingId: 'a'.repeat(64), valid: true }],
            };
        await f.pool.query(
            "INSERT INTO bridge_devices(id,email,role,name,fingerprint,token_hash,report) VALUES($1,$2,'Разработчик','Hosted HTTP QA',$3,$4,$5)",
            [
                deviceId,
                f.actors.developer.email,
                'f'.repeat(64),
                createHash('sha256').update(token).digest('hex'),
                report,
            ],
        );
        const config = { get: (key) => process.env[key] },
            auth = new AuthGuardService(config);
        class Fixture {}
        Module({
            controllers: [McpHostController],
            providers: [
                { provide: AuthGuardService, useValue: auth },
                { provide: ConfigService, useValue: config },
            ],
        })(Fixture);
        app = await NestFactory.create(Fixture, { logger: false, abortOnError: false });
        await app.listen(0, '127.0.0.1');
        const base = 'http://127.0.0.1:' + app.getHttpServer().address().port;
        const connect = async (current = pkg, projectId = f.projectId) => {
            const response = await fetch(base + '/api/mcp-host/connect', {
                method: 'POST',
                headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
                body: JSON.stringify({ projectId, pkg: current }),
                signal: AbortSignal.timeout(15000),
            });
            return { status: response.status, data: await response.json() };
        };
        // AD-4: даём единому кэшу re-check протухнуть (TTL 150 ms), чтобы отзыв гарантированно подействовал.
        const settle = () => new Promise((resolve) => setTimeout(resolve, 250));
        await t.test('self-signed substitution and foreign project never receive a ticket', async () => {
            const forged = buildPackage({ ...pkg.plugin, version: 2 }, [], '', pkg.config);
            assert.equal((await connect(forged)).status, 403);
            await f.pool.query("INSERT INTO projects(id,name) VALUES('prj-host-other','Other')");
            await pin(pkg, 'prj-host-other');
            assert.equal((await connect(pkg, 'prj-host-other')).status, 403);
        });
        let channel;
        await t.test('actual SDK initialize → tools/list → tools/call works with exact approved runtime', async () => {
            const connected = await connect();
            assert.equal(connected.status, 200, JSON.stringify(connected.data));
            // AD-3: сертификат — sha256 канонического descriptor-текста одобренного пакета (клиент сверит свой).
            assert.equal(
                connected.data.descriptorSha256,
                runtimeDescriptorDigest(normalizeRuntimeArtifacts(pkg.config.extra.runtimeArtifacts)),
            );
            channel = connected.data.path;
            client = new Client({ name: 'qa-client', version: '1' }, { capabilities: {} });
            await client.connect(new StreamableHTTPClientTransport(new URL(base + channel)), { timeout: 15000 });
            assert.equal((await client.listTools(undefined, { timeout: 15000 })).tools[0].name, 'qa_read');
            assert.match(
                (await client.callTool({ name: 'qa_read', arguments: {} }, undefined, { timeout: 15000 })).content[0]
                    .text,
                /synthetic call 1/,
            );
        });
        await t.test('head (version-less) descriptor is never issued: actionable 404 at the catalog, 403 at the gateway', async () => {
            const head = buildPackage({ ...pkg.plugin, version: undefined }, [], '', pkg.config);
            assert.equal((await connect(head)).status, 403);
            const response = await fetch(f.catalogUrl + '/internal/device-channel/mcp-host/authorize', {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN,
                    authorization: 'Bearer ' + token,
                },
                body: JSON.stringify({ projectId: f.projectId, pkg: head }),
                signal: AbortSignal.timeout(15000),
            });
            assert.equal(response.status, 404);
            assert.match((await response.json()).message, /явной версии/);
        });
        await t.test('head snapshot of a hosted-MCP card is not delivered without an explicit version', async () => {
            const card = await f.request('main', '/api/ai-plugins', {
                method: 'POST',
                status: 201,
                body: {
                    name: 'Hosted QA Head',
                    kind: 'mcp',
                    description: 'QA hosted MCP card',
                    config: { transport: 'stdio', args: [], extra: { hostedMcp: true, runtimeArtifacts: [descriptor] } },
                },
            });
            await f.request('main', `/api/ai-plugins/${card.id}/package`, { status: 404 });
            const explicit = await f.request('main', `/api/ai-plugins/${card.id}/package?version=1`);
            assert.equal(explicit.plugin.version, 1);
        });
        await t.test('installation off preserves existing sessions but refuses a new connection', async () => {
            f.state.featureOverrides.tool_installation = false;
            assert.equal((await connect()).status, 403);
            assert.equal((await client.listTools(undefined, { timeout: 15000 })).tools.length, 1);
            f.state.featureOverrides.tool_installation = true;
        });
        await t.test('project role revocation blocks a previously issued signed ticket', async () => {
            await f.pool.query('DELETE FROM project_members WHERE principal_name=$1', [f.actors.developer.email]);
            await settle();
            await assert.rejects(client.callTool({ name: 'qa_read', arguments: {} }, undefined, { timeout: 15000 }));
            await f.pool.query(
                'INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,$2,$3)',
                [f.projectId, f.actors.developer.email, 'Разработчик'],
            );
            assert.equal((await client.listTools(undefined, { timeout: 15000 })).tools.length, 1);
            assert.match(
                (await client.callTool({ name: 'qa_read', arguments: {} }, undefined, { timeout: 15000 })).content[0]
                    .text,
                /synthetic call 2/,
            );
        });
        await t.test('repinning the assigned package invalidates the old ticket without executing a tool', async () => {
            await pin(buildPackage({ ...pkg.plugin, version: 2 }, [], '', pkg.config));
            await settle();
            await assert.rejects(client.callTool({ name: 'qa_read', arguments: {} }, undefined, { timeout: 15000 }));
            await pin();
            assert.match(
                (await client.callTool({ name: 'qa_read', arguments: {} }, undefined, { timeout: 15000 })).content[0]
                    .text,
                /synthetic call 3/,
            );
        });
        await t.test('a signed legacy ticket without project/device lineage requires reinstall', async () => {
            const raw = channel.split('/').at(-1).split('.')[0],
                claim = JSON.parse(Buffer.from(raw, 'base64url'));
            delete claim.session;
            const payload = Buffer.from(JSON.stringify(claim)).toString('base64url'),
                secret = process.env.NEUROCENTER_MCP_HOST_SECRET;
            const legacy = payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
            const response = await fetch(base + '/api/mcp-host/m/' + legacy, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
            });
            assert.equal(response.status, 401);
            await response.body.cancel();
        });
        await t.test('AD-16: retiring the assigned version kills the live session, new connects and new assignments', async () => {
            const card2 = await f.request('main', '/api/ai-plugins', {
                method: 'POST',
                status: 201,
                body: {
                    name: 'Retire QA',
                    kind: 'mcp',
                    description: 'QA retired MCP card',
                    config: { transport: 'stdio', args: [], extra: { hostedMcp: true, runtimeArtifacts: [descriptor] } },
                },
            });
            const pkg2 = buildPackage(
                { id: card2.id, kind: 'mcp', name: 'Retire QA', version: 1 },
                [],
                '',
                { transport: 'stdio', args: [], extra: { hostedMcp: true, runtimeArtifacts: [descriptor] } },
            );
            await pin(pkg2);
            // Роль-гейт: не «Главный админ» не отзывает (403 до изменения состояния).
            await f.request('developer', `/api/ai-plugins/${card2.id}/versions/1/retire`, {
                method: 'POST',
                status: 403,
            });
            // Живая сессия на отзываемой версии: connect + SDK-канал ДО отзыва.
            const connected2 = await connect(pkg2);
            assert.equal(connected2.status, 200, JSON.stringify(connected2.data));
            const channel2 = connected2.data.path;
            client2 = new Client({ name: 'qa-client-2', version: '1' }, { capabilities: {} });
            await client2.connect(new StreamableHTTPClientTransport(new URL(base + channel2)), { timeout: 15000 });
            assert.match(
                (await client2.callTool({ name: 'qa_read', arguments: {} }, undefined, { timeout: 15000 })).content[0]
                    .text,
                /synthetic call \d+/,
            );
            // Отзыв: 201 (NestJS-дефолт для POST, как у activate); повтор — 409 (необратимо).
            await f.request('main', `/api/ai-plugins/${card2.id}/versions/1/retire`, { method: 'POST', status: 201 });
            await f.request('main', `/api/ai-plugins/${card2.id}/versions/1/retire`, { method: 'POST', status: 409 });
            // Статус виден в списке версий; байты сохраняются (провенанс FR-204).
            const versions = await f.request('main', `/api/ai-plugins/${card2.id}/versions`);
            assert.equal(versions.length, 1);
            assert.equal(versions[0].status, 'retired');
            const pkg2after = await f.request('main', `/api/ai-plugins/${card2.id}/package?version=1`);
            assert.equal(pkg2after.plugin.version, 1);
            // Аудит: ровно одна запись security_events.
            const events = (
                await f.pool.query(
                    "SELECT actor,resource_id FROM security_events WHERE action='plugin.version.retire'",
                )
            ).rows;
            assert.equal(events.length, 1);
            assert.equal(events[0].actor, f.actors.main.email);
            assert.equal(events[0].resource_id, card2.id + ':1');
            // Новый connect отозванной версии — 403.
            assert.equal((await connect(pkg2)).status, 403);
            // Живая сессия: билет сгорает при следующем re-check (после протухания TTL кэша).
            await settle();
            await assert.rejects(client2.callTool({ name: 'qa_read', arguments: {} }, undefined, { timeout: 15000 }));
            // Новое назначение отозванной карточки (в другой проект, где она ещё не назначена) — 409.
            const newProject = 'prj-retire-new-' + randomUUID().slice(0, 8);
            await f.pool.query('INSERT INTO projects(id,name) VALUES($1,$2)', [newProject, 'Retire QA New Project']);
            await f.request('main', `/api/projects/${newProject}/assets`, {
                method: 'POST',
                status: 409,
                body: { assetId: card2.id, assetKind: 'mcp' },
            });
        });
        await t.test('device revocation blocks the existing SDK channel', async () => {
            await f.pool.query('UPDATE bridge_devices SET revoked=true WHERE id=$1', [deviceId]);
            await settle();
            await assert.rejects(client.listTools(undefined, { timeout: 15000 }));
            assert.equal((await connect()).status, 401);
        });
        assert.deepEqual(f.state.externalCalls, []);
    },
);
