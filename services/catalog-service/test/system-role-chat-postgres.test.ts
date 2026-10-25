import { ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ownedTestPostgresAdmin } from '../../../scripts/test/owned-postgres.fixture.mjs';
import { migrateCatalog } from '../src/database/migrations';
import { CATALOG_MIGRATIONS } from '../src/database/catalog-migrations';
import { CATALOG_SCHEMA_FACTS_SQL } from '../src/database/schema-catalog';
import { assertSystemRoleChatSchema } from '../src/system-role-chat/system-role-chat.schema-verification';
import { SystemRoleChatService } from '../src/system-role-chat/system-role-chat.service';
import { SystemRoleService } from '../src/system-roles/system-role.service';
import { roleDefinitionPin } from '../src/system-roles/system-role.definitions';
import { modelFromRow } from '../src/models/model-history';
import { projectEmbeddingPin } from '../src/models/project-embedding.validation';
import type { Request } from 'express';

const flags = vi.hoisted(() => ({ enabled: true }));
vi.mock('../src/features/require-feature-enabled', () => ({ requireFeaturesEnabled: async () => { if (!flags.enabled) throw new ForbiddenException('Feature disabled'); } }));
const connection = process.env.SYSTEM_ROLE_CHAT_TEST_ADMIN_URL, owner = 'owner@service-chat.test', other = 'other@service-chat.test', project = 'prj-service-chat';
const req = (email = owner, activeRole = 'Админ проекта') => ({ headers: {}, email, activeRole }) as unknown as Request;

describe.skipIf(!connection).sequential('System-role chat atomic receipts on caller-owned PostgreSQL; no inference', () => {
    let pool: Pool, admin: Pool, database: string, roles: SystemRoleService, chat: SystemRoleChatService;
    const infer = vi.fn(async () => { throw new Error('Native receipt QA must never invoke a model'); });
    const selection = { projectId: project, instruction: 'Проверь готовность проекта', diagnostics: [], targets: [] };
    let modelPin: string;
    const sendBody = (requestId = randomUUID()) => ({ agentId: 'agent-coordinator', input: { ...selection, requestId, modelId: 'model-service-chat', expectedModelPin: modelPin, expectedDefinitionPin: roleDefinitionPin('agent-coordinator'), consentDigest: 'c'.repeat(64) } });
    const create = (request = req()) => chat.create(request, { id: randomUUID(), title: 'Проверка проекта', projectId: project });
    const counts = async () => ({ turns: Number((await pool.query('SELECT count(*) FROM system_role_dialog_intents')).rows[0].count), runs: Number((await pool.query('SELECT count(*) FROM system_role_runs')).rows[0].count), calls: infer.mock.calls.length });
    beforeAll(async () => {
        const url = ownedTestPostgresAdmin(connection); admin = new Pool({ connectionString: url.href, max: 1 });
        database = 'nc_service_chat_' + randomUUID().replaceAll('-', ''); await admin.query('CREATE DATABASE ' + database);
        url.pathname = '/' + database; pool = new Pool({ connectionString: url.href, max: 5 });
        await migrateCatalog(pool, CATALOG_MIGRATIONS);
        await pool.query('INSERT INTO projects(id,name) VALUES($1,$1)', [project]);
        for (const email of [owner, other]) {
            await pool.query('INSERT INTO platform_users(email) VALUES($1)', [email]);
            await pool.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,$2,'Админ проекта')", [project, email]);
        }
        await pool.query("INSERT INTO model_catalog(id,name,descriptor) VALUES('model-service-chat','Fixture only',$1::jsonb)", [JSON.stringify({ runtime: 'ollama', capability: 'chat', model: 'fixture:model', source: 'custom', manifestSha256: 'a'.repeat(64) })]);
        await pool.query('INSERT INTO project_models(project_id,model_id,added_by) VALUES($1,$2,$3)', [project, 'model-service-chat', owner]);
    });
    beforeEach(async () => {
        flags.enabled = true; infer.mockClear();
        const actor = async (request: Request) => {
            const identity = request as unknown as { email: string; activeRole: string };
            const account = (await pool.query('SELECT enabled FROM platform_users WHERE email=$1', [identity.email])).rows[0];
            if (!account?.enabled) throw new ForbiddenException();
            const grants = (await pool.query('SELECT project_id,role FROM project_members WHERE principal_name=$1', [identity.email])).rows;
            if (!grants.some(row => row.role === identity.activeRole)) throw new ForbiddenException();
            return { ...identity, claims: { email: identity.email, userRoles: [identity.activeRole], projects: grants.map(row => ({ projectId: row.project_id, role: row.role })) } };
        };
        const model = modelFromRow((await pool.query('SELECT * FROM model_catalog WHERE id=$1', ['model-service-chat'])).rows[0]); modelPin = projectEmbeddingPin(model);
        const models = { pool, ready: async () => undefined, actor, getUsable: async () => model, resolveProject: async (request, id, minimum, existing) => {
            const current = existing ?? await actor(request), grant = current.claims.projects.find(row => row.projectId === id);
            const level = grant?.role === 'Админ проекта' ? 3 : grant?.role === 'Наблюдатель' ? 1 : 0;
            if (level < minimum) throw new ForbiddenException(); return { id };
        } };
        roles = new SystemRoleService(models as never, {} as never, {} as never, {} as never, { infer } as never, {} as never);
        vi.spyOn(roles.repository, 'claim').mockResolvedValue(null); // Admission/receipt fixture, never live runtime.
        vi.spyOn(roles.targets, 'prepare').mockImplementation(async (_request, id, value) => ({ selection: value, definitionPin: roleDefinitionPin(id), consentDigest: 'c'.repeat(64), preview: 'Fixture preview', targets: [] }));
        chat = new SystemRoleChatService(models as never, roles);
    });
    afterEach(async () => {
        if (!pool) return; await roles?.onApplicationShutdown();
        await pool.query('DELETE FROM system_role_dialogs'); await pool.query('DELETE FROM system_role_runs'); await pool.query("DELETE FROM operations WHERE resource_type='system-role'");
        await pool.query("UPDATE project_members SET role='Админ проекта' WHERE project_id=$1", [project]);
        await pool.query('UPDATE platform_users SET enabled=true');
    });
    afterAll(async () => {
        if (pool) await pool.end();
        if (admin) { try { if (database) await admin.query('DROP DATABASE IF EXISTS ' + database); } finally { await admin.end(); } }
    });
    it('commits one intent/run/operation for concurrent sends; lost ACK recovery is readonly', async () => {
        const dialog = await create(), body = sendBody();
        const [a, b] = await Promise.all([chat.send(req(), dialog.id, body), chat.send(req(), dialog.id, body)]);
        expect(a.run.id).toBe(b.run.id); expect(await counts()).toEqual({ turns: 1, runs: 1, calls: 0 });
        await expect(roles.detail(req(other), 'agent-coordinator', a.run.id)).rejects.toHaveProperty('status', 404);
        expect((await pool.query("SELECT resource_id FROM operations WHERE resource_type='system-role'")).rows).toEqual([{ resource_id: a.run.id }]);
        flags.enabled = false;
        expect((await chat.request(req(), dialog.id, body.input.requestId)).run.id).toBe(a.run.id);
        expect((await chat.send(req(), dialog.id, body)).run.id).toBe(a.run.id);
        expect(await counts()).toEqual({ turns: 1, runs: 1, calls: 0 });
        await expect(chat.send(req(), dialog.id, { ...body, input: { ...body.input, instruction: 'changed' } })).rejects.toHaveProperty('status', 409);
    });
    it('rolls back the intent if role admission fails; retrying uses the same key without an orphan', async () => {
        const dialog = await create(), body = sendBody(), admission = vi.spyOn(roles.policy, 'modelInTransaction').mockRejectedValueOnce(new ForbiddenException('revoked model'));
        await expect(chat.send(req(), dialog.id, body)).rejects.toHaveProperty('status', 403);
        expect(await counts()).toEqual({ turns: 0, runs: 0, calls: 0 });
        admission.mockRestore(); expect((await chat.send(req(), dialog.id, body)).id).toBe(body.input.requestId);
        expect(await counts()).toEqual({ turns: 1, runs: 1, calls: 0 });
    });
    it('private owner/scope and fresh rights reject outsider, project switch and revoked account', async () => {
        const dialog = await create(), body = sendBody();
        await expect(chat.detail(req(other), dialog.id)).rejects.toHaveProperty('status', 404);
        await expect(chat.send(req(), dialog.id, { ...body, input: { ...body.input, projectId: 'prj-other' } })).rejects.toHaveProperty('status', 409);
        await pool.query('UPDATE platform_users SET enabled=false WHERE email=$1', [owner]);
        await expect(chat.send(req(), dialog.id, body)).rejects.toHaveProperty('status', 403);
        expect(await counts()).toEqual({ turns: 0, runs: 0, calls: 0 });
    });
    it('rechecks actual project model assignment and changed catalog pin inside atomic admission', async () => {
        const dialog = await create(), body = sendBody(), before = (await pool.query('SELECT descriptor,revision FROM model_catalog WHERE id=$1', [body.input.modelId])).rows[0];
        await pool.query('DELETE FROM project_models WHERE project_id=$1 AND model_id=$2', [project, body.input.modelId]);
        try {
            await expect(chat.send(req(), dialog.id, body)).rejects.toHaveProperty('status', 403);
            expect(await counts()).toEqual({ turns: 0, runs: 0, calls: 0 });
        } finally { await pool.query('INSERT INTO project_models(project_id,model_id,added_by) VALUES($1,$2,$3)', [project, body.input.modelId, owner]); }
        await pool.query("UPDATE model_catalog SET descriptor=jsonb_set(descriptor,'{model}','\"fixture:changed\"'),revision=revision+1 WHERE id=$1", [body.input.modelId]);
        try {
            await expect(chat.send(req(), dialog.id, body)).rejects.toHaveProperty('status', 409);
            expect(await counts()).toEqual({ turns: 0, runs: 0, calls: 0 });
        } finally { await pool.query('UPDATE model_catalog SET descriptor=$2::jsonb,revision=$3 WHERE id=$1', [body.input.modelId, JSON.stringify(before.descriptor), before.revision]); }
    });
    it('feature OFF preserves history and demoted owner cancellation while blocking new work', async () => {
        const dialog = await create(), body = sendBody(), turn = await chat.send(req(), dialog.id, body);
        flags.enabled = false; await pool.query("UPDATE project_members SET role='Наблюдатель' WHERE project_id=$1 AND principal_name=$2", [project, owner]);
        const viewer = req(owner, 'Наблюдатель');
        expect((await chat.detail(viewer, dialog.id)).turns[0].id).toBe(turn.id);
        expect((await chat.cancel(viewer, dialog.id, turn.id, { requestId: randomUUID(), expectedRevision: turn.run.revision })).run.state).toBe('cancelled');
        expect((await pool.query('SELECT cancel_requested FROM system_role_dialog_intents WHERE id=$1', [turn.id])).rows[0].cancel_requested).toBe(true);
        await expect(chat.send(viewer, dialog.id, sendBody())).rejects.toHaveProperty('status', 403);
        expect(await counts()).toEqual({ turns: 1, runs: 1, calls: 0 });
    });
    it('reopens completed answers and previews only explicitly chosen own-dialog context', async () => {
        const dialog = await create(), body = sendBody(), turn = await chat.send(req(), dialog.id, body);
        // Complete via the real journal transition; this is not a real model success claim.
        await pool.query("UPDATE system_role_runs SET state='running',phase='collecting',revision=revision+1 WHERE id=$1", [turn.run.id]);
        const running = (await roles.repository.get(turn.run.id))!;
        await roles.repository.fenced(running.id, running.lease_token, (db, current) => roles.repository.change(db, current, 'succeeded', 'completed', 'Fixture answer', { result: { kind: 'diagnosis', summary: 'Only this own answer', findings: [], nextSteps: [], changes: [] } }));
        expect((await chat.detail(req(), dialog.id)).turns[0].run.result?.summary).toBe('Only this own answer');
        const prepared = await chat.prepare(req(), dialog.id, { agentId: 'agent-coordinator', selection, includeContext: true });
        expect(prepared.selection.targets).toEqual([{ kind: 'dialog-context', id: expect.any(String) }]);
        const context = (await pool.query('SELECT * FROM system_role_dialog_contexts')).rows[0];
        expect(context.refs).toEqual([{ id: turn.id, revision: running.revision + 1 }]);
        const otherDialog = await create();
        await expect(chat.send(req(), otherDialog.id, { ...sendBody(), input: { ...sendBody().input, targets: prepared.selection.targets } })).rejects.toHaveProperty('status', 409);
        expect(infer).not.toHaveBeenCalled();
    });
    it('physical receipt guard rejects orphan acceptance, identity edits and structural drift', async () => {
        const dialog = await create(), body = sendBody(), turn = await chat.send(req(), dialog.id, body);
        await expect(pool.query("UPDATE system_role_dialog_intents SET request_hash=$2 WHERE id=$1", [turn.id, 'd'.repeat(64)])).rejects.toThrow('immutable');
        const id = randomUUID();
        await expect(pool.query("INSERT INTO system_role_dialog_intents(id,dialog_id,owner_email,request_id,agent_id,request_hash,input) VALUES($1,$2,$3,$1,'agent-coordinator',$4,'{}')", [id, dialog.id, owner, 'a'.repeat(64)])).rejects.toThrow('accepted role run');
        expect((await pool.query(CATALOG_SCHEMA_FACTS_SQL)).rowCount).toBeGreaterThan(0);
        await assertSystemRoleChatSchema(pool);
        const db = await pool.connect(); await db.query('BEGIN');
        try { await db.query('ALTER TABLE system_role_dialog_intents DISABLE TRIGGER system_role_dialog_receipt_guard'); await expect(assertSystemRoleChatSchema(db as never)).rejects.toThrow('не готова'); }
        finally { await db.query('ROLLBACK'); db.release(); }
    });
    it('upgrades released34 and rolls back failed35 without changing historical SQL receipts', async () => {
        const name = 'nc_service_chat_upgrade_' + randomUUID().replaceAll('-', ''), url = ownedTestPostgresAdmin(connection); let upgrade: Pool | undefined;
        await admin.query('CREATE DATABASE ' + name);
        try {
            url.pathname = '/' + name; upgrade = new Pool({ connectionString: url.href, max: 1 });
            await migrateCatalog(upgrade, CATALOG_MIGRATIONS.filter(item => item.version < 35));
            const before = (await upgrade.query('SELECT * FROM catalog_schema_migrations ORDER BY version')).rows;
            const broken = CATALOG_MIGRATIONS.map(item => item.version === 35 ? { ...item, sql: item.sql + '; SELECT deliberately_missing_chat35_function()' } : item);
            await expect(migrateCatalog(upgrade, broken)).rejects.toThrow();
            expect((await upgrade.query('SELECT * FROM catalog_schema_migrations ORDER BY version')).rows).toEqual(before);
            expect((await upgrade.query("SELECT to_regclass('system_role_dialogs') AS dialogs")).rows[0].dialogs).toBeNull();
            await migrateCatalog(upgrade, CATALOG_MIGRATIONS);
            expect((await upgrade.query('SELECT * FROM catalog_schema_migrations WHERE version<35 ORDER BY version')).rows).toEqual(before);
            await assertSystemRoleChatSchema(upgrade);
        } finally { await upgrade?.end(); await admin.query('DROP DATABASE ' + name); }
    });
});
