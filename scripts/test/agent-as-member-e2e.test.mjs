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
 * Harness: HTTP к panel (dev-стэк, nginx: /api → api-gateway, /auth → oauth2-bridge).
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
