import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Start from '../src/modules/Start/Start';

const fixture = vi.hoisted(() => ({
    location: { pathname: '/start', search: '?step=2&p=dossier-ko', hash: '#setup' },
    projects: [{ id: 'prj-dossier-ko', name: 'dossier-ko' }, { id: 'prj-example', name: 'example' }],
    ready: true, loading: false, error: '',
    buttons: new Map<string, { disabled?: boolean; onClick?: () => void }>(),
    projectSelect: undefined as { onChange: (value: string) => void; value: string; options: Array<{value: string; label: string}> } | undefined,
    bridgeProject: undefined as string | undefined,
    push: vi.fn(), replace: vi.fn(), refresh: vi.fn(),
    readBridge:vi.fn(),
}));
vi.mock('react-router-dom', () => ({ useLocation: () => fixture.location,
    useHistory: () => ({ push: fixture.push, replace: fixture.replace }) }));
vi.mock('../src/modules/Projects/useAvailableProjects', () => ({ useAvailableProjects: () => fixture }));
vi.mock('react-redux',()=>({useSelector:(selector:(state:unknown)=>unknown)=>selector({userBlock:{user:{activeRole:'Главный админ',userRoles:['Главный админ'],projectRoles:[]}}})}));
vi.mock('../src/features/McpBridge/useBridge',()=>({useBridge:()=>{fixture.readBridge();return {devices:[],device:undefined,devicesReady:false,errors:{devices:'',jobs:'',installations:''},loading:false,reload:vi.fn()};}}));
vi.mock('../src/features/McpBridge/BridgeConnection',()=>({BridgeConnection:()=>null}));
vi.mock('../src/modules/Start/BridgeSetup', () => ({ BridgeSetup: ({ projectId }: { projectId?: string }) => {
    fixture.bridgeProject = projectId; return null;
} }));
vi.mock('../src/modules/Start/OpenCodeExtensions', () => ({ default: () => null }));
vi.mock('../src/common/components/PageHeading', () => ({ PageHeading: ({ actions }: { actions: ReactNode }) => actions }));
vi.mock('../src/common/components/CodeBlock', () => ({ CodeBlock: () => null }));
vi.mock('antd', async original => {
    const actual = await original<typeof import('antd')>();
    return { ...actual,
        Button: (props: Parameters<typeof actual.Button>[0]) => {
            const label = (Array.isArray(props.children) ? props.children : [props.children])
                .filter(value => typeof value === 'string').join('').trim();
            fixture.buttons.set(label, props as { disabled?: boolean; onClick?: () => void });
            return createElement(actual.Button, props);
        },
        Select: (props: Parameters<typeof actual.Select>[0]) => {
            if (props['aria-label'] === 'Проект для настройки') { fixture.projectSelect = props as typeof fixture.projectSelect; }
            return createElement(actual.Select, props);
        },
    };
});
afterEach(() => vi.unstubAllGlobals());

function render(): string {
    fixture.buttons.clear(); fixture.projectSelect = undefined; fixture.bridgeProject = undefined;
    return renderToStaticMarkup(createElement(Start));
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('window', { location: { origin: 'https://panel.example.test' } });
    vi.stubGlobal('navigator', { userAgent: 'Macintosh' });
    fixture.location.search = '?step=2&p=dossier-ko';
    fixture.projects = [{ id: 'prj-dossier-ko', name: 'dossier-ko' }, { id: 'prj-example', name: 'example' }];
    fixture.ready = true; fixture.loading = false; fixture.error = '';
});

describe('Выбор папки из начала работы сохраняет серверный проект', () => {
    it.each(['dossier-ko', 'prj-dossier-ko'])('Алиас или ID %s ведёт в мастер с каноническим ID', project => {
        fixture.location.search = `?step=2&p=${project}`;
        const html = render();
        const binding = fixture.buttons.get('Выбрать папку и связать проект');
        expect(binding).toBeDefined(); expect(binding?.disabled).not.toBe(true);
        binding?.onClick?.();
        expect(fixture.push).toHaveBeenCalledExactlyOnceWith('/projects?bind=prj-dossier-ko');
        expect(html.indexOf('aria-label="Проект для настройки"')).toBeLessThan(html.indexOf('Выбрать папку и связать проект'));
    });

    it('Точный ID имеет приоритет над совпадающим именем другого проекта', () => {
        fixture.projects.unshift({ id: 'prj-collision', name: 'prj-dossier-ko' });
        fixture.location.search = '?step=2&p=prj-dossier-ko'; render();
        expect(fixture.projectSelect?.value).toBe('prj-dossier-ko');
        expect(fixture.projectSelect?.options).toContainEqual({value:'prj-collision',label:'prj-dossier-ko'});
        fixture.buttons.get('Выбрать папку и связать проект')?.onClick?.();
        expect(fixture.push).toHaveBeenCalledExactlyOnceWith('/projects?bind=prj-dossier-ko');
        fixture.projectSelect?.onChange('prj-collision');
        expect(fixture.replace).toHaveBeenCalledExactlyOnceWith('/start?step=2&p=prj-collision#setup');
    });

    it.each(['missing', 'loading', 'error', 'unselected'] as const)('Не предлагает целевую привязку при состоянии %s', state => {
        if (state === 'missing') fixture.location.search = '?step=2&p=prj-deleted';
        if (state === 'loading') fixture.ready = false;
        if (state === 'error') fixture.error = 'Нет доступа к списку';
        if (state === 'unselected') fixture.location.search = '?step=2';
        render(); expect(fixture.buttons.get('Выбрать папку и связать проект')?.disabled).toBe(true);
        expect(fixture.push).not.toHaveBeenCalled();
    });

    it('Новый выбор сохраняет параметры этапа, а переход к каталогу — имя проекта', () => {
        render(); fixture.projectSelect?.onChange('prj-example');
        expect(fixture.replace).toHaveBeenCalledExactlyOnceWith('/start?step=2&p=prj-example#setup');
        fixture.location.search = '?step=2&p=prj-example'; render();
        fixture.buttons.get('Выбрать папку и связать проект')?.onClick?.();
        expect(fixture.push).toHaveBeenLastCalledWith('/projects?bind=prj-example');
        fixture.buttons.get('Подобрать инструменты')?.onClick?.();
        expect(fixture.push).toHaveBeenLastCalledWith('/store?p=example');
    });

    it('Подключение компьютера получает ID выбранного проекта; общий список остаётся общим', () => {
        fixture.location.search = '?step=1&p=dossier-ko'; render();
        expect(fixture.bridgeProject).toBe('prj-dossier-ko');
        fixture.buttons.get('Мои проекты')?.onClick?.();
        expect(fixture.push).toHaveBeenCalledExactlyOnceWith('/projects');
        fixture.error = 'Список устарел'; render(); expect(fixture.bridgeProject).toBeUndefined();
        fixture.error = ''; fixture.location.search = '?step=1&p=prj-deleted'; render();
        expect(fixture.bridgeProject).toBeUndefined();
    });

    it('Возврат с последнего этапа доступен при отказе списка и сохраняет контекст', () => {
        fixture.location.search='?step=2&p=prj-dossier-ko&extension=rag';fixture.error='Нет связи';
        render();fixture.buttons.get('Назад')?.onClick?.();
        expect(fixture.replace).toHaveBeenCalledExactlyOnceWith('/start?step=1&p=prj-dossier-ko&extension=rag#setup');
    });
    it('Пустой список и недоступный deep link имеют разные понятные состояния', () => {
        fixture.projects=[];expect(render()).toContain('Нет доступных проектов');
        fixture.projects=[{id:'prj-example',name:'example'}];
        expect(render()).toContain('Проект недоступен');
        expect(fixture.buttons.get('Выбрать папку и связать проект')?.disabled).toBe(true);
    });
    it('Читает подключения только в дочернем последнем этапе',()=>{
        fixture.location.search='?step=0';render();fixture.location.search='?step=1';render();expect(fixture.readBridge).not.toHaveBeenCalled();
        fixture.location.search='?step=2';render();expect(fixture.readBridge).toHaveBeenCalledOnce();
    });
});
