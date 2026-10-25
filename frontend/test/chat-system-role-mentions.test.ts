import {expect, it} from 'vitest';
import {chatSystemRoleMention} from '../src/features/ChatSystemRoles/mentions';

it.each([
    ['@Индексатор проверь знания', 'agent-indexer', 'проверь знания'],
    ['@sys-ai-admin проверь площадку', 'agent-ai-admin', 'проверь площадку'],
    ['Проверь @Упаковщик, исходники', 'agent-packager', 'Проверь , исходники'],
])('opens exactly one system task for %s without ordinary recipients', (body, agentId, instruction) => {
    expect(chatSystemRoleMention(body)).toEqual({agentId, instruction});
});
it('ignores quoted code, email addresses and ordinary conversation text', () => {
    for (const body of ['Пишите a@Индексатор.test', '`@Индексатор` пример', '```\n@sys-indexer\n```', 'Обычное сообщение', '@reviewer вопрос']) {
        expect(chatSystemRoleMention(body)).toEqual({instruction: body});
    }
});
it('does not silently mix system work, ordinary recipients or multiple paid role tasks', () => {
    expect(chatSystemRoleMention('@sys-indexer @reviewer проверь')).toMatchObject({error: expect.stringContaining('отдельно')});
    expect(chatSystemRoleMention('@Индексатор @Упаковщик проверь')).toMatchObject({error: expect.stringContaining('одного')});
});
it('requires an explicit system alias when an editable participant has the same display name', () => {
    const participant = {agentId: 'ordinary', slug: 'reviewer', name: 'Индексатор', status: 'active' as const};
    expect(chatSystemRoleMention('@Индексатор проверь', [participant])).toMatchObject({error: expect.stringContaining('@sys-indexer')});
    expect(chatSystemRoleMention('@sys-indexer проверь', [participant])).toMatchObject({agentId: 'agent-indexer', instruction: 'проверь'});
});
