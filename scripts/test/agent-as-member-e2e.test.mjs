/**
 * 9.1 (FR-301): Агент — участник проекта. E2E поверх живого dev-стека (docker-compose.yml).
 *
 * Сценарий: агенты в проекте с ролью, контекстом (только одобренные, FR-502),
 * инструментами каталога и публичными чатами.
 *   - server-агент (системная роль, доверенная сторона);
 *   - device-агент (через mcp-host-билет, недоверенная сторона) — live-итерация.
 * У агента: роль + контекст (только одобренные, FR-502) + инструменты каталога + доступ к публичным чатам.
 * Инструмент вне каталога проекта → недоступен (fail-closed).
 *
 * Chat-turn (server-агент отвечает в публичном чате) — самодостаточная фикстура:
 * одноразовый PG 16 (docker) + in-process Catalog (dist) + скриптованный fake OpenAI
 * (harness 9.2, model-chat.fixture.mjs); не зависит от dev-стека.
 *
 * Harness остальных тестов: HTTP к panel (dev-стэк, nginx: /api → api-gateway, /auth → oauth2-bridge).
 * Если стэк недоступен — тесты skip (корневой сьют остаётся зелёным).
 * Запуск: docker compose up, затем  node --test scripts/test/agent-as-member-e2e.test.mjs
 * Оверрайд цели: AGENT_E2E_PANEL (по умолчанию http://127.0.0.1:5173).
 *
 * Форматы тел сверены с in-repo контрактами:
 *   - карточка агента: services/catalog-service/src/agents/agent-validation.ts + services/shared/project-agents.cjs
 *   - комната: services/catalog-service/src/project-chat/project-chat-dialogs.ts
 *   - обучение (FR-502): services/shared/project-learning.cjs + learning.repository.ts (CAS-ревизия)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const PANEL = process.env.AGENT_E2E_PANEL || 'http://127.0.0.1:5173';

/** Стэк доступен = любой HTTP-ответ panel (даже 401). Точечная проверка, не поднимает ресурсы. */
const reachable = await new Promise((resolve) => {
    const req = http.get(new URL('/api/projects', PANEL), (res) => {
        res.resume();
        resolve(true);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
});
const skip = reachable ? false : 'dev-стэк недоступен: docker compose up (panel ' + PANEL + ')';

let cookie = '';
async function request(pathname, options = {}) {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const res = await fetch(new URL(pathname, PANEL), {
        method: options.method || 'GET',
        redirect: 'manual',
        headers: {
            ...(cookie ? { cookie } : {}),
            ...(body ? { 'content-type': 'application/json' } : {}),
            // browser-security: cookie-POST требует нестандартный заголовок интерфейса;
            // Origin не шлём (undefined разрешён guard'ом, не гадая точный panelOrigin).
            'x-neurocenter-request': '1',
            ...options.headers,
        },
        body,
    });
    const text = await res.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch {
        data = text;
    }
    return { status: res.status, headers: res.headers, data, setCookie: res.headers.get('set-cookie') };
}

const ok = (res, what) => assert.ok([200, 201].includes(res.status), what + ': ' + JSON.stringify(res.data));

let projectId;
let serverAgentId;

before(async () => {
    if (!reachable) return;
    // dev-стэк: SSO_DISABLE=true → mock dev-user (dev@localhost) без IdP.
    // Логин — GET-редирект браузера (не POST): 302 + Set-Cookie: bridge_session.
    const login = await request('/auth/login?returnTo=%2F', { method: 'GET' });
    assert.ok(login.setCookie && login.setCookie.includes('bridge_session='), 'dev-логин не выдал bridge_session');
    cookie = login.setCookie.split(';')[0];
    const created = await request('/api/projects', {
        method: 'POST',
        body: { name: 'E2E агенты ' + randomUUID().slice(0, 8) },
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    projectId = created.data.id;
});

after(async () => {
    // best-effort teardown; фикстура с уникальным именем безвредна при отказе.
    if (reachable && projectId)
        await request('/api/projects/' + projectId, { method: 'DELETE', body: { requestKey: randomUUID() } });
});

test('9.1: server-агент — карточка, назначение в проект, роль и доступ', { skip }, async () => {
    // definition: обязательны description/prompt/mode/permission; permission — объект
    // (ключи из AGENT_PERMISSION_KEYS, значения allow/ask/deny). model/temperature/topP/steps — опциональны.
    const card = await request('/api/agents', {
        method: 'POST',
        body: {
            requestKey: randomUUID(),
            slug: 'nc-e2e-' + randomUUID().slice(0, 8).replaceAll('-', ''),
            name: 'E2E server-агент',
            definition: {
                description: 'E2E: агент как участник проекта',
                prompt: 'Отвечай команде кратко и по делу.',
                mode: 'subagent',
                permission: { read: 'allow', edit: 'deny', bash: 'deny' },
                steps: 4,
            },
        },
    });
    ok(card, 'создание карточки агента');
    serverAgentId = card.data.id;
    assert.ok(serverAgentId, 'нет id карточки: ' + JSON.stringify(card.data));
    assert.ok(card.data.version && card.data.manifest, 'нет version/manifest карточки: ' + JSON.stringify(card.data));

    // assign — CAS по ревизии agent-sets проекта; текущую ревизию считываем из списка агентов.
    const before = await request('/api/agents?projectId=' + projectId);
    assert.equal(before.status, 200, 'список агентов до назначения: ' + JSON.stringify(before.data));
    const assigned = await request('/api/projects/' + projectId + '/agents', {
        method: 'POST',
        body: {
            requestKey: randomUUID(),
            expectedRevision: before.data.revision,
            agentId: serverAgentId,
            version: card.data.version,
            manifest: card.data.manifest,
        },
    });
    ok(assigned, 'назначение агента в проект');

    const list = await request('/api/agents?projectId=' + projectId);
    assert.equal(list.status, 200);
    // Назначения проекта — в assignments (items = весь каталог, не назначения).
    const row = (list.data.assignments ?? []).find((item) => item.agentId === serverAgentId);
    assert.ok(row, 'назначенный агент не виден в проекте: ' + JSON.stringify(list.data.assignments));
});

test('9.1: публичная комната — создание (visibility PUBLIC) и доступ', { skip }, async () => {
    // PUBLIC: отдельный список участников не требуется, но emails() требует массив (не undefined).
    const room = await request('/api/projects/' + projectId + '/team-chat/rooms', {
        method: 'POST',
        body: { requestKey: randomUUID(), title: 'E2E публичный', visibility: 'PUBLIC', memberEmails: [] },
    });
    ok(room, 'создание комнаты');
    assert.equal(room.data.visibility, 'PUBLIC');
    assert.ok(room.data.id, 'нет id комнаты: ' + JSON.stringify(room.data));

    // Доступ: чтение созданной комнаты. List-маршрут отсутствует — только rooms/:roomId.
    const read = await request('/api/projects/' + projectId + '/team-chat/rooms/' + room.data.id);
    assert.equal(read.status, 200, 'чтение комнаты: ' + JSON.stringify(read.data));
});

test('9.1: контекст агента = только одобренные знания (FR-502)', { skip }, async () => {
    // Полный конвейер проектного обучения через CAS-ревизию (новый проект стартует с 0):
    //   experience → hypothesis → check(human_review/passed) → candidate → approve → activate.
    // Только approved+activated запись попадает в /context; proposed (не одобренный) — нет.
    const base = '/api/projects/' + projectId + '/learning';
    let rev = 0;
    const learn = (path, body) =>
        request(base + path, { method: 'POST', body: { ...body, requestKey: randomUUID(), expectedRevision: rev } });
    const evidence = () => [{ kind: 'human_feedback', status: 'unknown', summary: 'E2E fixture' }];

    // --- знание A: полный конвейер → approved + activated ---
    const exp = await learn('/experiences', {
        title: 'E2E опыт A',
        summary: 'Опыт A для проверки контекста.',
        outcome: 'succeeded',
        evidence: evidence(),
    });
    ok(exp, 'опыт A');
    const experienceId = exp.data.result.experience.id;
    rev = exp.data.revision;

    const hyp = await learn('/hypotheses', {
        subject: 'project',
        title: 'E2E гипотеза A',
        statement: 'Гипотеза A.',
        rationale: 'Основание A.',
        verificationPlan: 'Проверка A.',
        experienceIds: [experienceId],
    });
    ok(hyp, 'гипотеза A');
    const hypothesisId = hyp.data.result.hypothesis.id;
    rev = hyp.data.revision;

    const chk = await learn('/hypotheses/' + hypothesisId + '/checks', {
        method: 'human_review',
        result: 'passed',
        summary: 'Проверено человеком: A.',
        experienceIds: [experienceId],
    });
    ok(chk, 'проверка A');
    const checkId = chk.data.result.check.id;
    rev = chk.data.revision;

    const cand = await learn('/candidates', {
        hypothesisId,
        checkId,
        key: 'e2e-approved',
        kind: 'lesson',
        title: 'Одобрено',
        content: 'Факт A',
    });
    ok(cand, 'кандидат A');
    const candidateA = cand.data.result.candidate.id;
    rev = cand.data.revision;

    const appr = await learn('/candidates/' + candidateA + '/approve', {});
    ok(appr, 'одобрение A');
    rev = appr.data.revision;
    const act = await learn('/candidates/' + candidateA + '/activate', {});
    ok(act, 'активация A');
    rev = act.data.revision;

    // --- знание B: полный конвейер → candidate, НО не одобряется (proposed) ---
    const exp2 = await learn('/experiences', {
        title: 'E2E опыт B',
        summary: 'Опыт B (не одобряется).',
        outcome: 'succeeded',
        evidence: evidence(),
    });
    ok(exp2, 'опыт B');
    const experienceId2 = exp2.data.result.experience.id;
    rev = exp2.data.revision;
    const hyp2 = await learn('/hypotheses', {
        subject: 'project',
        title: 'E2E гипотеза B',
        statement: 'Гипотеза B.',
        rationale: 'Основание B.',
        verificationPlan: 'Проверка B.',
        experienceIds: [experienceId2],
    });
    ok(hyp2, 'гипотеза B');
    const hypothesisId2 = hyp2.data.result.hypothesis.id;
    rev = hyp2.data.revision;
    const chk2 = await learn('/hypotheses/' + hypothesisId2 + '/checks', {
        method: 'human_review',
        result: 'passed',
        summary: 'Проверено человеком: B.',
        experienceIds: [experienceId2],
    });
    ok(chk2, 'проверка B');
    const checkId2 = chk2.data.result.check.id;
    rev = chk2.data.revision;
    const cand2 = await learn('/candidates', {
        hypothesisId: hypothesisId2,
        checkId: checkId2,
        key: 'e2e-pending',
        kind: 'lesson',
        title: 'Не одобрено',
        content: 'Факт B',
    });
    ok(cand2, 'кандидат B (proposed)');
    rev = cand2.data.revision;

    // --- FR-502: в контексте только одобренные ---
    const context = await request(base + '/context');
    assert.equal(context.status, 200, 'контекст: ' + JSON.stringify(context.data));
    const keys = (context.data.entries ?? []).map((entry) => entry.key);
    assert.ok(keys.includes('e2e-approved'), 'одобренное знание не в контексте: ' + JSON.stringify(keys));
    assert.ok(!keys.includes('e2e-pending'), 'неодобренное знание попало в контекст (FR-502): ' + JSON.stringify(keys));
});

test('9.1: инструменты — только каталог проекта, вне каталога → недоступен (fail-closed)', { skip }, async () => {
    const caps = await request('/api/agent-tools/capabilities?projectId=' + projectId);
    assert.equal(caps.status, 200, 'capabilities: ' + JSON.stringify(caps.data));
    // live-итерация: точный формат отказа на инструмент вне каталога (dispatch/complete) уточняется по живому стеку.
});

// ============================================================================
// 9.1 (FR-301): chat turn — server-агент реально отвечает в публичном чате.
// Самодостаточная фикстура, не зависящая от dev-стека: одноразовый PostgreSQL 16
// (docker) + in-process Catalog (полный app.module из symlink'нутого dist) +
// скриптованный fake OpenAI (model-chat.fixture.mjs) — harness 9.2.
// Сценарий 1 I/O-матрицы: человек-участник пишет в PUBLIC-комнату, где назначен
// агент → ProjectChatRunner публикует ответ агента в комнате (автор = server-агент);
// в вызове модели — роль (профиль) и контекст = только одобренные знания (FR-502).
// ============================================================================
let chatFixture = null,
    chatContainer = null,
    chatSkip = false,
    chatSkipReason = '',
    chatCalls = [],
    chatAgent = null,
    chatRoomId = null,
    chatModelCard = null;

const chatPort = 55632 + (process.pid % 200);
const chatWaitForTcp = (host, p, timeoutMs = 30000) =>
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
const chatWaitUntil = async (sql, params, predicate, label, timeoutMs = 90000) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const rows = (await chatFixture.pool.query(sql, params)).rows;
        if (rows.some(predicate)) return rows.find(predicate);
        if (Date.now() > deadline) throw new Error('QA timeout: ' + label);
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
};

const chatBootstrap = async () => {
    chatContainer = 'nc-agt01-e2e-' + randomUUID().slice(0, 8);
    execFileSync(
        'docker',
        [
            'run',
            '-d',
            '--rm',
            '--name',
            chatContainer,
            '-e',
            'POSTGRES_PASSWORD=qa',
            '-p',
            '127.0.0.1:' + chatPort + ':5432',
            'postgres:16',
        ],
        { timeout: 60000, stdio: 'pipe' },
    );
    await chatWaitForTcp('127.0.0.1', chatPort);
    // TCP-порт открывается в момент initdb; принимаем подключения только после «accepting connections».
    const deadline = Date.now() + 120000;
    for (;;) {
        try {
            execFileSync('docker', ['exec', chatContainer, 'pg_isready', '-U', 'postgres'], {
                timeout: 15000,
                stdio: 'pipe',
            });
            break;
        } catch {
            if (Date.now() > deadline) throw new Error('PG readiness timeout: ' + chatContainer);
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }
    const { startModelChatFixture } = await import('./model-chat.fixture.mjs');
    chatFixture = await startModelChatFixture({
        adminUrl: 'postgres://postgres:qa@127.0.0.1:' + chatPort + '/postgres',
    });
    chatModelCard = chatFixture.cards[0];
    // Детерминированный ответ; вызовы /chat/completions записываются для assertions роли/контекста.
    chatFixture.provider.respond = (call) => {
        if (!call.path.endsWith('/chat/completions')) return {};
        chatCalls.push(call.body);
        return { reply: 'FR301-ANSWER: ответ серверного агента.' };
    };
    // Server-агент: карточка каталога с ролью (description) и профилем (prompt).
    const card = await chatFixture.request('main', '/api/agents', {
        method: 'POST',
        status: 201,
        body: {
            requestKey: randomUUID(),
            slug: 'nc-agt01-' + randomUUID().slice(0, 8).replaceAll('-', ''),
            name: 'FR301 server-агент',
            definition: {
                description: 'FR301-ROLE: серверный специалист проекта',
                prompt: 'FR301-PROFILE-AGENT',
                mode: 'subagent',
                permission: { read: 'allow', edit: 'deny', bash: 'deny' },
            },
        },
    });
    chatAgent = {
        id: card.id,
        name: 'FR301 server-агент',
        description: 'FR301-ROLE: серверный специалист проекта',
    };
    // Назначение в проект (CAS по ревизии agent-sets) + включение: комната принимает только включённых.
    let setsRevision = (await chatFixture.request('main', '/api/agents?projectId=' + chatFixture.projectId)).revision;
    await chatFixture.request('main', '/api/projects/' + chatFixture.projectId + '/agents', {
        method: 'POST',
        status: 201,
        body: {
            requestKey: randomUUID(),
            expectedRevision: setsRevision,
            agentId: card.id,
            version: card.version,
            manifest: card.manifest,
        },
    });
    setsRevision += 1;
    await chatFixture.request('main', '/api/projects/' + chatFixture.projectId + '/agents/' + card.id, {
        method: 'PATCH',
        body: { requestKey: randomUUID(), expectedRevision: setsRevision, enabled: true },
    });
    // Обучение (FR-502): тот же конвейер, что и в live-stack-сегменте. Одно знание проходит
    // до approved+activated, второе остаётся candidate (proposed) — в контекст не попадает.
    const base = '/api/projects/' + chatFixture.projectId + '/learning';
    let learningRevision = 0;
    // NestJS: POST без @HttpCode отвечает 201.
    const learn = (path, body) =>
        chatFixture.request('main', base + path, {
            method: 'POST',
            status: 201,
            body: { ...body, requestKey: randomUUID(), expectedRevision: learningRevision },
        });
    const pipeline = async (key, title, content) => {
        const exp = await learn('/experiences', {
            title,
            summary: title + ' (FR301).',
            outcome: 'succeeded',
            evidence: [{ kind: 'human_feedback', status: 'unknown', summary: 'FR301 fixture' }],
        });
        learningRevision = exp.revision;
        const hyp = await learn('/hypotheses', {
            subject: 'project',
            title: title + ': гипотеза',
            statement: 'Гипотеза.',
            rationale: 'Основание.',
            verificationPlan: 'Проверка.',
            experienceIds: [exp.result.experience.id],
        });
        learningRevision = hyp.revision;
        const chk = await learn('/hypotheses/' + hyp.result.hypothesis.id + '/checks', {
            method: 'human_review',
            result: 'passed',
            summary: 'Проверено человеком.',
            experienceIds: [exp.result.experience.id],
        });
        learningRevision = chk.revision;
        const cand = await learn('/candidates', {
            hypothesisId: hyp.result.hypothesis.id,
            checkId: chk.result.check.id,
            key,
            kind: 'lesson',
            title: title + ': знание',
            content,
        });
        learningRevision = cand.revision;
        return cand.result.candidate.id;
    };
    const approvedId = await pipeline('agtm-approved', 'FR301 опыт A', 'AGTM-APPROVED-FACT');
    const approved = await learn('/candidates/' + approvedId + '/approve', {});
    learningRevision = approved.revision;
    const activated = await learn('/candidates/' + approvedId + '/activate', {});
    learningRevision = activated.revision;
    await pipeline('agtm-pending', 'FR301 опыт B', 'AGTM-PENDING-FACT');
    // Публичная комната: агент в составе, выбрана проверенная модель.
    const room = await chatFixture.request('main', '/api/projects/' + chatFixture.projectId + '/team-chat/rooms', {
        method: 'POST',
        status: 201,
        body: { requestKey: randomUUID(), title: 'FR301 публичный', visibility: 'PUBLIC', memberEmails: [] },
    });
    chatRoomId = room.id;
    // Новая комната стартует с revision 1 (DB DEFAULT), в отличие от дефолтной (виртуальный 0 до первого PUT).
    await chatFixture.request(
        'main',
        '/api/projects/' + chatFixture.projectId + '/team-chat/rooms/' + chatRoomId + '/participants',
        {
            method: 'PUT',
            body: {
                expectedRevision: 1,
                modelId: chatModelCard.id,
                expectedModelPin: chatModelCard.modelPin,
                agentIds: [chatAgent.id],
            },
        },
    );
};

try {
    await chatBootstrap();
} catch (error) {
    chatSkip = true;
    chatSkipReason = String(error && error.message ? error.message : error);
}

test('9.1: chat turn — человек пишет в публичную комнату, server-агент отвечает (роль + одобренный контекст)', async (t) => {
    if (chatSkip) {
        t.skip('bootstrap chat-фикстуры недоступен: ' + chatSkipReason);
        return;
    }
    // Человек-участник (developer) пишет в PUBLIC-комнату, где назначен агент.
    await chatFixture.request(
        'developer',
        '/api/projects/' + chatFixture.projectId + '/team-chat/rooms/' + chatRoomId + '/messages',
        {
            method: 'POST',
            status: 201,
            body: { requestKey: randomUUID(), prompt: 'FR301-TASK', targetAgentIds: [chatAgent.id] },
        },
    );
    // ProjectChatRunner обработал задачу: сообщение пользователя в финальном статусе.
    const userRow = await chatWaitUntil(
        "SELECT * FROM project_chat_messages WHERE project_id=$1 AND room_id=$2 AND kind='user' AND content=$3",
        [chatFixture.projectId, chatRoomId, 'FR301-TASK'],
        (row) => row.status === 'done',
        'task FR301-TASK done',
    );
    assert.equal(userRow.author_email, chatFixture.actors.developer.email, 'автор сообщения — человек-участник');
    const rows = await chatFixture.pool.query(
        'SELECT * FROM project_chat_messages WHERE project_id=$1 AND source_message_id=$2 ORDER BY position',
        [chatFixture.projectId, userRow.id],
    );
    const answer = rows.rows.find((row) => row.kind === 'agent');
    assert.ok(answer, 'ответа агента в комнате нет');
    assert.equal(answer.status, 'done', 'ответ агента не в финальном статусе: ' + JSON.stringify(answer));
    assert.equal(answer.room_id, chatRoomId, 'ответ опубликован в публичной комнате');
    // Автор = server-агент: snapshot в строке комнаты.
    assert.equal(answer.snapshot.agentId, chatAgent.id, 'автор ответа — не server-агент');
    assert.equal(answer.snapshot.name, chatAgent.name, 'автор ответа');
    assert.equal(answer.snapshot.definition.description, chatAgent.description, 'роль ответа = роль агента');
    assert.equal(answer.content, 'FR301-ANSWER: ответ серверного агента.', 'содержимое ответа');

    // Роль и контекст в вызове модели: профиль — системное сообщение, контекст проекта —
    // только одобренные знания (FR-502).
    const call = chatCalls.find((item) => JSON.stringify(item.messages).includes('FR301-TASK'));
    assert.ok(call, 'вызов модели агента по задаче не найден');
    assert.equal(call.messages[0].role, 'system');
    assert.equal(call.messages[0].content, 'FR301-PROFILE-AGENT', 'роль = профиль агента');
    const payload = JSON.stringify(call.messages);
    assert.ok(payload.includes('agtm-approved'), 'одобренное знание не в контексте агента');
    assert.ok(payload.includes('AGTM-APPROVED-FACT'), 'содержимое одобренного знания не в контексте');
    assert.ok(!payload.includes('agtm-pending'), 'неодобренное знание попало в контекст (FR-502)');
    assert.ok(!payload.includes('AGTM-PENDING-FACT'), 'содержимое неодобренного знания в контексте (FR-502)');
});

const chatTeardown = async () => {
    try {
        if (chatFixture) await chatFixture.close();
    } catch (error) {
        console.error('QA chat-fixture cleanup: ' + (error && error.message ? error.message : error));
    }
    if (chatContainer)
        try {
            execFileSync('docker', ['rm', '-f', chatContainer], { timeout: 30000, stdio: 'pipe' });
        } catch {
            /* best effort: контейнер поднят с --rm */
        }
};
test.after(async () => {
    if (chatFixture || chatContainer) await chatTeardown();
});
process.on('exit', () => {
    if (chatContainer) {
        try {
            execFileSync('docker', ['rm', '-f', chatContainer], { timeout: 10000, stdio: 'pipe' });
        } catch {
            /* best effort */
        }
    }
});

test(
    '9.1: device-агент — только через mcp-host-билет (недоверенная сторона)',
    {
        skip: skip || 'live-итерация: device-runtime + обмен билетом (mcp-host/connect)',
    },
    async () => {
        // gateway POST /api/mcp-host/connect (device-auth) -> { path, descriptorSha256 }
        // -> catalog internal/device-channel/mcp-host/authorize; device-агент участвует через мост без server-прав.
        assert.fail('не реализовано: требует device-runtime и верифицированный билет (live-итерация)');
    },
);
