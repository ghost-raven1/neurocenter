const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { LiveService } = require(path.join(process.env.GATEWAY_TEST_DIST || path.resolve('services/api-gateway/dist'),'live/live.service.js'));

for (const [method, route] of [
    ['POST', '/api/projects/prj-qa/members'],
    ['PATCH', '/api/projects/prj-qa/members/u-qa'],
    ['DELETE', '/api/projects/prj-qa/members/u-qa'],
    ['POST', '/api/platform/users'],
]) {
    test(`${method} ${route}: история узнаёт об изменении доступа без приватного payload`, () => {
        const events = [];
        const live = new LiveService();
        live.attach({ emit: (event, payload) => events.push({ event, payload }) });
        live.mutation(route, 'admin@example.invalid', { private: 'Не передавать через сокет' }, method);

        const invalidations = events.filter(item => item.event === 'section:changed');
        assert.equal(invalidations.length, 1);
        assert.ok(invalidations[0].payload.sections.includes('audit'), 'Открытая история не получила инвалидацию');
        for (const section of ['access', 'projects', 'catalog']) {
            assert.ok(invalidations[0].payload.sections.includes(section));
        }
        assert.deepEqual(Object.keys(invalidations[0].payload).sort(), ['at', 'sections']);
        assert.ok(Number.isFinite(Date.parse(invalidations[0].payload.at)));
        assert.equal(events.filter(item => item.event === 'auth:changed').length, 1);
        assert.equal(JSON.stringify(events).includes('Не передавать'), false);
    });
}

for (const [method, route] of [
    ['POST', '/api/skills'], ['PUT', '/api/skills/common/qa-audit'],
    ['DELETE', '/api/skills/common/qa-audit'], ['POST', '/api/skills/sync'], ['POST', '/api/skills/directory'],
]) {
    test(`${method} ${route}: файловый аудит обновляет историю без инструкции в сокете`, () => {
        const events = [], live = new LiveService();
        live.attach({ emit: (event, payload) => events.push({ event, payload }) });
        live.mutation(route, 'dev@localhost', { body: 'Закрытая инструкция', audit: { state: 'pending' } }, method);
        const invalidations = events.filter(item => item.event === 'section:changed');
        assert.equal(invalidations.length, 1);
        assert.deepEqual(invalidations[0].payload.sections, ['catalog', 'projects', 'audit']);
        assert.deepEqual(Object.keys(invalidations[0].payload).sort(), ['at', 'sections']);
        assert.equal(JSON.stringify(events).includes('Закрытая инструкция'), false);
        assert.equal(events.some(item => item.event === 'auth:changed'), false);
    });
}
