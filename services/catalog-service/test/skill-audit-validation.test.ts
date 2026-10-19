import { describe, expect, it } from 'vitest';

import { normalizeSkillAuditEvents } from '../../shared/skill-audit.cjs';

const state = { generation: 'generation-1', version: 1, sha256: 'a'.repeat(64) };
const event = { id: 'f152907a-d9ab-45db-bfe1-6eac870ac624', at: '2026-10-18T14:00:00.000Z', actor: 'user@example.test',
    action: 'skill.create', resourceId: 'shared/example-skill', source: 'editor', before: null, after: state };

describe('Контракт безопасных сводок аудита скиллов', () => {
    it('Принимает три действия и служебного исполнителя, не меняя сводки', () => {
        const events = [event, { ...event, id: 'a152907a-d9ab-45db-bfe1-6eac870ac624', action: 'skill.update', before: state,
            after: { ...state, version: 2 }, source: 'sync', actor: 'skills-service' },
        { ...event, id: 'b152907a-d9ab-45db-bfe1-6eac870ac624', action: 'skill.delete', before: state, after: null, source: 'bootstrap' }];
        expect(normalizeSkillAuditEvents({ events })).toEqual(events);
    });

    it('Канонизирует UUID и допускает точный повтор без изменения числа подтверждений', () => {
        const normalized = normalizeSkillAuditEvents({ events: [{ ...event, id: event.id.toUpperCase() }, event] });
        expect(normalized).toEqual([event, event]);
    });

    it('Папка имеет отдельное действие и безопасный маркер вместо выдуманной версии', () => {
        const directory = { ...event, action: 'skill.directory.create', resourceId: 'shared/team/tools', after: { directory: true } };
        expect(normalizeSkillAuditEvents({ events: [directory] })).toEqual([directory]);
    });

    it.each([
        { before: state }, { after: state }, { after: null }, { after: { directory: false } },
        { after: { directory: true, body: 'Закрытый текст' } }, { source: 'sync' }, { source: 'bootstrap' },
        { resourceId: 'shared/../tools' }, { resourceId: 'shared/tools.md' },
    ])('Проверяет отдельный контракт папки до записи: %j', patch => {
        expect(() => normalizeSkillAuditEvents({ events: [{ ...event, action: 'skill.directory.create', after: { directory: true }, ...patch }] })).toThrow();
    });

    it('Сохраняет исполнителя dev@localhost и отвергает пробелы, управляющие символы и неверный @', () => {
        expect(normalizeSkillAuditEvents({ events: [{ ...event, actor: 'dev@localhost' }] })[0].actor).toBe('dev@localhost');
        for (const actor of ['dev @localhost', 'dev@local host', 'dev@localhost\u0000', 'devlocalhost', '@localhost', 'dev@', 'dev@@localhost']) {
            expect(() => normalizeSkillAuditEvents({ events: [{ ...event, actor }] })).toThrow();
        }
    });

    it('Один UUID с разными данными отвергает до записи', () => {
        expect(() => normalizeSkillAuditEvents({ events: [event, { ...event, actor: 'other@example.test' }] })).toThrow('разные данные');
    });

    it('Пустой пакет разрешён, пакет свыше 200 событий отвергается', () => {
        expect(normalizeSkillAuditEvents({ events: [] })).toEqual([]);
        expect(normalizeSkillAuditEvents({ events: Array(200).fill(event) })).toHaveLength(200);
        expect(() => normalizeSkillAuditEvents({ events: Array(201).fill(event) })).toThrow();
    });

    it.each([null, [], {}, { events: event }, { events: [], actor: 'admin@example.test' }])('Проверяет контейнер пакета: %j', raw => {
        expect(() => normalizeSkillAuditEvents(raw)).toThrow();
    });

    it.each([
        { body: 'Закрытый текст скилла' }, { name: 'Название' }, { resources: [] }, { dependencies: [] },
        { id: 'not-a-uuid' }, { at: '2026-10-18T14:00:00Z' }, { at: '2026-02-30T14:00:00.000Z' },
        { actor: '' }, { actor: 'administrator' }, { actor: 'user@example.test\nspoofed' }, { actor: `${'x'.repeat(250)}@x.test` },
        { action: 'plugin.delete' }, { source: 'unknown' }, { resourceId: '' }, { resourceId: 'shared/../example' },
        { resourceId: 'shared/Example' }, { resourceId: 'shared/example.md' }, { resourceId: '/shared/example' }, { resourceId: 'a'.repeat(241) },
        { after: { ...state, body: 'Закрытый текст' } }, { after: { ...state, generation: '' } },
        { after: { ...state, generation: 'a'.repeat(129) } }, { after: { ...state, generation: 'bad\u0000generation' } },
        { after: { ...state, version: 0 } }, { after: { ...state, version: 1.5 } },
        { after: { ...state, sha256: 'invalid' } }, { after: { ...state, sha256: 'A'.repeat(64) } },
        { before: state }, { after: null }, { action: 'skill.update', before: null },
        { action: 'skill.delete', before: state, after: state },
    ])('Отвергает запрещённое поле или некорректную сводку: %j', patch => {
        expect(() => normalizeSkillAuditEvents({ events: [{ ...event, ...patch }] })).toThrow();
    });

    it('Проверяет отсутствующие поля и неверную форму до обработки следующего события', () => {
        const { actor: _actor, ...missing } = event;
        expect(() => normalizeSkillAuditEvents({ events: [missing] })).toThrow();
        expect(() => normalizeSkillAuditEvents({ events: [event, null] })).toThrow();
    });
});
