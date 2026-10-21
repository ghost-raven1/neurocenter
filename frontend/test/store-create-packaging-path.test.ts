import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import StoreCreateModal from '../src/modules/Store/StoreCreateModal';

const ui = vi.hoisted(() => ({ modes: [] as string[], kind: 'mcp', pack: undefined as (() => void) | undefined }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => ({ captureOwner: () => () => true }) }));
vi.mock('../src/modules/Store/publication/SkillResourceEditor', () => ({ SkillResources: () => null }));
vi.mock('../src/modules/Store/publication/DependencyPinsEditor', () => ({ DependencyPinsEditor: () => null }));
vi.mock('antd', () => {
    const content = ({ children }: { children?: ReactNode }) => children;
    return {
        Alert: ({ message, action }: { message?: ReactNode; action?: ReactNode }) => createElement('div', null, message, action),
        Form: Object.assign(content, { Item: content, useForm: () => [{}], useWatch: (field: string) => field === 'kind' ? ui.kind : 'remote' }),
        Button: ({ children, onClick }: { children?: ReactNode; onClick?: () => void }) => { if (children === 'Упаковать инструмент' || children === 'Добавить скилл архивом') ui.pack = onClick; return children; },
        Checkbox: content, Input: Object.assign(() => null, { TextArea: () => null }), Modal: content,
        Radio: { Group: () => null }, Select: ({ options }: { options: { value: string }[] }) => { ui.modes = options.map(option => option.value); return null; },
        Space: content, Typography: { Paragraph: content }, message: { success: vi.fn() },
    };
});

beforeEach(() => { ui.modes = []; ui.pack = undefined; ui.kind = 'mcp'; });
describe('Рабочие пути добавления локального MCP', () => {
    it('Предлагает удалённое подключение и закреплённый JS-пакет без тупиковой команды', () => {
        renderToStaticMarkup(createElement(StoreCreateModal, { open: true, onClose: vi.fn(), onCreated: vi.fn(), onPackage: vi.fn() }));
        expect(ui.modes).toEqual(['remote', 'bundle']);
    });
    it('Открывает мастер упаковки из ручного добавления одним действием', () => {
        const onPackage = vi.fn();
        const html = renderToStaticMarkup(createElement(StoreCreateModal, { open: true, onClose: vi.fn(), onCreated: vi.fn(), onPackage }));
        expect(html).toContain('npm'); expect(ui.pack).toBeTypeOf('function');
        ui.pack!(); expect(onPackage).toHaveBeenCalledOnce();
    });
    it('Для скилла открывает архивный источник без заполнения ручной инструкции', () => {
        ui.kind = 'skill';
        const onPackage = vi.fn();
        const html = renderToStaticMarkup(createElement(StoreCreateModal, { open: true, onClose: vi.fn(), onCreated: vi.fn(), onPackage }));
        expect(html).toContain('Добавить скилл архивом');
        expect(html).toContain('Найдём SKILL.md');
        ui.pack!(); expect(onPackage).toHaveBeenCalledExactlyOnceWith('files');
    });
});
