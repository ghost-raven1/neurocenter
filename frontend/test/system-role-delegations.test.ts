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
