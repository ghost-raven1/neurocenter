import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 9.3 (FR-309): an agent shares context elements (state/result/decision) with another
 * agent, a user (private dialogue) or the team (public room); every element carries
 * per-item provenance (agent + what + version + SHA, NFR-4); sharing is gated on the
 * agent's room access (fail-closed) and a private dialogue never leaks into a public
 * room (FR-403). Self-bootstrap: disposable PostgreSQL + in-process Catalog from dist
 * + scripted fake OpenAI provider.
 */

const DEFAULT_ROOM = '00000000-0000-0000-0000-000000000000';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

let skip = false,
    bootstrapError = '',
    f = null,
    container = null,
    port = 0,
    agentIds = [],
    modelCard = null,
    privateRoomId = null,
    privAnswerId = null,
    calls = [];

const waitForTcp = (host, p, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const attempt = () => {
            const socket = net.connect({ host, port: p });
            socket.once('connect', () => {
                socket.destroy();
                resolve(true);
            });
            socket.once('error', () => {
                socket.destroy();
                Date.now() > deadline ? reject(new Error('PG not ready: ' + host + ':' + p)) : setTimeout(attempt, 250);
            });
        };
        attempt();
    });

const shareBlock = (roomId, items) => '```neurocenter-share\n' + JSON.stringify({ roomId, items }) + '\n```';
const handoverBlock = (agentId) =>
    '```neurocenter-handover\n' + JSON.stringify({ agentId, note: 'Нужна экспертиза' }) + '\n```';

const bootstrap = async () => {
    port = 55532 + (process.pid % 200);
    container = 'nc-share-e2e-' + randomUUID().slice(0, 8);
    execFileSync(
        'docker',
        [
            'run',
            '-d',
            '--rm',
            '--name',
            container,
            '-e',
            'POSTGRES_PASSWORD=qa',
            '-p',
            '127.0.0.1:' + port + ':5432',
            'postgres:16',
        ],
        {
            timeout: 60000,
            stdio: 'pipe',
        },
    );
    await waitForTcp('127.0.0.1', port);
    // TCP-порт открывается в момент initdb; принимаем подключения только после «accepting connections».
    const deadline = Date.now() + 120000;
    for (;;) {
        try {
            execFileSync('docker', ['exec', container, 'pg_isready', '-U', 'postgres'], {
                timeout: 15000,
                stdio: 'pipe',
            });
            break;
        } catch {
            if (Date.now() > deadline) throw new Error('PG readiness timeout: ' + container);
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }
    const { startModelChatFixture } = await import('./model-chat.fixture.mjs');
    f = await startModelChatFixture({ adminUrl: 'postgres://postgres:qa@127.0.0.1:' + port + '/postgres' });
    modelCard = f.cards[0];
    // Детерминированные ответы: профиль агента в messages[0], маркер задачи в вопросе.
    f.provider.respond = (call) => {
        if (!call.path.endsWith('/chat/completions')) return {};
        const messages = call.body.messages || [],
            profile = String(messages[0]?.content || ''),
            all = JSON.stringify(messages),
            agent = profile.includes('PROFILE-AGENT-1')
                ? 1
                : profile.includes('PROFILE-AGENT-2')
                  ? 2
                  : profile.includes('PROFILE-AGENT-3')
                    ? 3
                    : 0;
        calls.push({ agent, messages });
        if (agent === 1 && all.includes('SH-TEAM'))
            return {
                reply:
                    'TEAM-SHARED-ANSWER\n\n' +
                    shareBlock(DEFAULT_ROOM, [
                        { kind: 'decision', content: 'DECISION-ELEMENT' },
                        { kind: 'result', content: 'RESULT-ELEMENT' },
                    ]),
            };
        if (agent === 1 && all.includes('SH-GATE'))
            return {
                reply: 'GATE-ANSWER\n\n' + shareBlock(privateRoomId, [{ kind: 'state', content: 'GATE-ELEMENT' }]),
            };
        if (agent === 1 && all.includes('SH-BOTH'))
            return {
                reply:
                    'BOTH-ANSWER\n\n' +
                    shareBlock(DEFAULT_ROOM, [{ kind: 'decision', content: 'BOTH-DECISION' }]) +
                    '\n\n' +
                    handoverBlock(agentIds[1]),
            };
        if (agent === 3 && all.includes('SH-PRIV'))
            return {
                reply:
                    'PRIV-ANSWER\n\n' +
                    shareBlock(privateRoomId, [{ kind: 'state', content: 'PRIVATE-STATE-ELEMENT' }]),
            };
        if (agent === 3 && all.includes('SH-LEAK'))
            return {
                reply:
                    'LEAK-ANSWER\n\n' +
                    shareBlock(DEFAULT_ROOM, [
                        { kind: 'decision', content: 'LEAK-ELEMENT' },
                        { kind: 'result', content: 'LEAK-REF-ELEMENT', ref: privAnswerId },
                    ]),
            };
        return { reply: 'GENERIC-ANSWER' };
    };
    // Три агента с различимыми профилями; назначение в проект + состав комнат.
    for (const n of [1, 2, 3]) {
        const card = await f.request('main', '/api/agents', {
            method: 'POST',
            status: 201,
            body: {
                requestKey: randomUUID(),
                slug: 'nc-share-' + randomUUID().slice(0, 8).replaceAll('-', ''),
                name: 'Share agent ' + n,
                definition: {
                    description: 'QA specialist ' + n,
                    prompt: 'PROFILE-AGENT-' + n,
                    mode: 'subagent',
                    permission: { read: 'allow', edit: 'deny', bash: 'deny' },
                },
            },
        });
        agentIds.push(card.id);
    }
    const revision = (await f.request('main', '/api/agents?projectId=' + f.projectId)).revision;
    let expectedRevision = revision;
    for (const [index, agentId] of agentIds.entries()) {
        const card = await f.request('main', '/api/agents/' + agentId);
        await f.request('main', '/api/projects/' + f.projectId + '/agents', {
            method: 'POST',
            status: 201,
            body: {
                requestKey: randomUUID(),
                expectedRevision,
                agentId,
                version: card.version,
                manifest: card.manifest,
            },
        });
        expectedRevision += 1;
        // Назначение создаёт агента выключенным; комната принимает только включённых.
        await f.request('main', '/api/projects/' + f.projectId + '/agents/' + agentId, {
            method: 'PATCH',
            body: { requestKey: randomUUID(), expectedRevision, enabled: true },
        });
        expectedRevision += 1;
    }
    // Общая (публичная) комната: агенты 1 и 2. Агент3 — вне состава.
    await f.request('main', '/api/projects/' + f.projectId + '/team-chat/participants', {
        method: 'PUT',
        body: {
            expectedRevision: 0,
            modelId: modelCard.id,
            expectedModelPin: modelCard.modelPin,
            agentIds: agentIds.slice(0, 2),
        },
    });
    // Приватная комната (личный диалог) — участник только агент3; член — developer.
    const room = await f.request('main', '/api/projects/' + f.projectId + '/team-chat/rooms', {
        method: 'POST',
        status: 201,
        body: {
            requestKey: randomUUID(),
            title: 'Share private',
            visibility: 'PRIVATE',
            memberEmails: [f.actors.developer.email],
        },
    });
    privateRoomId = room.id;
    // Новая комната стартует с revision 1 (DB DEFAULT).
    await f.request('main', '/api/projects/' + f.projectId + '/team-chat/rooms/' + privateRoomId + '/participants', {
        method: 'PUT',
        body: {
            expectedRevision: 1,
            modelId: modelCard.id,
            expectedModelPin: modelCard.modelPin,
            agentIds: [agentIds[2]],
        },
    });
};

try {
    await bootstrap();
} catch (error) {
    skip = true;
    bootstrapError = String(error && error.message ? error.message : error);
}

const teardown = async () => {
    try {
        if (f) await f.close();
    } finally {
        if (container) execFileSync('docker', ['rm', '-f', container], { timeout: 30000, stdio: 'pipe' });
    }
};
process.on('exit', () => {
    if (container) {
        try {
            execFileSync('docker', ['rm', '-f', container], { timeout: 10000, stdio: 'pipe' });
        } catch {
            /* best effort */
        }
    }
});

const guard = (t) => {
    if (skip) t.skip('bootstrap недоступен: ' + bootstrapError);
};

const task = async (prompt, targetAgents, roomId = null) =>
    f.request(
        'developer',
        '/api/projects/' + f.projectId + '/team-chat' + (roomId ? '/rooms/' + roomId : '') + '/messages',
        { method: 'POST', status: 201, body: { requestKey: randomUUID(), prompt, targetAgentIds: targetAgents } },
    );

const rowByPrompt = async (prompt, roomId = null) =>
    (
        await f.pool.query(
            roomId
                ? "SELECT * FROM project_chat_messages WHERE project_id=$1 AND room_id=$2 AND kind='user' AND content=$3"
                : "SELECT * FROM project_chat_messages WHERE project_id=$1 AND kind='user' AND content=$2",
            roomId ? [f.projectId, roomId, prompt] : [f.projectId, prompt],
        )
    ).rows[0];

const children = async (taskId) =>
    (
        await f.pool.query(
            'SELECT * FROM project_chat_messages WHERE project_id=$1 AND source_message_id=$2 ORDER BY position',
            [f.projectId, taskId],
        )
    ).rows;

const waitUntil = async (sql, params, predicate, label, timeoutMs = 90000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const rows = (await f.pool.query(sql, params)).rows;
        if (rows.some(predicate)) return rows.find(predicate);
        if (Date.now() > deadline) throw new Error('QA timeout: ' + label);
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
};

const doneTask = async (prompt, roomId = null) => {
    const source = await rowByPrompt(prompt, roomId);
    return waitUntil(
        'SELECT * FROM project_chat_messages WHERE id=$1',
        [source.id],
        (row) => row.status === 'done',
        'task ' + prompt + ' done',
    );
};

const agentCall = (agent, prompt) =>
    calls.find((call) => call.agent === agent && JSON.stringify(call.messages).includes(prompt));

const sharedBlock = (messages) =>
    messages.find(
        (message) =>
            typeof message.content === 'string' && message.content.includes('Элементы делёного контекста комнаты'),
    );

const afterState = (row) => (typeof row.after_state === 'string' ? JSON.parse(row.after_state) : row.after_state);

test('9.3: деление с командой — элемент с per-item провенансом + транзакционный аудит + видимость в комнате', async (t) => {
    guard(t);
    if (skip) return;
    await task('SH-TEAM', [agentIds[0]]);
    const source = await doneTask('SH-TEAM');
    const answer = (await children(source.id)).find(
        (row) => row.kind === 'agent' && row.content.includes('TEAM-SHARED-ANSWER'),
    );
    assert.equal(answer.status, 'done', 'ответ агента1 с директивой опубликован');

    // Пер-итем провенанс: агент + what (несущий ответ) + версия + SHA.
    for (const [kind, content] of [
        ['decision', 'DECISION-ELEMENT'],
        ['result', 'RESULT-ELEMENT'],
    ]) {
        const item = (
            await f.pool.query(
                'SELECT * FROM project_chat_shared_items WHERE project_id=$1 AND room_id=$2 AND content=$3',
                [f.projectId, DEFAULT_ROOM, content],
            )
        ).rows[0];
        assert.ok(item, 'элемент ' + content + ' сохранён в публичной комнате');
        assert.equal(item.kind, kind);
        assert.equal(item.source_agent_id, agentIds[0], 'какой агент');
        assert.equal(item.source_agent_name, 'Share agent 1');
        assert.equal(item.ref_message_id, answer.id, 'what-ref: несущий ответ');
        assert.equal(item.source_generation, answer.generation, 'версия');
        assert.equal(item.source_room_id, DEFAULT_ROOM);
        assert.equal(item.content_sha, sha256(content), 'SHA элемента');
        assert.ok(item.created_at, 'время деления');
    }

    // Аудит (NFR-4): кто, что, в какую комнату, с per-item провенансом.
    const audit = await waitUntil(
        'SELECT * FROM security_events WHERE action=$1 AND resource_id=$2',
        ['project.chat.agent.share', answer.id],
        (row) => !!row,
        'share audit',
    );
    assert.equal(audit.actor, f.actors.developer.email);
    const after = afterState(audit);
    assert.equal(after.roomId, DEFAULT_ROOM);
    assert.equal(after.agentId, agentIds[0]);
    assert.equal(after.responseId, answer.id);
    assert.equal(after.items.length, 2);
    assert.deepEqual(
        [...after.items.map((entry) => entry.contentSha)].sort(),
        [sha256('DECISION-ELEMENT'), sha256('RESULT-ELEMENT')].sort(),
        'per-item SHA в аудите совпадает с SHA элементов',
    );

    // Видимость для команды: элемент с провенансом в чтении комнаты.
    const detail = await f.request('developer', '/api/projects/' + f.projectId + '/team-chat');
    assert.equal(detail.shared.length, 2);
    const sharedDecision = detail.shared.find((entry) => entry.content === 'DECISION-ELEMENT');
    assert.equal(sharedDecision.sourceAgentId, agentIds[0]);
    assert.equal(sharedDecision.refMessageId, answer.id);
    assert.equal(sharedDecision.sourceGeneration, answer.generation);
    assert.equal(sharedDecision.contentSha, sha256('DECISION-ELEMENT'));
});

test('9.3: деление с пользователем (личный диалог) — элемент с провенансом, не опубликован команде', async (t) => {
    guard(t);
    if (skip) return;
    await task('SH-PRIV', [agentIds[2]], privateRoomId);
    const source = await doneTask('SH-PRIV', privateRoomId);
    const answer = (await children(source.id)).find(
        (row) => row.kind === 'agent' && row.content.includes('PRIV-ANSWER'),
    );
    assert.equal(answer.status, 'done', 'ответ агента3 в личном диалоге опубликован');
    privAnswerId = answer.id;

    const item = (
        await f.pool.query(
            'SELECT * FROM project_chat_shared_items WHERE project_id=$1 AND room_id=$2 AND content=$3',
            [f.projectId, privateRoomId, 'PRIVATE-STATE-ELEMENT'],
        )
    ).rows[0];
    assert.ok(item, 'элемент сохранён в приватной комнате');
    assert.equal(item.kind, 'state');
    assert.equal(item.source_agent_id, agentIds[2], 'какой агент');
    assert.equal(item.ref_message_id, answer.id, 'what-ref');
    assert.equal(item.source_generation, answer.generation, 'версия');
    assert.equal(item.content_sha, sha256('PRIVATE-STATE-ELEMENT'));

    // Личный (не команде): пользователь видит в диалоге.
    const detail = await f.request('developer', '/api/projects/' + f.projectId + '/team-chat/rooms/' + privateRoomId);
    assert.equal(detail.shared.length, 1);
    assert.equal(detail.shared[0].content, 'PRIVATE-STATE-ELEMENT');
    assert.equal(detail.shared[0].sourceAgentId, agentIds[2]);

    // …и его нет в общей публичной комнате.
    const inPublic = (
        await f.pool.query(
            "SELECT count(*)::int AS n FROM project_chat_shared_items WHERE project_id=$1 AND room_id=$2 AND content='PRIVATE-STATE-ELEMENT'",
            [f.projectId, DEFAULT_ROOM],
        )
    ).rows[0];
    assert.equal(inPublic.n, 0, 'приватный элемент не опубликован команде');
});

test('9.3: гейт доступа — агент без доступа к целевой комнате не делит (fail-closed, ответ сохранён)', async (t) => {
    guard(t);
    if (skip) return;
    await task('SH-GATE', [agentIds[0]]);
    const source = await doneTask('SH-GATE');
    const answer = (await children(source.id)).find(
        (row) => row.kind === 'agent' && row.content.includes('GATE-ANSWER'),
    );
    assert.equal(answer.status, 'done', 'опубликованный ответ сохранён');

    const leaked = (
        await f.pool.query(
            "SELECT count(*)::int AS n FROM project_chat_shared_items WHERE project_id=$1 AND content='GATE-ELEMENT'",
            [f.projectId],
        )
    ).rows[0];
    assert.equal(leaked.n, 0, 'агент вне состава комнаты подключил элемент');

    const audit = (
        await f.pool.query(
            "SELECT count(*)::int AS n FROM security_events WHERE action='project.chat.agent.share' AND resource_id=$1",
            [answer.id],
        )
    ).rows[0];
    assert.equal(audit.n, 0, 'аудит деления без доступа не создаётся');
});

test('9.3: приватный диалог — не канал деления с командой (FR-403, утечка → фэйл)', async (t) => {
    guard(t);
    if (skip) return;
    assert.ok(privAnswerId, 'нужен ответ из личного диалога (сценарий с пользователем)');
    await task('SH-LEAK', [agentIds[2]], privateRoomId);
    const source = await doneTask('SH-LEAK', privateRoomId);
    const answer = (await children(source.id)).find(
        (row) => row.kind === 'agent' && row.content.includes('LEAK-ANSWER'),
    );
    assert.equal(answer.status, 'done', 'опубликованный ответ сохранён');

    // И элемент без ref (текущая приватная комната — источник), и с ref на приватный ответ — в публичную комнату не входят.
    const leaked = (
        await f.pool.query(
            "SELECT count(*)::int AS n FROM project_chat_shared_items WHERE project_id=$1 AND room_id=$2 AND content IN ('LEAK-ELEMENT','LEAK-REF-ELEMENT')",
            [f.projectId, DEFAULT_ROOM],
        )
    ).rows[0];
    assert.equal(leaked.n, 0, 'приватный источник утекает в публичную комнату (FR-403)');

    const audit = (
        await f.pool.query(
            "SELECT count(*)::int AS n FROM security_events WHERE action='project.chat.agent.share' AND resource_id=$1",
            [answer.id],
        )
    ).rows[0];
    assert.equal(audit.n, 0, 'аудит несостоявшегося деления не создаётся');
});

test('9.3: деление с другим агентом — следующий вызов видит элементы с провенансом', async (t) => {
    guard(t);
    if (skip) return;
    const teamAnswer = (await children((await rowByPrompt('SH-TEAM')).id)).find(
        (row) => row.kind === 'agent' && row.content.includes('TEAM-SHARED-ANSWER'),
    );
    await task('SH-CTX', [agentIds[1]]);
    await doneTask('SH-CTX');
    const call = agentCall(2, 'SH-CTX');
    assert.ok(call, 'вызов модели агента2 не найден');
    const block = sharedBlock(call.messages);
    assert.ok(block, 'делёный контекст отсутствует в вызове агента2');
    const data = JSON.parse(block.content.split('\n', 2)[1]);
    const entry = data.find((item) => item.content === 'DECISION-ELEMENT');
    assert.ok(entry, 'элемент деления в контексте следующего агента');
    assert.equal(entry.kind, 'decision');
    assert.equal(entry.provenance.agentId, agentIds[0], 'какой агент');
    assert.equal(entry.provenance.what, teamAnswer.id, 'what-ref');
    assert.equal(entry.provenance.version, teamAnswer.generation, 'версия');
    assert.equal(entry.provenance.sha, sha256('DECISION-ELEMENT'), 'SHA');
    assert.ok(entry.provenance.ts, 'время');
});

test('9.3: подключение (entry 2) — частный случай деления: share и handover в одном ответе, аудит обоих', async (t) => {
    guard(t);
    if (skip) return;
    await task('SH-BOTH', [agentIds[0]]);
    const source = await doneTask('SH-BOTH');
    const fromAnswer = (await children(source.id)).find(
        (row) => row.kind === 'agent' && row.content.includes('BOTH-ANSWER'),
    );
    assert.equal(fromAnswer.status, 'done', 'ответ агента1 с обеими директивами опубликован');

    // Деление выполнено: элемент с провенансом в общей комнате.
    const item = (
        await f.pool.query(
            'SELECT * FROM project_chat_shared_items WHERE project_id=$1 AND room_id=$2 AND content=$3',
            [f.projectId, DEFAULT_ROOM, 'BOTH-DECISION'],
        )
    ).rows[0];
    assert.ok(item, 'элемент деления сохранён');
    assert.equal(item.source_agent_id, agentIds[0]);
    assert.equal(item.ref_message_id, fromAnswer.id);
    const shareAudit = await waitUntil(
        'SELECT * FROM security_events WHERE action=$1 AND resource_id=$2',
        ['project.chat.agent.share', fromAnswer.id],
        (row) => !!row,
        'share audit (both)',
    );
    assert.equal(afterState(shareAudit).agentId, agentIds[0]);

    // Подключение (частный случай): агент2 подключён, ответил, аудит подключения.
    const toAnswer = (await children(source.id)).find((row) => row.snapshot?.agentId === agentIds[1]);
    assert.ok(toAnswer, 'агент2 подключён к задаче');
    assert.equal(toAnswer.status, 'done', 'агент2 ответил');
    const handoverAudit = await waitUntil(
        'SELECT * FROM security_events WHERE action=$1 AND resource_id=$2',
        ['project.chat.agent.handover', source.id],
        (row) => !!row,
        'handover audit (both)',
    );
    assert.equal(afterState(handoverAudit).toAgentId, agentIds[1]);
});

test('9.3: teardown', async (t) => {
    if (skip) return t.skip('bootstrap недоступен: ' + bootstrapError);
    await teardown();
});
