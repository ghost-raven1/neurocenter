import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { projectChatLearningFixture, adminUrl, mainReq, projectId, req, developer } from './project-chat-learning-receipt.fixture';
import { saveModelVersion, type IModelRow } from '../src/models/model-history';
import { projectEmbeddingPin } from '../src/models/project-embedding.validation';
import type { ChatAgentSnapshot } from '../src/model-chat/chat-group.types';
import type { IModel } from '../src/models/model.types';

export { adminUrl, mainReq, projectId, req, developer };
export type AdmissionLane = 'server' | 'device-codex';
export interface SeedAnswer { lane: AdmissionLane; status?: 'queued' | 'done' | 'failed'; secondServer?: boolean; unknownPin?: boolean }

/** Real admission/ACL/model snapshots and SQL; accepted queues are seeded without executing model work. */
export async function projectChatAdmissionFixture() {
    const f = await projectChatLearningFixture();
    let cards: { server: string; secondServer: string; 'device-codex': string };
    let snapshots: Record<string, ChatAgentSnapshot>;
    const otherAuthors = Array.from({ length: 6 }, (_, index) => `queue-${index}@fixture.test`);
    const setup = async () => {
        await f.setup();
        const base = await f.models.getUsable();
        const device: IModel = { ...base, id: 'model-admission-device', name: 'Admission device', runtime: 'device-codex', model: 'codex-admission-fixture', manifestSha256: null, verificationSha256: 'b'.repeat(64), modelVersion: 'fixture-v1' };
        await f.pool.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$2,$3)', [device.id, device.name, device]);
        await f.pool.query('INSERT INTO project_models(project_id,model_id,added_by) VALUES($1,$2,$3)', [projectId, device.id, developer.email]);
        for (const row of (await f.pool.query<IModelRow>('SELECT * FROM model_catalog')).rows) await saveModelVersion(f.pool, row);
        const server = await f.agent('Admission server'), secondServer = await f.agent('Admission second server'), codex = await f.agent('Admission Codex');
        cards = { server: server.id, secondServer: secondServer.id, 'device-codex': codex.id };
        await f.pool.query('UPDATE project_agents SET overrides=$3 WHERE project_id=$1 AND agent_id=$2', [projectId, codex.id, { model: 'neurocenter/' + device.id }]);
        await f.configure([server.id, secondServer.id, codex.id]);
        const room = await f.service.repository.room(f.pool, projectId);
        snapshots = Object.fromEntries((await f.inference.resolve(req(), projectId, room, room.agent_ids, f.pool)).map(snapshot => [snapshot.agentId, snapshot]));
        await f.pool.query('INSERT INTO platform_users(email) SELECT unnest($1::text[])', [otherAuthors]);
        await f.pool.query("INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) SELECT $1,email,email,email,'Разработчик' FROM unnest($2::text[]) email", [projectId, otherAuthors]);
        vi.spyOn(f.service.runner, 'schedule').mockImplementation(() => undefined);
    };
    const ids = (lanes: AdmissionLane[]) => lanes.map(lane => cards[lane]);
    const send = (lanes: AdmissionLane[], requestKey = randomUUID(), prompt = 'Admission question') => f.service.send(req(), projectId, { requestKey, prompt, targetAgentIds: ids(lanes) });
    const room = async () => {
        const created = await f.service.createRoom(mainReq(), projectId, { requestKey: randomUUID(), title: 'Admission room', visibility: 'PUBLIC', memberEmails: [] });
        const detail = await f.service.read(mainReq(), projectId, undefined, created.id), model = await f.models.getUsable();
        await f.service.participants(mainReq(), projectId, { expectedRevision: detail.room.revision, modelId: model.id, expectedModelPin: projectEmbeddingPin(model), agentIds: Object.values(cards) }, created.id);
        return created;
    };
    const seed = async (count: number, answers: SeedAnswer[], options: { authors?: 'own' | 'others'; roomId?: string } = {}) => {
        const roomId = options.roomId ?? (await f.service.repository.room(f.pool, projectId)).id!;
        const sources = Array.from({ length: count }, (_, index) => ({ id: randomUUID(), generation: randomUUID(), requestKey: randomUUID(), email: options.authors === 'others' ? otherAuthors[index % otherAuthors.length] : developer.email }));
        const plans = answers.map(answer => {
            const agentId = answer.secondServer ? cards.secondServer : cards[answer.lane], snapshot = structuredClone(snapshots[agentId]);
            if (answer.unknownPin) snapshot.modelPin = 'e'.repeat(64);
            return { snapshot, status: answer.status ?? 'queued', content: answer.status === 'done' ? 'PAID SEEDED ANSWER' : '' };
        });
        await f.pool.query(`WITH accepted AS (
            INSERT INTO project_chat_messages(id,project_id,room_id,kind,content,author_email,author_name,author_role,status,request_key,request_hash,target_agent_ids,generation)
            SELECT id::uuid,$1,$2,'user','Seeded accepted question',email,email,'Разработчик','queued',"requestKey"::uuid,$5,$6,generation::uuid
            FROM jsonb_to_recordset($3::jsonb) AS source(id text,generation text,"requestKey" text,email text) RETURNING id,generation
        ) INSERT INTO project_chat_messages(id,project_id,room_id,kind,content,source_message_id,status,snapshot,generation)
            SELECT gen_random_uuid(),$1,$2,'agent',answer.content,accepted.id,answer.status,answer.snapshot,accepted.generation
            FROM accepted CROSS JOIN jsonb_to_recordset($4::jsonb) AS answer(snapshot jsonb,status text,content text)`,
        [projectId, roomId, JSON.stringify(sources), JSON.stringify(plans), 'a'.repeat(64), plans.map(plan => plan.snapshot.agentId)]);
        return sources.map(source => source.id);
    };
    const count = async () => Number((await f.pool.query("SELECT count(*) AS total FROM project_chat_messages WHERE project_id=$1 AND kind='user' AND status IN ('queued','running')", [projectId])).rows[0].total);
    return { ...f, setup, send, seed, count, room, ids,
        get cards() { return cards; }, get snapshots() { return snapshots; },
        get service() { return f.service; }, get inference() { return f.inference; },
    };
}
