import {createElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MemoryRouter} from 'react-router-dom';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {BridgeSourceSettings} from '../src/modules/Settings/BridgeSourceSettings';
import Settings from '../src/modules/Settings/Settings';

const io = vi.hoisted(() => ({admin: true, assigned: true, enabled: true, url: 'https://github.com/my-company/assets', stale: false, changed: true, blocked: false, error: '', offline: false,
    saveDraft: vi.fn(), check: vi.fn(), reload: vi.fn(), acceptCurrent: vi.fn(), keepDraft: vi.fn(), change: vi.fn(), buttons: new Map<string, {disabled?: boolean; onClick?: () => void}>(), inputs: [] as Array<Record<string, unknown>>}));
vi.mock('../src/modules/Settings/useBridgeSourceDraft', () => ({useBridgeSourceDraft: () => ({...io, loading: false, saving: false, checking: false,
    data: {url: 'https://github.com/other-admin/assets', revision: 4, sourceMode: io.offline ? 'offline' : 'online', imported: {version: '0.9.18'}}})}));
vi.mock('../src/modules/Settings/AssetSourceSettings', () => ({AssetSourceSettings: () => createElement('div', null, 'Поставка ассетов')}));
vi.mock('react-redux', () => ({useSelector: (select: (state: unknown) => unknown) => select({userBlock: {user: {activeRole: io.admin ? 'Главный админ' : 'Разработчик', userRoles: io.assigned ? ['Главный админ', 'Разработчик'] : []}}})}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({scope: 'account'})}));
vi.mock('../src/features/FeatureFlags/FeatureAvailability', () => ({FeatureAvailabilityNotice: () => io.enabled ? null : createElement('div', null, 'Функция выключена'),
    FeatureButton: ({features: _features, ...props}: {features: string[]; disabled?: boolean; onClick?: () => void; children?: ReactNode}) => {
        const disabled = props.disabled || !io.enabled; io.buttons.set(String(props.children), {...props, disabled});
        return createElement('button', {disabled, onClick: () => { if (!disabled) props.onClick?.(); }}, props.children);
    }}));
vi.mock('antd', () => {
    const content = ({children}: {children?: ReactNode}) => children;
    return {Card: ({children, title}: {children?: ReactNode; title?: ReactNode}) => createElement('section', null, title, children),
        Typography: {Paragraph: content, Text: content, Title: content}, Space: content, Tag: content,
        Alert: ({message, description}: {message?: ReactNode; description?: ReactNode}) => createElement('div', null, message, description),
        Input: (props: Record<string, unknown>) => { io.inputs.push(props); return createElement('input', {'aria-label': 'Репозиторий', value: String(props.value), readOnly: true}); },
        Button: (props: {children?: ReactNode; disabled?: boolean; onClick?: () => void}) => { io.buttons.set(String(props.children), props); return createElement('button', {disabled: props.disabled}, props.children); }};
});
function render(page = false) { io.buttons.clear(); io.inputs = []; return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(page ? Settings : BridgeSourceSettings))); }
beforeEach(() => { vi.clearAllMocks(); io.admin = true; io.assigned = true; io.enabled = true; io.stale = false; io.changed = true; io.blocked = false; io.error = ''; io.offline = false; });

describe('Настройки источника вместо скрытой формы на шаге установки', () => {
    it('Показывает поле, подготовленную версию и пути к ассетам и установке; сам ничего не сохраняет', () => {
        const html = render(); expect(html).toContain('Версии моста'); expect(html).toContain('0.9.18'); expect(html).toContain('href="/assets"');
        const href = html.match(/href="([^"]+)"[^>]*>«Начало работы»/); expect(href).not.toBeNull();
        const target = new URL(href![1].replace(/&amp;/g, '&'), 'https://panel.example.test');
        expect(target.pathname).toBe('/start'); expect(target.searchParams.get('step')).toBe('1'); expect(target.searchParams.get('setup')).toBe('1');
        expect(target.searchParams.has('p')).toBe(false);
        expect(io.inputs[0]).toMatchObject({id: 'bridge-source-repository', value: io.url}); expect(io.saveDraft).not.toHaveBeenCalled(); expect(io.check).not.toHaveBeenCalled();
    });
    it('Конфликт сохраняет поле и требует явного решения до следующего сохранения', () => {
        io.stale = true; const html = render(); expect(html).toContain('Источник изменился на сервере'); expect(html).toContain('https://github.com/other-admin/assets');
        expect(io.inputs[0].value).toBe(io.url); expect(io.buttons.get('Сохранить источник')?.disabled).toBe(true);
        io.buttons.get('Оставить мой вариант')?.onClick?.(); expect(io.keepDraft).toHaveBeenCalledOnce(); expect(io.saveDraft).not.toHaveBeenCalled();
    });
    it('Выключенный flag блокирует новые действия, но оставляет текущую поставку и введённый URL', () => {
        io.enabled = false; const html = render(); expect(html).toContain('Функция выключена'); expect(html).toContain('0.9.18'); expect(io.inputs[0].value).toBe(io.url);
        expect(io.buttons.get('Сохранить источник')?.disabled).toBe(true); expect(io.buttons.get('Проверить версии')?.disabled).toBe(true); expect(io.buttons.get('Обновить сведения')?.disabled).toBe(false);
    });
    it('Offline объясняет архивный путь и не предлагает изменить URL или проверить GitHub', () => {
        io.offline = true; const html = render(); expect(html).toContain('Автономная поставка'); expect(html).toContain('Загрузите обновлённый архив'); expect(io.inputs).toHaveLength(0);
        expect(io.buttons.has('Проверить версии')).toBe(false); expect(io.buttons.has('Сохранить источник')).toBe(false);
    });
    it.each(['developer', 'unassigned'] as const)('Неподходящая активная роль %s не монтирует общую форму', role => {
        if (role === 'developer') io.admin = false; else io.assigned = false;
        const html = render(true); expect(html).toContain('Общие настройки доступны главному администратору'); expect(io.inputs).toHaveLength(0); expect(html).not.toContain('Поставка ассетов');
    });
    it('Главному администратору даёт ссылки на действующие настройки доступа и обслуживания', () => {
        const html = render(true); expect(html).toContain('href="/maintenance"'); expect(html).toContain('href="/access"'); expect(html).toContain('Поставка ассетов');
    });
});
