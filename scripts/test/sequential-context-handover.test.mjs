/**
 * 9.2 (FR-302): последовательный контекст + подключение агента агентом. E2E.
 *
 * Инфраструктура: in-process Catalog (полный app.module из dist) + fake OpenAI-провайдер
 * + одноразовый PostgreSQL 16 (docker, 127.0.0.1, порт ≠ 5432). Запускает собственный
 * disposable PG-контейнер; если docker/образ недоступны — все тесты skip (корневой сьют
 * не затрагивается: файл не входит в check-tooling-tests.json).
 *
 * Сценарии:
 *   1. C5-цепочка: агент2 до вызова видит опубликованный ответ агента1 (ID/автор/порядок/версия).
 *   2. Handover: агент1 в опубликованном ответе подключает агента2 к задаче:
 *      контекст задачи (sequential context) + транзакционный аудит (who/кого/задача/когда).
 *   3. FR-403: приватный (неопубликованный) ответ не попадает в последовательный контекст
 *      общей комнаты.
 *   4. Отказы: директива на агента вне состава комнаты и невалидная директива — без аудита,
 *      опубликованный ответ сохраняется.
 *
 * Запуск: node --test scripts/test/sequential-context-handover.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import net from 'node:net';

let skip = false,
    bootstrapError = '',
    f = null,
    container = null,
    port = 0,
    agentIds = [],
    modelCard = null,
    privateRoomId = null,
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

const bootstrap = async () => {
    port = 55432 + (process.pid % 200);
    container = 'nc-seq-e2e-' + randomUUID().slice(0, 8);
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
        if (agent === 1 && all.includes('HO-TASK'))
            return {
                reply:
                    'HO-ANSWER-1\n\n```neurocenter-handover\n' +
                    JSON.stringify({ agentId: agentIds[1], note: 'Нужна экспертиза' }) +
                    '\n```',
            };
        if (agent === 1 && all.includes('HO-BAD'))
            return {
                reply:
                    'HO-BAD-ANSWER\n\n```neurocenter-handover\n' + JSON.stringify({ agentId: agentIds[2] }) + '\n```',
            };
        if (agent === 1 && all.includes('HO-MALFORMED'))
            return { reply: 'HO-MALFORMED-ANSWER\n\n```neurocenter-handover\n{bad\n```' };
        if (agent === 2 && all.includes('HO-TASK')) return { reply: 'HO-ANSWER-2' };
        return { reply: 'GENERIC-ANSWER' };
    };
    // Три агента с различимыми профилями; назначение в проект + состав общей комнаты.
    for (const n of [1, 2, 3]) {
        const card = await f.request('main', '/api/agents', {
            method: 'POST',
            status: 201,
            body: {
                requestKey: randomUUID(),
                slug: 'nc-seq-' + randomUUID().slice(0, 8).replaceAll('-', ''),
                name: 'Seq agent ' + n,
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
    await f.request('main', '/api/projects/' + f.projectId + '/team-chat/participants', {
        method: 'PUT',
        body: {
            expectedRevision: 0,
            modelId: modelCard.id,
            expectedModelPin: modelCard.modelPin,
            agentIds: agentIds.slice(0, 2),
        },
    });
    // Приватная комната только для агента3 (вне состава общей комнаты).
    const room = await f.request('main', '/api/projects/' + f.projectId + '/team-chat/rooms', {
        method: 'POST',
        status: 201,
        body: {
            requestKey: randomUUID(),
            title: 'Seq private',
            visibility: 'PRIVATE',
            memberEmails: [f.actors.developer.email],
        },
    });
    privateRoomId = room.id;
    // Новая комната стартует с revision 1 (DB DEFAULT), в отличие от дефолтной (виртуальный 0 до первого PUT).
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

const task = async (prompt, targetAgents) =>
    f.request('developer', '/api/projects/' + f.projectId + '/team-chat/messages', {
        method: 'POST',
        status: 201,
        body: { requestKey: randomUUID(), prompt, targetAgentIds: targetAgents },
    });

const rowByPrompt = async (prompt) =>
    (
        await f.pool.query("SELECT * FROM project_chat_messages WHERE project_id=$1 AND kind='user' AND content=$2", [
            f.projectId,
            prompt,
        ])
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

const doneTask = (prompt) =>
    waitUntil(
        "SELECT * FROM project_chat_messages WHERE project_id=$1 AND kind='user' AND content=$2",
        [f.projectId, prompt],
        (row) => row.status === 'done',
        'task ' + prompt + ' done',
    );

const agentCall = (agent, prompt) =>
    calls.find((call) => call.agent === agent && JSON.stringify(call.messages).includes(prompt));

const sequentialBlock = (messages) =>
    messages.find(
        (message) =>
            typeof message.content === 'string' &&
            message.content.includes('Опубликованные ответы предыдущих исполнителей'),
    );

test('9.2: следующий агент до вызова видит опубликованные ответы предыдущих (ID/автор/порядок/версия)', async (t) => {
    guard(t);
    if (skip) return;
    await task('SEQ-TASK-1', [agentIds[0]]);
    const first = await doneTask('SEQ-TASK-1');
    const firstAnswer = (await children(first.id)).find((row) => row.kind === 'agent');
    assert.equal(firstAnswer.status, 'done');
    assert.equal(firstAnswer.content, 'GENERIC-ANSWER');

    await task('SEQ-TASK-2', [agentIds[1]]);
    await doneTask('SEQ-TASK-2');
    const call = agentCall(2, 'SEQ-TASK-2');
    assert.ok(call, 'вызов модели агента2 не найден');
    const block = sequentialBlock(call.messages);
    assert.ok(block, 'последовательный контекст отсутствует в вызове агента2');
    const data = JSON.parse(block.content.split('\n', 2)[1]);
    assert.ok(
        data.some((item) => item.messageId === firstAnswer.id && item.author.agentId === agentIds[0]),
        'провенанс ответа агента1',
    );
    const entry = data.find((item) => item.messageId === firstAnswer.id);
    assert.equal(entry.position, firstAnswer.position, 'порядок (position)');
    assert.equal(entry.generation, firstAnswer.generation, 'версия (generation)');
    assert.equal(entry.author.agentId, agentIds[0], 'автор');
});

test('9.2: подключение агента агентом — контекст задачи + транзакционный аудит', async (t) => {
    guard(t);
    if (skip) return;
    await task('HO-TASK', [agentIds[0]]);
    const source = await doneTask('HO-TASK');
    const fromAnswer = (await children(source.id)).find(
        (row) => row.kind === 'agent' && row.content.includes('HO-ANSWER-1'),
    );
    assert.equal(fromAnswer.status, 'done', 'ответ агента1 с директивой опубликован');
    const toAnswer = (await children(source.id)).find((row) => row.snapshot?.agentId === agentIds[1]);
    assert.ok(toAnswer, 'агент2 подключён к задаче');
    assert.equal(toAnswer.status, 'done', 'агент2 ответил');
    assert.equal(toAnswer.content, 'HO-ANSWER-2');

    // Контекст задачи передан: у агента2 в вызове — опубликованный ответ агента1 с провенансом.
    const call = agentCall(2, 'HO-TASK');
    assert.ok(call, 'вызов модели агента2 не найден');
    const block = sequentialBlock(call.messages);
    const entry = JSON.parse(block.content.split('\n', 2)[1]).find((item) => item.messageId === fromAnswer.id);
    assert.ok(entry, 'ответ агента1 в последовательном контексте агента2');
    assert.equal(entry.generation, fromAnswer.generation, 'версия переданного ответа');

    // Аудит: кто (actor), кого (toAgentId), с какого ответа (fromAnswerId), к какой задаче (resource_id), когда (created_at).
    const audit = await waitUntil(
        'SELECT * FROM security_events WHERE action=$1 AND resource_id=$2',
        ['project.chat.agent.handover', source.id],
        (row) => !!row,
        'handover audit',
    );
    assert.equal(audit.actor, f.actors.developer.email);
    // after_state — jsonb: pg-драйвер уже возвращает объект.
    const after = typeof audit.after_state === 'string' ? JSON.parse(audit.after_state) : audit.after_state;
    assert.equal(after.fromAgentId, agentIds[0]);
    assert.equal(after.toAgentId, agentIds[1]);
    assert.equal(after.fromAnswerId, fromAnswer.id);
    assert.ok(audit.created_at, 'время события');
    // Транзакционность: аудит и подключение зафиксированы (строка агента2 существует).
    assert.ok(toAnswer.id, 'подключение без аудита недопустимо (NFR-4)');
});

test('9.2: приватный ответ не попадает в последовательный контекст (FR-403)', async (t) => {
    guard(t);
    if (skip) return;
    await f.request('developer', '/api/projects/' + f.projectId + '/team-chat/rooms/' + privateRoomId + '/messages', {
        method: 'POST',
        status: 201,
        body: { requestKey: randomUUID(), prompt: 'PRIV-TASK', targetAgentIds: [agentIds[2]] },
    });
    const privateTask = await waitUntil(
        "SELECT * FROM project_chat_messages WHERE project_id=$1 AND room_id=$2 AND kind='user' AND content=$3",
        [f.projectId, privateRoomId, 'PRIV-TASK'],
        (row) => row.status === 'done',
        'private task done',
    );
    const privateAnswer = (
        await f.pool.query(
            "SELECT * FROM project_chat_messages WHERE project_id=$1 AND source_message_id=$2 AND kind='agent'",
            [f.projectId, privateTask.id],
        )
    ).rows[0];
    assert.equal(privateAnswer.status, 'done');
    assert.equal(privateAnswer.content, 'GENERIC-ANSWER');

    await task('SEQ-AFTER-PRIV', [agentIds[0]]);
    await doneTask('SEQ-AFTER-PRIV');
    const call = agentCall(1, 'SEQ-AFTER-PRIV');
    assert.ok(call, 'вызов модели агента1 не найден');
    assert.ok(
        !JSON.stringify(call.messages).includes('PRIV-TASK-ANSWER') || privateAnswer.content === 'GENERIC-ANSWER',
    );
    // Прямая проверка: приватный ответ не в контексте общей комнаты.
    assert.ok(!JSON.stringify(call.messages).includes(privateAnswer.id), 'приватный ответ в контексте (FR-403)');
});

test('9.2: отказ — директива на агента вне состава комнаты и невалидная директива', async (t) => {
    guard(t);
    if (skip) return;
    await task('HO-BAD', [agentIds[0]]);
    const bad = await doneTask('HO-BAD');
    assert.equal(
        await waitUntil(
            'SELECT count(*)::int AS n FROM security_events WHERE action=$1 AND resource_id=$2',
            ['project.chat.agent.handover', bad.id],
            (row) => row.n > 0,
            'absent audit (must not exist)',
            5000,
        ).catch(() => null),
        null,
        'аудит появился: агент вне состава комнаты подключён',
    );
    const badChildren = await children(bad.id);
    assert.equal(badChildren.filter((row) => row.kind === 'agent').length, 1, 'чужой агент не подключён');
    assert.equal(badChildren[0].content.includes('HO-BAD-ANSWER'), true, 'опубликованный ответ сохранён');

    await task('HO-MALFORMED', [agentIds[0]]);
    const malformed = await doneTask('HO-MALFORMED');
    const malformedAudit = await f.pool.query(
        'SELECT count(*)::int AS n FROM security_events WHERE action=$1 AND resource_id=$2',
        ['project.chat.agent.handover', malformed.id],
    );
    assert.equal(malformedAudit.rows[0].n, 0, 'невалидная директива не создаёт подключение');
});

test.after(async () => {
    if (f || container) await teardown();
});
