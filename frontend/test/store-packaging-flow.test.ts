import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolPackagingModal } from '../src/modules/Store/packaging/ToolPackagingModal';
import { packagingFilesMetadata, packagingReferenceSource } from '../src/modules/Store/packaging/packagingDraft';
import type { NpmPackageMetadata, RepositoryMetadata, RepositoryQuery, ToolBuild } from '../src/modules/Store/packaging/types';

const hooks = vi.hoisted(() => {
    let cursor = 0;
    const slots: Array<{ value?: unknown; dependencies?: unknown[]; cleanup?: () => void }> = [];
    const effects: Array<() => void> = [];
    const same = (a?: unknown[], b?: unknown[]) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
    return {
        begin: () => { cursor = 0; }, commit: () => { effects.splice(0).forEach(effect => effect()); },
        dispose: () => { slots.splice(0).forEach(slot => slot.cleanup?.()); effects.length = 0; },
        useState<T>(initial: T) {
            const slot = slots[cursor++] ??= { value: initial };
            return [slot.value, (next: T | ((previous: T) => T)) => { slot.value = typeof next === 'function' ? (next as (previous: T) => T)(slot.value as T) : next; }];
        },
        useRef<T>(initial?: T) { return (slots[cursor++] ??= { value: { current: initial } }).value; },
        useMemo(factory: () => unknown, dependencies: unknown[]) {
            const index = cursor++, previous = slots[index];
            if (!previous || !same(previous.dependencies, dependencies)) slots[index] = { value: factory(), dependencies };
            return slots[index].value;
        },
        useEffect(effect: () => void | (() => void), dependencies: unknown[]) {
            const index = cursor++, previous = slots[index];
            if (previous && same(previous.dependencies, dependencies)) return;
            const slot = slots[index] = { dependencies };
            effects.push(() => { previous?.cleanup?.(); slot.cleanup = effect() || undefined; });
        },
    };
});
interface InputProps {
    value?: string; 'aria-label'?: string;
    onChange?: (event: { target: { value: string } }) => void;
    onPaste?: (event: { clipboardData: { getData: (format: string) => string }; preventDefault: () => void }) => void;
}
interface ButtonProps { children?: ReactNode; disabled?: boolean; onClick?: () => void; htmlType?: string; }
interface SelectProps { 'aria-label'?: string; value?: string; onChange: (value: string) => void; }
const ui = vi.hoisted(() => ({
    scope: 'admin-a', projectId: 'project-a', open: true,
    inputs: new Map<string, InputProps>(), buttons: new Map<string, ButtonProps>(),
    selects: new Map<string, SelectProps>(),
    metadata: new Map<string, NpmPackageMetadata>(),
    repositoryMetadata: undefined as RepositoryMetadata | undefined, repositoryQuery: undefined as RepositoryQuery | undefined,
    resolve: vi.fn(), submit: vi.fn(), reset: vi.fn(),
    finish: undefined as (() => void) | undefined, close: undefined as (() => void) | undefined,
    job: undefined as ToolBuild | undefined,
    source: '' as string, selectSource: undefined as ((event: { target: { value: string } }) => void) | undefined,
    owners: new Map<string, () => () => boolean>(),
}));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: hooks.useState, useRef: hooks.useRef, useMemo: hooks.useMemo, useEffect: hooks.useEffect }));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({ useAuthRequestOwner: () => {
    if (!ui.owners.has(ui.scope)) { const scope = ui.scope; ui.owners.set(scope, () => () => ui.scope === scope); }
    return { captureOwner: ui.owners.get(ui.scope)! };
} }));
vi.mock('../src/modules/Store/packaging/useNpmMetadata', () => ({ useNpmMetadata: (specifier: string) => ({ metadata: ui.metadata.get(specifier), resolve: () => ui.resolve(specifier) }) }));
vi.mock('../src/modules/Store/packaging/useRepositoryMetadata', () => ({ useRepositoryMetadata: (query: RepositoryQuery) => {
    ui.repositoryQuery=query; return { metadata:ui.repositoryMetadata, resolve:async()=>ui.repositoryMetadata };
} }));
vi.mock('../src/modules/Store/packaging/useToolBuild', () => ({ useToolBuild: () => ({ job: ui.job, active: false, submitting: false, unresolved: false, submit: ui.submit, reset: ui.reset }) }));
vi.mock('../src/modules/Store/packaging/useSourceUpload', () => ({ useSourceUpload: () => ({ busy:false,forget:async()=>true }) }));
vi.mock('antd', () => {
    const content = ({ children }: { children?: ReactNode }) => children;
    const input = (props: InputProps) => { ui.inputs.set(props['aria-label'] ?? '', props); return null; };
    return {
        Alert: ({ message, description }: { message?: ReactNode; description?: ReactNode }) => createElement('div', null, message, description),
        Button: (props: ButtonProps) => { ui.buttons.set(String(props.children), props); return props.children; },
        Modal: ({ open, onCancel, children, footer }: { open: boolean; onCancel: () => void; children?: ReactNode; footer?: ReactNode }) => { ui.close = onCancel; return open ? createElement('div', null, children, createElement('footer', null, footer)) : null; },
        Form: Object.assign(({ children, onFinish }: { children?: ReactNode; onFinish: () => void }) => { ui.finish = onFinish; return children; }, { Item: content }),
        Input: Object.assign(input, { Search: input, TextArea: input }),
        Radio: { Group: ({ 'aria-label': label, value, onChange }: { 'aria-label': string; value: string; onChange: typeof ui.selectSource }) => { if (label === 'Источник инструмента') { ui.source = value; ui.selectSource = onChange; } return null; } },
        Select: (props:SelectProps) => {ui.selects.set(props['aria-label']??'',props);return null;}, Collapse: Object.assign(content, { Panel: content }), Space: content,
        Progress: () => null, Spin: () => null, Tag: content, Divider: content,
        Typography: { Text: content, Paragraph: content },
    };
});

const metadata: NpmPackageMetadata = { package: '@team/my-tool', specifier: '@team/my-tool@1.2.3', version: '1.2.3', description: 'Помогает команде', entrypoint: 'index.js', candidates: ['index.js'], recommendedKind: 'plugin' };
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
const flush = async () => { for (let turn = 0; turn < 10; turn++) await Promise.resolve(); };
function render() {
    hooks.begin(); ui.inputs.clear(); ui.buttons.clear(); ui.selects.clear(); ui.finish = undefined;
    const html = renderToStaticMarkup(createElement(ToolPackagingModal, { open: ui.open, scope: ui.scope, projectId: ui.projectId, onClose: () => { ui.open = false; }, onPublished: vi.fn() }));
    hooks.commit(); return html;
}
function input(label: string, value: string) { ui.inputs.get(label)!.onChange!({ target: { value } }); }
function ready() { render(); input('npm-пакет или ссылка', metadata.package); ui.metadata.set(metadata.package, metadata); render(); }
beforeEach(() => {
    vi.resetAllMocks(); ui.scope = 'admin-a'; ui.projectId = 'project-a'; ui.open = true; ui.metadata.clear(); ui.owners.clear(); ui.job = undefined; ui.repositoryMetadata=undefined; ui.repositoryQuery=undefined;
    ui.resolve.mockImplementation(async () => metadata);
    ui.reset.mockImplementation(() => { ui.job = undefined; });
});
afterEach(() => hooks.dispose());

describe('Проверка источника до добавления инструмента', () => {
    it('Первая проверка показывает карточку, а отдельное подтверждение отправляет закреплённую версию и определённый тип', async () => {
        ui.resolve.mockImplementation(async (specifier: string) => { ui.metadata.set(specifier, metadata); return metadata; });
        render(); input('npm-пакет или ссылка', metadata.package); render();
        expect(ui.buttons.has('Проверить источник')).toBe(true);
        ui.finish!(); await flush();
        expect(ui.submit).not.toHaveBeenCalled();
        const html = render();
        expect(html).toContain('team · my-tool'); expect(html).toContain('Плагин OpenCode'); expect(html).toContain('Будет добавлено в общий каталог');
        expect(ui.buttons.has('Упаковать и добавить')).toBe(true);
        ui.finish!(); await flush();
        expect(ui.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'team · my-tool', description: metadata.description, kind: 'plugin', source: { type: 'npm', specifier: metadata.specifier, entrypoint:'index.js' } }));
    });
    it('Несколько npm-команд требуют выбора; выбранная команда закрепляется в POST',async()=>{
        const multiple={...metadata,entrypoint:'',candidates:['first.js','second.js'],requiresEntrypointChoice:true};
        render();input('npm-пакет или ссылка',metadata.package);ui.metadata.set(metadata.package,multiple);ui.resolve.mockResolvedValue(multiple);render();
        expect(ui.buttons.get('Выберите команду запуска')?.disabled).toBe(true);ui.finish!();await flush();expect(ui.submit).not.toHaveBeenCalled();
        render();expect(ui.selects.get('Команда npm-пакета')?.value).toBeUndefined();ui.selects.get('Команда npm-пакета')!.onChange('second.js');render();
        ui.finish!();await flush();expect(ui.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({source:{type:'npm',specifier:metadata.specifier,entrypoint:'second.js'}}));
        ui.metadata.set(metadata.package,{...multiple,candidates:['third.js','fourth.js']});render();expect(ui.buttons.get('Выберите команду запуска')?.disabled).toBe(true);
    });
    it('Библиотека без runnable kind не отправляется даже через Enter формы',async()=>{
        const library={...metadata,runnableKinds:[],warnings:['Это библиотека']};
        render();input('npm-пакет или ссылка',metadata.package);ui.metadata.set(metadata.package,library);ui.resolve.mockResolvedValue(library);render();
        expect(ui.buttons.get('Нет команды запуска')?.disabled).toBe(true);ui.finish!();await flush();expect(ui.submit).not.toHaveBeenCalled();
    });
    it('Незавершённый выбор GitHub-релиза не меняет действие готового npm-источника',()=>{
        ready();ui.repositoryMetadata={url:'https://github.com/team/tool',commit:'a'.repeat(40),ref:'v1',name:'Tool',description:'Описание',entrypoint:'',candidates:[],requiresReleaseChoice:true};render();
        expect(ui.buttons.get('Упаковать и добавить')?.disabled).toBe(false);expect(ui.buttons.has('Выберите файл релиза')).toBe(false);
    });
    it('Релиз требует конкретный файл и отправляет полный pin поставки после проверки',async()=>{
        render();ui.selectSource!({target:{value:'repository'}});render();input('Ссылка на репозиторий GitHub','https://github.com/team/tool/releases/tag/v1');
        const base:RepositoryMetadata={url:'https://github.com/team/tool',commit:'a'.repeat(40),ref:'v1',entrypoint:'',candidates:[],name:'Tool',description:'Описание',release:{tag:'v1',id:12},requiresReleaseChoice:true,releaseChoices:[{id:34,name:'tool.zip',bytes:500,format:'zip'}]};
        ui.repositoryMetadata=base;render();expect(ui.buttons.get('Выберите файл релиза')?.disabled).toBe(true);ui.finish!();await flush();expect(ui.submit).not.toHaveBeenCalled();
        render();ui.selects.get('Файл релиза GitHub')!.onChange('tool.zip');render();expect(ui.repositoryQuery?.release).toEqual({tag:'v1',id:12,asset:'tool.zip'});
        const release={tag:'v1',id:12,asset:'tool.zip',assetId:34,sha256:'b'.repeat(64)};
        ui.repositoryMetadata={...base,entrypoint:'bin/server',candidates:['bin/server'],release,requiresReleaseChoice:false,adapter:'native',runnableKinds:['mcp']};render();
        ui.finish!();await flush();expect(ui.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({source:{type:'repository',url:base.url,ref:base.commit,entrypoint:'bin/server',release}}));
    });

    it.each(['close', 'project', 'owner', 'source'] as const)('Не запускает скрытую упаковку после смены контекста: %s', async change => {
        ready(); const pending = deferred<NpmPackageMetadata>(); ui.resolve.mockReturnValue(pending.promise);
        ui.finish!();
        if (change === 'close') ui.close!();
        if (change === 'project') ui.projectId = 'project-b';
        if (change === 'owner') ui.scope = 'admin-b';
        if (change === 'source') ui.selectSource!({ target: { value: 'repository' } });
        render(); pending.resolve(metadata); await flush();
        expect(ui.submit).not.toHaveBeenCalled();
    });

    it('Кнопка закрытия в footer доступна во время проверки и отменяет позднюю отправку', async () => {
        ready(); const pending = deferred<NpmPackageMetadata>(); ui.resolve.mockReturnValue(pending.promise);
        ui.buttons.get('Упаковать и добавить')!.onClick!();
        const html = render();
        expect(html).toContain('<footer>');
        expect(ui.buttons.get('Упаковать и добавить')!.disabled).toBe(true);
        expect(ui.buttons.get('Закрыть')!.disabled).toBe(false);
        ui.buttons.get('Закрыть')!.onClick!();
        expect(ui.open).toBe(false);
        pending.resolve(metadata); await flush();
        expect(ui.submit).not.toHaveBeenCalled();
    });

    it('Вставка GitHub-ссылки сама выбирает источник и сохраняет адрес', () => {
        render(); const preventDefault = vi.fn();
        ui.inputs.get('npm-пакет или ссылка')!.onPaste!({ clipboardData: { getData: () => 'https://github.com/team/my-tool' }, preventDefault });
        render(); expect(ui.source).toBe('repository'); expect(ui.inputs.get('Ссылка на репозиторий GitHub')!.value).toBe('https://github.com/team/my-tool');
        expect(preventDefault).toHaveBeenCalledOnce();
    });

    it('Упаковать ещё очищает прежние исходники и пользовательскую карточку', async () => {
        ready(); input('Название в каталоге', 'Предыдущий инструмент'); input('Описание инструмента', 'Предыдущее описание');
        ui.job = { id: 'built', operationId: 'operation', state: 'SUCCEEDED', percent: 100, message: 'Готово', result: { catalogId: 'tool', name: 'Tool', version: 1 } };
        render(); ui.buttons.get('Упаковать ещё')!.onClick!(); await flush(); render();
        expect(ui.inputs.get('npm-пакет или ссылка')!.value).toBe(''); expect(ui.inputs.get('Название в каталоге')!.value).toBe(''); expect(ui.inputs.get('Описание инструмента')!.value).toBe('');
    });

    it('После отказа возвращает исходный заполненный черновик для исправления', () => {
        ready(); input('Название в каталоге', 'Мой инструмент');
        ui.job = { id: 'failed', operationId: 'operation', state: 'FAILED', percent: 20, message: 'Отказ', error: 'Не найден entrypoint' };
        const html = render(); expect(html).toContain('Исходники и настройки сохранены');
        ui.buttons.get('Вернуться к исходникам')!.onClick!(); render();
        expect(ui.inputs.get('npm-пакет или ссылка')!.value).toBe(metadata.package); expect(ui.inputs.get('Название в каталоге')!.value).toBe('Мой инструмент');
    });
});

describe('Автоматические данные источника', () => {
    it('Читает название и описание загруженного package.json без зависимости от имени ZIP', () => {
        expect(packagingFilesMetadata([{ path: 'package.json', content: JSON.stringify({ name: '@team/my-tool', description: '  Помогает команде  ' }) }])).toEqual({ name: '@team/my-tool', description: 'Помогает команде' });
    });
    it.each(['{', 'null', '[]', '"package"'])('Повреждённые метаданные не блокируют выбор исходников: %s', content => {
        expect(packagingFilesMetadata([{ path: 'package.json', content }])).toEqual({});
    });
    it('Не принимает неподдерживаемые ссылки за другой разрешённый источник', () => {
        expect(packagingReferenceSource('https://github.com/team/my-tool')).toBe('repository');
        expect(packagingReferenceSource('https://www.npmjs.com/package/@team/my-tool')).toBe('npm');
        expect(packagingReferenceSource('https://gitlab.com/team/my-tool')).toBeUndefined();
        expect(packagingReferenceSource('https://github.com.attacker.example/team/my-tool')).toBeUndefined();
    });
});
