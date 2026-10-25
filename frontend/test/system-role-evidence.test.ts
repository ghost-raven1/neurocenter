import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it, vi } from 'vitest';
import type { RoleProjectContextReceipt, RoleResult, RoleRun } from '../src/features/SystemRoles/types';
import type { ServiceTurn } from '../src/features/SystemRoleChat/types';

const h = vi.hoisted(() => ({ enabled: true }));
vi.mock('antd', async () => {
    const { createElement } = await import('react'), { modalAntd, modalUi } = await import('./modal-actions.fixture');
    const ui = modalAntd(modalUi(), createElement);
    return { ...ui, Typography: { ...ui.Typography, Title: ui.Typography.Text } };
});
vi.mock('../src/features/SystemRoles/IndexerOwnerActions', () => ({ IndexerOwnerActions: () => null }));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({ useFeatureAvailability: () => ({ enabled: h.enabled, reason: 'Функция выключена' }) }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => ({ captureOwner: () => () => true }) }));
import { RoleRunContent } from '../src/features/SystemRoles/RoleRunContent';
import { RoleProjectContextPreview } from '../src/features/SystemRoles/RoleProjectContext';
import { ServiceTurnContent } from '../src/features/SystemRoleChat/ServiceTurnContent';

const context = (overrides: Partial<RoleProjectContextReceipt> = {}): RoleProjectContextReceipt => ({
    status: 'ready', project: { id: 'prj-one', name: 'Проект' }, generation: 'generation-one', snapshot: 'snapshot-one',
    sources: [{ id: 'rag-source', path: 'docs/runbook.md', title: 'Инструкция', startLine: 12, endLine: 16 }], ...overrides,
});
const result = (overrides: Partial<RoleResult> = {}): RoleResult => ({
    kind: 'diagnosis', summary: 'Проверка завершена.', findings: [{ evidenceId: 'rag-source', detail: 'Сначала проверьте конфигурацию.' }], nextSteps: [], changes: [], ...overrides,
});
const run = (answer: RoleResult): RoleRun => ({
    id: 'run-one', agentId: 'agent-coordinator', projectId: 'prj-one', actor: 'alice', state: 'succeeded', phase: 'completed', revision: 1, operationId: 'operation-one', message: 'Ответ сохранён.',
    createdAt: '2026-10-25T00:00:00Z', finishedAt: '2026-10-25T00:00:01Z', callsStarted: 2, modelId: 'model-one', modelPin: 'a'.repeat(64),
    facts: [{ id: 'fact-one', kind: 'health', checkedAt: '2026-10-25T00:00:00Z', status: 'measured', data: { ready: true } }], result: answer,
    steps: [], applied: [], targets: [], canApply: false, canRollback: false, canCancel: false,
});
const render = (answer: RoleResult) => renderToStaticMarkup(createElement(RoleRunContent, { run: run(answer) }));
beforeEach(() => { h.enabled = true; });

it('explains absent grants and missing snapshots without blocking the ordinary answer or inventing a flag reason', () => {
    const ordinary = renderToStaticMarkup(createElement(RoleProjectContextPreview));
    expect(ordinary).toContain('Поиск по базе знаний в этот запуск не включён; обычный ответ доступен.'); expect(ordinary).not.toContain('выключен');
    const missing = renderToStaticMarkup(createElement(RoleProjectContextPreview, { context: { scope: 'project-index', projectId: 'prj-one', projectName: 'Проект', identity: 'index-one', recipients: ['agent-ai-admin'] } }));
    expect(missing).toContain('Полного снимка пока нет; роль ответит по доступным сведениям.'); expect(missing).toContain('Фрагменты могут получить: AI-админ.');
});

it('relates each finding to a readable delivered path and lines while keeping diagnostic IDs separate', () => {
    const html = render(result({ projectContext: context(), findings: [
        { evidenceId: 'rag-source', detail: 'Проверьте инструкции.' }, { evidenceId: 'fact-one', detail: 'Каталог готов.' },
    ] }));
    expect(html).toContain('Проверьте инструкции.'); expect(html).toContain('Источник базы знаний:'); expect(html).toContain('docs/runbook.md'); expect(html).toContain('строки 12–16');
    expect(html).toContain('ID измерения: fact-one'); expect(html).toContain('ID источника: rag-source'); expect(html).toContain('передано источников: 1');
    expect(html).toContain('<details><summary>Источники базы знаний и снимок</summary>'); expect(html).toContain('generation-one'); expect(html).toContain('snapshot-one');
});

it('renders hostile paths and titles as escaped text without creating executable links or HTML', () => {
    const html = render(result({ projectContext: context({ sources: [{ id: 'rag-source', path: 'javascript:alert(1)<img src=x onerror=alert(2)>', title: '<script>alert(3)</script>', startLine: 4 }] }) }));
    expect(html).toContain('javascript:alert(1)&lt;img src=x onerror=alert(2)&gt;'); expect(html).toContain('&lt;script&gt;alert(3)&lt;/script&gt;'); expect(html).toContain('строка 4');
    expect(html).not.toContain('href='); expect(html).not.toContain('<img'); expect(html).not.toContain('<script');
});

it('limits both visible receipts and finding lookup to six actual sources', () => {
    const sources = Array.from({ length: 7 }, (_, index) => ({ id: `source-${index}`, path: `docs/source-${index}.md` }));
    const html = render(result({ projectContext: context({ sources }), findings: [{ evidenceId: 'source-6', detail: 'За пределами квитанции.' }] }));
    expect(html).toContain('передано источников: 6'); expect(html).toContain('docs/source-5.md'); expect(html).not.toContain('docs/source-6.md');
    expect(html).toContain('Основание (ID): source-6'); expect(html).not.toContain('Источник базы знаний:');
});

it.each(['metadata', 'empty', 'unavailable'] as const)('does not invent usable citations for a %s receipt', status => {
    const html = render(result({ projectContext: context({ status, message: 'Ответ доступен по выбранному контексту.' }) }));
    expect(html).not.toContain('docs/runbook.md'); expect(html).not.toContain('Источник базы знаний:'); expect(html).not.toContain('ID источника:');
    expect(html).toContain('Ответ доступен по выбранному контексту.'); expect(html).toContain('Основание (ID): rag-source');
});

it('keeps legacy results readable without adding source receipts', () => {
    const html = render(result({ findings: [{ evidenceId: 'fact-one', detail: 'Каталог готов.' }] }));
    expect(html).toContain('Каталог готов.'); expect(html).toContain('ID измерения: fact-one'); expect(html).not.toContain('Источники базы знаний');
});

it('resolves a child finding only from its own receipt, never a parent or sibling receipt', () => {
    const html = render(result({ projectContext: context({ sources: [{ id: 'shared-id', path: 'parent/source.md' }] }), findings: [], delegations: [
        { roleId: 'agent-ai-admin', state: 'succeeded', result: result({ projectContext: context({ sources: [{ id: 'shared-id', path: 'child-a/source.md' }] }), findings: [{ evidenceId: 'shared-id', detail: 'Первый ответ.' }] }) },
        { roleId: 'agent-packager', state: 'succeeded', result: result({ findings: [{ evidenceId: 'shared-id', detail: 'Второй ответ.' }] }) },
    ] }));
    const second = html.indexOf('<summary>Упаковщик'), firstChild = html.slice(html.indexOf('<summary>AI-админ'), second), secondChild = html.slice(second);
    expect(firstChild).toContain('child-a/source.md'); expect(firstChild).not.toContain('parent/source.md');
    expect(secondChild).toContain('Основание (ID): shared-id'); expect(secondChild).not.toContain('Источник базы знаний:'); expect(secondChild).not.toContain('child-a/source.md'); expect(secondChild).not.toContain('parent/source.md');
});

it('retains the saved receipt in the actual service-chat details after new execution is switched off', () => {
    h.enabled = false;
    const turn: ServiceTurn = { id: 'turn-one', agentId: 'agent-coordinator', instruction: 'Проверь проект.', createdAt: '2026-10-25T00:00:00Z', cancelRequested: false, run: run(result({ projectContext: context() })) };
    const html = renderToStaticMarkup(createElement(ServiceTurnContent, { turn, busy: false, onAction: async () => undefined }));
    expect(html).toContain('Измерения, предложения и этапы'); expect(html).toContain('docs/runbook.md'); expect(html).toContain('строки 12–16'); expect(html).toContain('ID источника: rag-source');
});
