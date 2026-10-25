import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('antd', async () => {
    const { createElement } = await import('react');
    const text = (props: any) => createElement('p', null, props.children);
    return { Typography: { Title: text, Paragraph: text, Text: text }, Alert: (props: any) => createElement('div', { role: 'alert' }, props.message) };
});
import { RoleDelegations } from '../src/features/SystemRoles/RoleDelegations';
it('shows the successful answer beside the independent failure and retains the actionable recommendation', () => {
    const html = renderToStaticMarkup(createElement(RoleDelegations, { delegations: [
        { roleId: 'agent-ai-admin', state: 'failed', message: 'Роль недоступна. Проверьте настройки.' },
        { roleId: 'agent-autoconfigurator', state: 'succeeded', result: { kind: 'proposal', summary: 'Промпт можно уточнить.', findings: [], nextSteps: ['Проверьте предложение.'],
            changes: [{ targetKey: 'prompt:selected', replacement: 'Уточнённый текст промпта.', explanation: 'Явно указан нужный результат.' }] } },
    ] }));
    expect(html).toContain('AI-админ · ответ недоступен'); expect(html).toContain('Автоконфигуратор · ответ получен');
    expect(html).toContain('Роль недоступна. Проверьте настройки.'); expect(html).toContain('Уточнённый текст промпта.');
    expect(html).toContain('Применение изменений выполняется отдельным подтверждённым действием.');
});
it('keeps a child source attached to its own answer and distinguishes shared diagnostic facts', () => {
    const html = renderToStaticMarkup(createElement(RoleDelegations, { diagnosticIds: ['fact-one'], delegations: [
        { roleId: 'agent-ai-admin', state: 'succeeded', result: { kind: 'diagnosis', summary: 'Первый ответ.', findings: [{ evidenceId: 'source-a', detail: 'По базе знаний.' }, { evidenceId: 'fact-one', detail: 'По измерению.' }], nextSteps: [], changes: [],
            projectContext: { status: 'ready', project: { id: 'prj-one', name: 'Мой проект' }, sources: [{ id: 'source-a', path: 'docs/child-a.md', startLine: 8 }] } } },
        { roleId: 'agent-packager', state: 'succeeded', result: { kind: 'diagnosis', summary: 'Второй ответ.', findings: [{ evidenceId: 'source-a', detail: 'Нет собственной квитанции.' }], nextSteps: [], changes: [] } },
    ] }));
    const second = html.indexOf('<summary>Упаковщик'), firstChild = html.slice(0, second), secondChild = html.slice(second);
    expect(firstChild).toContain('Источник базы знаний:'); expect(firstChild).toContain('docs/child-a.md'); expect(firstChild).toContain('строка 8'); expect(firstChild).toContain('ID измерения: fact-one');
    expect(secondChild).toContain('Основание (ID): source-a'); expect(secondChild).not.toContain('docs/child-a.md'); expect(secondChild).not.toContain('Источник базы знаний:');
});
