import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * 9.5 (FR-310): a project agent explicitly invokes a system role from a published
 * answer (a problem, a clarification or a recovery when there is no path forward).
 * The durable call row and the audit are stored in the finalization transaction
 * (NFR-4); the role runs through the durable system-role pipeline and its terminal
 * outcome is delivered back to the caller's room; a rejected or failed call posts
 * an actionable error (NFR-3) and malformed directives never fail the answer.
 * Self-bootstrap: disposable PostgreSQL + in-process Catalog from dist + scripted
 * fake OpenAI provider.
 */

const DEFAULT_ROOM = '00000000-0000-0000-0000-000000000000';

let skip = false,
    bootstrapError = '',
    f = null,
    container = null,
    port = 0,
    agentId = null,
    modelCard = null;

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

const systemCallBlock = (call) => '```neurocenter-system-call\n' + JSON.stringify(call) + '\n```';
const roleAnswer = (marker) =>
    JSON.stringify({
        kind: 'diagnosis',
        summary: 'SC-SUMMARY-' + marker,
        answer: 'SC-ANSWER-' + marker,
        findings: [],
        nextSteps: ['SC-STEP-' + marker],
        changes: [],
    });

const bootstrap = async () => {
    port = 55632 + (process.pid % 200);
    container = 'nc-syscall-e2e-' + randomUUID().slice(0, 8);
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
    // Детерминированные ответы. Ролевой вызов: messages[0] — RAG-контекст проекта,
    // а не промпт роли (fit() перестраивает сообщения), поэтому маркер JSON-контракта
    // ищется во всём теле, а не в messages[0]. Промт ответа роли (roleAnswer) маркер
    // не содержит, поэтому room-история task-вызовов не даёт ложного срабатывания.
    // Task проектного агента: роутинг ПО ПОСЛЕДНЕМУ user-сообщению (вопрос task), а не
    // по всей истории — комната к моменту SC-RECOVERY уже содержит 'SC-PROBLEM'.
    f.provider.respond = (call) => {
        if (!call.path.endsWith('/chat/completions')) return {};
        const messages = call.body.messages || [],
            all = JSON.stringify(messages),
            lastUser = String(
                [...messages].reverse().find((message) => message.role === 'user')?.content || '',
            );
        // Маркер контракта ищется по сырому контенту каждого сообщения: JSON.stringify
        // экранирует кавычки в промпте и ломает точный поиск.
        const roleCall = messages.some((message) =>
            String(message.content).includes('Ответь только JSON: {"kind"'),
        );
        let reply = 'GENERIC-ANSWER';
        if (roleCall) {
            if (all.includes('SC-BADJSON')) reply = 'NOT-VALID-ROLE-JSON';
            else if (all.includes('SC-RECOVERY-QUESTION')) reply = roleAnswer('RECOVERY');
            else reply = roleAnswer('PROBLEM');
        } else if (lastUser.includes('SC-PROBLEM')) {
            reply =
                'PROBLEM-ANSWER\n\n' +
                systemCallBlock({ roleId: 'agent-ai-admin', reason: 'problem', question: 'SC-PROBLEM-QUESTION' });
        } else if (lastUser.includes('SC-RECOVERY')) {
            reply =
                'RECOVERY-ANSWER\n\n' +
                systemCallBlock({ roleId: 'agent-ai-admin', reason: 'recovery', question: 'SC-RECOVERY-QUESTION' });
        } else if (lastUser.includes('SC-BADREASON')) {
            reply =
                'BADREASON-ANSWER\n\n' +
                systemCallBlock({ roleId: 'agent-ai-admin', reason: 'panic', question: 'SC-BADREASON-QUESTION' });
        } else if (lastUser.includes('SC-UNKNOWN')) {
            reply =
                'UNKNOWN-ANSWER\n\n' +
                systemCallBlock({ roleId: 'agent-nobody', reason: 'problem', question: 'SC-UNKNOWN-QUESTION' });
        } else if (lastUser.includes('SC-BADJSON')) {
            reply =
                'BADJSON-ANSWER\n\n' +
                systemCallBlock({ roleId: 'agent-ai-admin', reason: 'problem', question: 'SC-BADJSON-QUESTION' });
        }
        return { reply };
    };
    // Агент с различимым профилем; назначение + включение + состав публичной комнаты.
    const card = await f.request('main', '/api/agents', {
        method: 'POST',
        status: 201,
        body: {
            requestKey: randomUUID(),
            slug: 'nc-syscall-' + randomUUID().slice(0, 8).replaceAll('-', ''),
            name: 'SysCall agent',
            definition: {
                description: 'QA specialist',
                prompt: 'PROFILE-AGENT-1',
                mode: 'subagent',
                permission: { read: 'allow', edit: 'deny', bash: 'deny' },
            },
        },
    });
    agentId = card.id;
    const revision = (await f.request('main', '/api/agents?projectId=' + f.projectId)).revision;
    let expectedRevision = revision;
    const detail = await f.request('main', '/api/agents/' + agentId);
    await f.request('main', '/api/projects/' + f.projectId + '/agents', {
        method: 'POST',
        status: 201,
        body: {
            requestKey: randomUUID(),
            expectedRevision,
            agentId,
            version: detail.version,
            manifest: detail.manifest,
        },
    });
    expectedRevision += 1;
    // Назначение создаёт агента выключенным; комната принимает только включённых.
    await f.request('main', '/api/projects/' + f.projectId + '/agents/' + agentId, {
        method: 'PATCH',
        body: { requestKey: randomUUID(), expectedRevision, enabled: true },
    });
    expectedRevision += 1;
    await f.request('main', '/api/projects/' + f.projectId + '/team-chat/participants', {
        method: 'PUT',
        body: {
            expectedRevision: 0,
            modelId: modelCard.id,
            expectedModelPin: modelCard.modelPin,
            agentIds: [agentId],
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

// Запрос идёт от главного администратора: системный вызов разрешён минимум с уровня 3
// (Разработчик fail-closed отклоняется политикой системных ролей).
const task = async (prompt) =>
    f.request('main', '/api/projects/' + f.projectId + '/team-chat/messages', {
        method: 'POST',
        status: 201,
        body: { requestKey: randomUUID(), prompt, targetAgentIds: [agentId] },
    });

const rowByPrompt = async (prompt) =>
    (
        await f.pool.query(
            "SELECT * FROM project_chat_messages WHERE project_id=$1 AND kind='user' AND content=$2",
            [f.projectId, prompt],
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

const doneTask = async (prompt) => {
    const source = await rowByPrompt(prompt);
    return waitUntil(
        'SELECT * FROM project_chat_messages WHERE id=$1',
        [source.id],
        (row) => row.status === 'done',
        'task ' + prompt + ' done',
    );
};

const snapshotOf = (row) => (typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot);
const afterState = (row) => (typeof row.after_state === 'string' ? JSON.parse(row.after_state) : row.after_state);

const callRow = (question, predicate, label) =>
    waitUntil(
        'SELECT * FROM project_chat_system_calls WHERE project_id=$1 AND question=$2',
        [f.projectId, question],
        predicate,
        label,
    );

test('9.5: системная роль по проблеме — delivered, результат в комнате, транзакционный аудит', async (t) => {
    guard(t);
    if (skip) return;
    await task('SC-PROBLEM');
    const source = await rowByPrompt('SC-PROBLEM');
    await doneTask('SC-PROBLEM');
    const answer = (await children(source.id)).find(
        (row) => row.kind === 'agent' && row.content.includes('PROBLEM-ANSWER'),
    );
    assert.ok(answer, 'ответ агента с директивой опубликован');
    assert.equal(answer.status, 'done');

    // Дurable-строка вызова: invoked -> delivered ровно один раз (trigger immutability).
    const call = await callRow('SC-PROBLEM-QUESTION', (row) => row.state === 'delivered', 'call delivered');
    assert.equal(call.run_state, 'succeeded');
    assert.equal(call.role_id, 'agent-ai-admin');
    assert.equal(call.reason, 'problem');
    assert.equal(call.agent_id, agentId);
    assert.ok(call.run_id && call.request_id, 'запуск и идемпотентный запрос зафиксированы');
    assert.ok(call.delivered_at, 'момент доставки записан');
    const callSnapshot = snapshotOf(call);
    assert.equal(callSnapshot.agentId, 'agent-ai-admin', 'строка несёт синтетический снимок роли');
    assert.equal(callSnapshot.modelId, modelCard.id, 'вызов использует модель комнаты');

    // Ролевой запуск завершился успехом.
    const run = (await f.pool.query('SELECT * FROM system_role_runs WHERE id=$1', [call.run_id])).rows[0];
    assert.equal(run.state, 'succeeded');

    // Итог доставлен в комнату комнаты-источника как сообщение системной роли.
    const delivered = await waitUntil(
        "SELECT * FROM project_chat_messages WHERE project_id=$1 AND source_message_id=$2 AND kind='agent' AND content LIKE '%Ответ системной роли%'",
        [f.projectId, answer.id],
        (row) => true,
        'role answer delivered to room',
    );
    assert.equal(delivered.status, 'done');
    assert.equal(snapshotOf(delivered).agentId, 'agent-ai-admin');
    assert.ok(delivered.content.includes('## Ответ системной роли «AI-админ»'));
    assert.ok(delivered.content.includes('SC-ANSWER-PROBLEM'));
    assert.ok(delivered.content.includes('SC-STEP-PROBLEM'));

    // Аудит: запись finalization + запись доставки в security_events.
    const audit = (
        await f.pool.query("SELECT * FROM security_events WHERE action='project.chat.agent.system-call' AND resource_id=$1", [
            call.call_id,
        ])
    ).rows;
    assert.ok(audit.some((row) => afterState(row).state === 'invoked'), 'аудит finalization сохранён');
    assert.ok(
        audit.some((row) => afterState(row).state === 'delivered' && afterState(row).runState === 'succeeded'),
        'аудит доставки сохранён',
    );
});

test('9.5: recovery-вызов проходит тем же путём (reason=recovery)', async (t) => {
    guard(t);
    if (skip) return;
    await task('SC-RECOVERY');
    const source = await rowByPrompt('SC-RECOVERY');
    await doneTask('SC-RECOVERY');
    const answer = (await children(source.id)).find(
        (row) => row.kind === 'agent' && row.content.includes('RECOVERY-ANSWER'),
    );
    assert.ok(answer, 'ответ агента с recovery-директивой опубликован');
    const call = await callRow('SC-RECOVERY-QUESTION', (row) => row.state === 'delivered', 'recovery call delivered');
    assert.equal(call.reason, 'recovery');
    assert.equal(call.run_state, 'succeeded');
    const delivered = await waitUntil(
        "SELECT * FROM project_chat_messages WHERE project_id=$1 AND source_message_id=$2 AND content LIKE '%SC-ANSWER-RECOVERY%'",
        [f.projectId, answer.id],
        (row) => true,
        'recovery answer delivered to room',
    );
    assert.equal(snapshotOf(delivered).agentId, 'agent-ai-admin');
});

test('9.5: невалидный reason — директория не исполняется, строк нет, ответ агента не страдает', async (t) => {
    guard(t);
    if (skip) return;
    await task('SC-BADREASON');
    await doneTask('SC-BADREASON');
    const rows = (
        await f.pool.query("SELECT * FROM project_chat_system_calls WHERE project_id=$1 AND question=$2", [
            f.projectId,
            'SC-BADREASON-QUESTION',
        ])
    ).rows;
    assert.equal(rows.length, 0, 'невалидный reason не создаёт строку вызова');
    const messages = (
        await f.pool.query(
            "SELECT * FROM project_chat_messages WHERE project_id=$1 AND kind='agent' AND (content LIKE '%Ответ системной роли%' OR content LIKE '%Вызов системной роли%')",
            [f.projectId],
        )
    ).rows;
    assert.ok(
        messages.every((row) => !row.content.includes('SC-BADREASON-QUESTION')),
        'в комнату не попало сообщения о несуществующем вызове',
    );
});

test('9.5: неизвестная роль — rejected с actionable-ошибкой, без запуска роли', async (t) => {
    guard(t);
    if (skip) return;
    await task('SC-UNKNOWN');
    await doneTask('SC-UNKNOWN');
    const call = await callRow('SC-UNKNOWN-QUESTION', (row) => row.state === 'rejected', 'unknown role rejected');
    assert.equal(call.run_id, null, 'запуск роли не создавался');
    assert.equal(call.request_id, null);
    assert.equal(call.error, 'Системный агент не найден.');
    const rejected = (
        await f.pool.query(
            "SELECT * FROM project_chat_messages WHERE project_id=$1 AND kind='agent' AND content LIKE '%Вызов системной роли не выполнен%'",
            [f.projectId],
        )
    ).rows;
    assert.ok(rejected.length >= 1, 'actionable-ответ опубликован в комнате');
    assert.ok(rejected.some((row) => row.content.includes('Системный агент не найден.')));
    const audit = (
        await f.pool.query("SELECT * FROM security_events WHERE action='project.chat.agent.system-call' AND resource_id=$1", [
            call.call_id,
        ])
    ).rows;
    assert.ok(audit.some((row) => afterState(row).state === 'rejected' && afterState(row).error), 'аудит rejected сохранён');
});

test('9.5: невалидный JSON роли — failed после исчерпания бюджета, actionable-итог в комнате', async (t) => {
    guard(t);
    if (skip) return;
    await task('SC-BADJSON');
    await doneTask('SC-BADJSON');
    const source = await rowByPrompt('SC-BADJSON');
    const answer = (await children(source.id)).find(
        (row) => row.kind === 'agent' && row.content.includes('BADJSON-ANSWER'),
    );
    assert.ok(answer, 'ответ агента с директорией на валидную роль опубликован');
    const call = await callRow(
        'SC-BADJSON-QUESTION',
        (row) => row.state === 'failed' && row.run_state === 'failed',
        'bad-json call failed',
    );
    assert.ok(call.run_id, 'запуск роли создавался');
    assert.ok(call.delivered_at, 'неуспех доставлен и зафиксирован');
    const run = (await f.pool.query('SELECT * FROM system_role_runs WHERE id=$1', [call.run_id])).rows[0];
    assert.equal(run.state, 'failed');
    const failed = await waitUntil(
        "SELECT * FROM project_chat_messages WHERE project_id=$1 AND source_message_id=$2 AND content LIKE '%не завершён%'",
        [f.projectId, answer.id],
        (row) => true,
        'failed outcome delivered to room',
    );
    assert.ok(failed.content.includes('## Вызов системной роли «AI-админ» не завершён'));
});

test('teardown', async (t) => {
    if (skip) {
        if (container) {
            try {
                execFileSync('docker', ['rm', '-f', container], { timeout: 10000, stdio: 'pipe' });
            } catch {
                /* best effort */
            }
        }
        return;
    }
    await teardown();
});
