import {afterAll, beforeAll, beforeEach, describe, expect, it, vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {ForbiddenException} from '@nestjs/common';
import type {Request} from 'express';
import {ensureCatalogSchema, checkCatalogSchema} from '../src/database/catalog-schema';
import {ChatPresenceService} from '../src/chat-activity/chat-presence.service';
import {ProjectChatService} from '../src/project-chat/project-chat.service';
import {DEFAULT_PROJECT_CHAT_ROOM} from '../src/project-chat/project-chat.types';
import type {ModelsService} from '../src/models/models.service';
import type {ProjectChatInferenceService} from '../src/project-chat-inference/project-chat-inference.service';
import {ownedDeviceTestAdminUrl} from './device-completion-postgres.fixture';
import {assertChatActivitySchema} from '../src/chat-activity/chat-activity.schema-verification';

const flags = vi.hoisted(() => ({on: true}));
vi.mock('../src/features/require-feature-enabled', () => ({requireFeaturesEnabled: vi.fn(async () => {if (!flags.on) throw new ForbiddenException('Feature disabled');})}));
const adminUrl = process.env.CHAT_ACTIVITY_TEST_ADMIN_URL;
const a = 'a@chat-activity.test', b = 'b@chat-activity.test', reader = 'reader@chat-activity.test', main = 'main@chat-activity.test';
describe.skipIf(!adminUrl).sequential('Chat activity — explicitly owned PostgreSQL', () => {
    let admin: Pool, pool: Pool, project: string, chats: ProjectChatService, presence: ChatPresenceService;
    const database = 'nc_chat_activity_' + randomUUID().replaceAll('-', ''), token = randomUUID();
    const req = (email = a, activeRole = email === reader ? 'Наблюдатель' : email === main ? 'Главный админ' : 'Разработчик') => ({headers: {'x-neurocenter-internal': token, 'x-bridge-actor': encodeURIComponent(JSON.stringify({email, activeRole}))}} as Request);
    const heartbeat = (email: string, sessionId: string, sequence = 1, online = true) => presence.update(req(email), {sessionId, sequence, online});
    const update = (email: string, sessionId: string, sequence = 1, patch = {}, roomId = DEFAULT_PROJECT_CHAT_ROOM) => chats.updateActivity(req(email), project, {sessionId, sequence, online: true, ...patch}, roomId);
    const send = async (email = a, roomId = DEFAULT_PROJECT_CHAT_ROOM) => (await chats.send(req(email), project, {requestKey: randomUUID(), prompt: 'Visible human ' + randomUUID(), targetAgentIds: []}, roomId)).message.id;
    const read = (email = a, ids: string[] = [], roomId = DEFAULT_PROJECT_CHAT_ROOM) => chats.readActivity(req(email), project, ids.length ? ids.join(',') : undefined, roomId);
    const person = async (email: string, roomId = DEFAULT_PROJECT_CHAT_ROOM) => (await read(a, [], roomId)).members.find(row => row.email === email);
    beforeAll(async () => {
        const url = ownedDeviceTestAdminUrl(adminUrl!); admin = new Pool({connectionString: url.href, max: 1});
        await admin.query('CREATE DATABASE ' + database); url.pathname = '/' + database; pool = new Pool({connectionString: url.href, max: 4, statement_timeout: 5000});
        await ensureCatalogSchema(pool); vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN', token);
        for (const email of [a, b, reader, main]) await pool.query('INSERT INTO platform_users(email,display_name,is_main_admin) VALUES($1,$1,$2)', [email, email === main]);
    });
    beforeEach(async () => {
        flags.on = true; project = 'prj-chat-activity-' + randomUUID();
        await pool.query('INSERT INTO projects(id,name) VALUES($1,$1)', [project]);
        await pool.query('DELETE FROM chat_presence_sessions; DELETE FROM project_chat_typing_sessions');
        for (const email of [a, b, reader]) await pool.query('INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,$2,$3)', [project, email, email === reader ? 'Наблюдатель' : 'Разработчик']);
        const actor = async (request: Request) => {
            const input = JSON.parse(decodeURIComponent(String(request.headers['x-bridge-actor'])));
            const grants = (await pool.query('SELECT project_id,role FROM project_members WHERE principal_name=$1', [input.email])).rows;
            return {...input, claims: {email: input.email, userRoles: [...new Set(grants.map(row => row.role)), ...(input.email === main ? ['Главный админ'] : [])], projects: grants.map(row => ({projectId: row.project_id, projectName: row.project_id, role: row.role})), pluginIds: [], skillPaths: []}};
        };
        const models = {pool, actor} as unknown as ModelsService;
        chats = new ProjectChatService(models, {roster: async () => []} as unknown as ProjectChatInferenceService); presence = new ChatPresenceService(models);
    });
    afterAll(async () => {await pool?.end(); if (admin) {await admin.query('DROP DATABASE ' + database); await admin.end();} vi.unstubAllEnvs();});

    it('appends migration26 and detects a missing receipt foreign key', async () => {
        expect((await checkCatalogSchema(pool, true)).applied.at(-1)).toBe(26);
        const db = await pool.connect(); try {
            await db.query('BEGIN');
            const constraint = (await db.query("SELECT conname FROM pg_constraint WHERE conrelid='project_chat_read_receipts'::regclass AND contype='f'")).rows[0].conname;
            await db.query('ALTER TABLE project_chat_read_receipts DROP CONSTRAINT ' + constraint);
            await expect(assertChatActivitySchema(db)).rejects.toThrow('не готова');
        } finally {await db.query('ROLLBACK'); db.release();}
        await assertChatActivitySchema(pool);
    });
    it('fetching history acknowledges nothing and an explicit tail view never marks skipped earlier messages', async () => {
        const older = await send(), tail = await send(), session = randomUUID();
        await chats.read(req(b), project); expect((await read(a, [older, tail])).receipts.every(row => row.readerEmails.length === 0)).toBe(true);
        await update(b, session, 1, {visibleMessageIds: [tail]});
        const snapshot = await read(a, [older, tail]);
        expect(snapshot.viewerEmail).toBe(a); expect(snapshot.receipts.find(row => row.messageId === older)?.readerEmails).toEqual([]);
        expect(snapshot.receipts.find(row => row.messageId === tail)?.readerEmails).toEqual([b]);
        await update(b, session, 2, {visibleMessageIds: [tail]});
        expect(Number((await pool.query('SELECT count(*) FROM project_chat_read_receipts WHERE message_id=$1', [tail])).rows[0].count)).toBe(1);
        await update(a, randomUUID(), 1, {visibleMessageIds: [tail]});
        expect((await read(a, [tail])).receipts[0].readerEmails).toEqual([b]);
    });
    it('read receipts remain durable when another service instance answers and the feature is off', async () => {
        const id = await send(), session = randomUUID(); await update(b, session, 1, {visibleMessageIds: [id]}); flags.on = false;
        expect((await read(a, [id])).receipts[0].readerEmails).toEqual([b]);
        await expect(update(b, session, 2, {visibleMessageIds: [id]})).rejects.toHaveProperty('status', 403);
        expect((await new ProjectChatService({pool, actor: async () => ({email: a, activeRole: 'Разработчик', claims: {email: a, userRoles: ['Разработчик'], projects: [{projectId: project, projectName: project, role: 'Разработчик'}], pluginIds: [], skillPaths: []}})} as unknown as ModelsService, {} as ProjectChatInferenceService).readActivity(req(), project, id)).receipts[0].readerEmails).toEqual([b]);
    });
    it('presence aggregates independent app tabs and never depends on a room heartbeat', async () => {
        const one = randomUUID(), two = randomUUID();
        await heartbeat(b, one); await heartbeat(b, two); expect(await person(b)).toMatchObject({online: true, typing: false});
        await heartbeat(b, one, 2, false); expect(await person(b)).toMatchObject({online: true});
        await pool.query('UPDATE chat_presence_sessions SET online_until=now()-interval \'1 second\' WHERE email=$1 AND session_id=$2', [b, two]);
        expect(await person(b)).toMatchObject({online: false});
        await update(b, randomUUID(), 1, {typing: true}); expect(await person(b)).toMatchObject({online: false, typing: false});
    });
    it('typing expires, clears only its tab, and is shown only in its current room', async () => {
        const room = await chats.createRoom(req(), project, {requestKey: randomUUID(), title: 'Other', visibility: 'PUBLIC', memberEmails: []});
        const one = randomUUID(), two = randomUUID(); await heartbeat(b, one); await heartbeat(b, two);
        await update(b, one, 2, {typing: true}); await update(b, two, 2, {typing: true});
        await update(b, one, 3, {online: false}); expect(await person(b)).toMatchObject({typing: true});
        await update(b, two, 3, {typing: true}, room.id); expect(await person(b)).toMatchObject({typing: false});
        expect(await person(b, room.id)).toMatchObject({typing: true, online: true});
        await pool.query('UPDATE project_chat_typing_sessions SET typing_until=now()-interval \'1 second\' WHERE email=$1 AND typing_until IS NOT NULL', [b]);
        expect(await person(b, room.id)).toMatchObject({typing: false, online: true});
    });
    it('late heartbeat and old-room updates cannot resurrect a cleared tab or replace its new scope', async () => {
        const session = randomUUID(), room = await chats.createRoom(req(), project, {requestKey: randomUUID(), title: 'Next', visibility: 'PUBLIC', memberEmails: []});
        await heartbeat(b, session, 1); await update(b, session, 2, {typing: true});
        await update(b, session, 4, {typing: true}, room.id); await update(b, session, 3, {typing: true});
        expect(await person(b)).toMatchObject({typing: false}); expect(await person(b, room.id)).toMatchObject({typing: true});
        await heartbeat(b, session, 6, false); await heartbeat(b, session, 5, true); await update(b, session, 5, {typing: true});
        expect(await person(b)).toMatchObject({online: false, typing: false});
        expect((await pool.query('SELECT sequence FROM project_chat_typing_sessions WHERE email=$1 AND session_id=$2', [b, session])).rows[0].sequence).toBe('6');
    });
    it('OFF retains receipts and permits own-tab cleanup without affecting a second tab', async () => {
        const one = randomUUID(), two = randomUUID(); await heartbeat(b, one); await heartbeat(b, two); await update(b, one, 2, {typing: true});
        flags.on = false; await update(b, one, 3, {online: false}); await heartbeat(b, one, 4, false);
        expect(await person(b)).toMatchObject({online: true, typing: false});
        await expect(heartbeat(b, one, 5)).rejects.toHaveProperty('status', 403);
    });
    it('observers and archived projects acknowledge visible human messages but cannot type', async () => {
        const id = await send(), session = randomUUID(); await update(reader, session, 1, {visibleMessageIds: [id]});
        await expect(update(reader, session, 2, {typing: true})).rejects.toHaveProperty('status', 403);
        await pool.query("UPDATE projects SET state='ARCHIVED' WHERE id=$1", [project]);
        await update(b, randomUUID(), 1, {visibleMessageIds: [id]});
        await expect(update(b, session, 3, {typing: true})).rejects.toHaveProperty('status', 403);
        expect((await read(a, [id])).receipts[0].readerEmails.sort()).toEqual([b, reader].sort());
    });
    it('private activity cannot be read or written by an uninvited main admin, and foreign IDs never create receipts', async () => {
        const room = await chats.createRoom(req(), project, {requestKey: randomUUID(), title: 'Private', visibility: 'PRIVATE', memberEmails: [b]});
        const id = await send(a, room.id), publicId = await send();
        await expect(read(main, [id], room.id)).rejects.toHaveProperty('status', 404);
        await expect(update(main, randomUUID(), 1, {typing: true}, room.id)).rejects.toHaveProperty('status', 404);
        await expect(update(b, randomUUID(), 1, {visibleMessageIds: [id]}, DEFAULT_PROJECT_CHAT_ROOM)).rejects.toHaveProperty('status', 404);
        await expect(update(b, randomUUID(), 1, {visibleMessageIds: [publicId]}, room.id)).rejects.toHaveProperty('status', 404);
        expect((await read(a, [id])).receipts).toEqual([]);
        await update(b, randomUUID(), 1, {visibleMessageIds: [id]}, room.id);
        const current = await chats.read(req(), project, undefined, room.id);
        await chats.updateRoom(req(), project, room.id, {expectedRevision: current.room.revision, title: room.title, memberEmails: []});
        expect((await read(a, [id], room.id)).receipts[0].readerEmails).toEqual([]);
        await expect(read(b, [id], room.id)).rejects.toHaveProperty('status', 404);
    });
    it('main admins legitimately reading a public room remain visible readers without a project_members row', async () => {
        const id = await send(); await update(main, randomUUID(), 1, {visibleMessageIds: [id]});
        expect((await read(a, [id])).receipts[0].readerEmails).toEqual([main]);
    });
    it('disabled accounts disappear from snapshots and cannot renew even with an old gateway identity', async () => {
        const id = await send(), session = randomUUID(); await heartbeat(b, session); await update(b, session, 2, {typing: true, visibleMessageIds: [id]});
        await pool.query('UPDATE platform_users SET enabled=false WHERE email=$1', [b]);
        try {
            expect((await read(a, [id])).members.some(row => row.email === b)).toBe(false);
            expect((await read(a, [id])).receipts[0].readerEmails).toEqual([]);
            await expect(heartbeat(b, session, 3)).rejects.toHaveProperty('status', 403);
            await expect(update(b, session, 3, {typing: true})).rejects.toHaveProperty('status', 403);
        } finally {await pool.query('UPDATE platform_users SET enabled=true WHERE email=$1', [b]);}
    });
    it('device callers cannot publish human presence', async () => {
        await expect(presence.update({headers: {...req().headers, 'x-neurocenter-device-id': randomUUID()}} as Request, {sessionId: randomUUID(), sequence: 1, online: true})).rejects.toHaveProperty('status', 403);
    });
});
