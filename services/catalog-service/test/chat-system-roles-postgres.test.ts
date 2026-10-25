import {ForbiddenException} from '@nestjs/common';
import type {Request} from 'express';
import {randomUUID} from 'node:crypto';
import {statfs} from 'node:fs/promises';
import {Pool} from 'pg';
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {ownedTestPostgresAdmin} from '../../../scripts/test/owned-postgres.fixture.mjs';
import {CATALOG_MIGRATIONS} from '../src/database/catalog-migrations';
import {migrateCatalog} from '../src/database/migrations';
import {assertCurrentCatalogSchema} from '../src/database/current-schema-verification';
import {ProjectChatPolicy} from '../src/project-chat/project-chat.policy';
import {DEFAULT_PROJECT_CHAT_ROOM} from '../src/project-chat/project-chat.types';
import {SystemRolePolicy} from '../src/system-roles/system-role.policy';
import {SystemRoleRepository} from '../src/system-roles/system-role.repository';
import {ChatSystemRolesService} from '../src/chat-system-roles/chat-system-roles.service';
import {assertChatSystemRoleOrigin} from '../src/chat-system-roles/chat-system-roles.origin-policy';
const flags = vi.hoisted(() => ({enabled: true}));
vi.mock('../src/features/require-feature-enabled', () => ({requireFeaturesEnabled: async () => {if (!flags.enabled) throw new ForbiddenException('Feature OFF');}}));
const connection = process.env.CHAT_SYSTEM_ROLES_TEST_ADMIN_URL, owner = 'owner@bound-chat.test', other = 'other@bound-chat.test';
const req = (email = owner, activeRole = 'Админ проекта') => ({headers: {}, email, activeRole}) as unknown as Request;

describe.skipIf(!connection).sequential('Immutable chat origin bindings on explicitly owned PostgreSQL16', () => {
    let admin: Pool, pool: Pool, database: string, service: ChatSystemRolesService, project: string;
    const projects: string[] = [];
    const newProject = async () => {
        const id = 'prj-bound-' + randomUUID(); await pool.query('INSERT INTO projects(id,name) VALUES($1,$1)', [id]); projects.push(id);
        for (const email of [owner, other]) await pool.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,$2,'Админ проекта')", [id, email]);
        return id;
    };
    const conversation = async (email = owner, scope: string | null = project, mode = 'model') => {
        const id = randomUUID(); await pool.query('INSERT INTO model_chat_conversations(id,owner_email,model_id,project_id,model_pin,title,mode) VALUES($1,$2,$3,$4,$5,$6,$7)', [id, email, 'model-origin-fixture', scope, 'a'.repeat(64), 'Original private chat', mode]);
        return {kind: 'model-chat' as const, originId: id, projectId: scope};
    };
    beforeAll(async () => {
        const disk = await statfs(process.cwd()); if (disk.bavail * disk.bsize < 4 * 1024 ** 3) throw Error('Owned PostgreSQL acceptance requires4GiB free.');
        const url = ownedTestPostgresAdmin(connection); admin = new Pool({connectionString: url.href, max: 1});
        database = 'nc_chat_origins_' + randomUUID().replaceAll('-', ''); await admin.query('CREATE DATABASE ' + database);
        url.pathname = '/' + database; pool = new Pool({connectionString: url.href, max: 8, statement_timeout: 15000});
        await migrateCatalog(pool, CATALOG_MIGRATIONS); await assertCurrentCatalogSchema(pool);
        expect((await pool.query('SELECT version FROM catalog_schema_migrations ORDER BY version')).rows.map(row => row.version)).toEqual(Array.from({length: 41}, (_, index) => index));
        for (const email of [owner, other]) await pool.query('INSERT INTO platform_users(email,is_main_admin) VALUES($1,true)', [email]);
        await pool.query("INSERT INTO model_catalog(id,name,descriptor) VALUES('model-origin-fixture','Fixture only',$1::jsonb)", [JSON.stringify({runtime: 'ollama', capability: 'chat', model: 'fixture', manifestSha256: 'a'.repeat(64)})]);
        const actor = async (request: Request) => {
            const input = request as unknown as {email: string; activeRole: string};
            const account = (await pool.query('SELECT enabled,is_main_admin FROM platform_users WHERE email=$1', [input.email])).rows[0];
            const grants = (await pool.query('SELECT project_id,role FROM project_members WHERE principal_name=$1', [input.email])).rows;
            const roles = [...new Set(grants.map(row => row.role)), ...(account?.is_main_admin ? ['Главный админ'] : [])];
            if (!account?.enabled || !roles.includes(input.activeRole)) throw new ForbiddenException('Current role revoked');
            return {email: input.email, activeRole: input.activeRole, claims: {email: input.email, userRoles: roles, projects: grants.map(row => ({projectId: row.project_id, role: row.role})), pluginIds: [], skillPaths: []}};
        };
        const projectPolicy = new ProjectChatPolicy();
        const models = {pool, ready: async () => undefined, actor, resolveProject: async (request, id, minimum, existing) => {
            await projectPolicy.authorize(pool, id, existing ?? await actor(request), minimum); return {id};
        }};
        service = new ChatSystemRolesService(models as never, {policy: new SystemRolePolicy(models as never), repository: new SystemRoleRepository(pool)} as never);
    });
    beforeEach(async () => {flags.enabled = true; project = await newProject();});
    afterEach(async () => {if (pool) {await pool.query('DELETE FROM projects WHERE id=ANY($1::text[])', [projects.splice(0)]); await pool.query('DELETE FROM system_role_dialogs'); await pool.query('DELETE FROM model_chat_conversations');}});
    afterAll(async () => {await pool?.end(); if (admin) {try {if (database) await admin.query('DROP DATABASE ' + database);} finally {await admin.end();}}});

    it('serializes concurrent binds into one private dialog and one immutable origin row', async () => {
        const source = await conversation(); const [left, right] = await Promise.all([service.bind(req(), source), service.bind(req(), source)]);
        expect(left.id).toBe(right.id); expect((await pool.query('SELECT count(*) FROM chat_system_role_origins')).rows[0].count).toBe('1');
        expect((await pool.query('SELECT count(*) FROM system_role_dialogs')).rows[0].count).toBe('1');
        expect((await pool.query('SELECT count(*) FROM model_chat_turns')).rows[0].count).toBe('0');
        expect((await pool.query('SELECT count(*) FROM project_chat_messages')).rows[0].count).toBe('0');
    });
    it('enforces NULLS NOT DISTINCT uniqueness for a global private conversation', async () => {
        const source = await conversation(owner, null); const accepted = await service.bind(req(owner, 'Главный админ'), source);
        const id = randomUUID(); await pool.query("INSERT INTO system_role_dialogs(id,owner_email,title) VALUES($1,$2,'Duplicate fixture')", [id, owner]);
        await expect(pool.query("INSERT INTO chat_system_role_origins(dialog_id,owner_email,origin_kind,origin_id) VALUES($1,$2,'model-chat',$3)", [id, owner, source.originId])).rejects.toMatchObject({code: '23505'});
        expect((await service.bind(req(owner, 'Главный админ'), source)).id).toBe(accepted.id);
    });
    it('rejects origin identity UPDATE even when both original chats belong to the same caller', async () => {
        const source = await conversation(), next = await conversation(), accepted = await service.bind(req(), source);
        await expect(pool.query('UPDATE chat_system_role_origins SET origin_id=$2 WHERE dialog_id=$1', [accepted.id, next.originId])).rejects.toThrow('immutable');
        expect((await pool.query('SELECT origin_id FROM chat_system_role_origins WHERE dialog_id=$1', [accepted.id])).rows[0].origin_id).toBe(source.originId);
    });
    it('does not bind another user’s conversation or accept a mismatched canonical project', async () => {
        const foreign = await conversation(other), privateSource = await conversation(), nextProject = await newProject();
        await expect(service.bind(req(), foreign)).rejects.toThrow('недоступен');
        await expect(service.bind(req(), {...privateSource, projectId: nextProject})).rejects.toThrow('другому проекту');
        expect((await pool.query('SELECT count(*) FROM system_role_dialogs')).rows[0].count).toBe('0');
    });
    it('uses project identity in the shared default-room origin key', async () => {
        const second = await newProject();
        const a = await service.bind(req(), {kind: 'project-chat', originId: DEFAULT_PROJECT_CHAT_ROOM, projectId: project});
        const b = await service.bind(req(), {kind: 'project-chat', originId: DEFAULT_PROJECT_CHAT_ROOM, projectId: second}); expect(a.id).not.toBe(b.id);
        expect((await pool.query('SELECT count(*) FROM project_chat_rooms')).rows[0].count).toBe('0');
    });
    it('requires explicit PRIVATE membership even for a main administrator', async () => {
        const room = randomUUID(); await pool.query("INSERT INTO project_chat_rooms(project_id,id,title,visibility,creator_email,create_request_key,create_request_hash) VALUES($1,$2,'Private','PRIVATE',$3,$4,$5)", [project, room, other, randomUUID(), 'a'.repeat(64)]);
        const source = {kind: 'project-chat', originId: room, projectId: project}; await expect(service.bind(req(owner, 'Главный админ'), source)).rejects.toThrow('не найден');
        await pool.query('INSERT INTO project_chat_room_members(project_id,room_id,email) VALUES($1,$2,$3)', [project, room, owner]);
        expect(await service.bind(req(owner, 'Главный админ'), source)).toMatchObject({projectId: project});
    });
    it('keeps private history and binding replay after feature OFF, demotion and original deletion; checkpoints fail', async () => {
        const source = await conversation(), accepted = await service.bind(req(), source); flags.enabled = false;
        await pool.query("UPDATE project_members SET role='Наблюдатель' WHERE project_id=$1 AND principal_name=$2", [project, owner]);
        await pool.query('DELETE FROM model_chat_conversations WHERE id=$1', [source.originId]);
        expect((await service.read(req(owner, 'Наблюдатель'), source))?.id).toBe(accepted.id);
        expect((await service.bind(req(owner, 'Наблюдатель'), source)).id).toBe(accepted.id);
        await expect(assertChatSystemRoleOrigin(pool, accepted.id, owner, project)).rejects.toThrow('недоступен');
    });
    it('does not leave an orphan dialog after source failure or a newly disabled flag', async () => {
        const missing = {kind: 'model-chat', originId: randomUUID(), projectId: project}; await expect(service.bind(req(), missing)).rejects.toThrow('недоступен');
        const source = await conversation(); flags.enabled = false; await expect(service.bind(req(), source)).rejects.toThrow('Feature OFF');
        expect((await pool.query('SELECT count(*) FROM system_role_dialogs')).rows[0].count).toBe('0');
    });
});
