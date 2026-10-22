import {FeatureAvailabilityContext} from '../src/features/FeatureFlags/FeatureAvailability';
import {featureFlagKeys,type IEvaluatedFeatureFlags} from '../src/features/FeatureFlags/types';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolPackagingModal } from '../src/modules/Store/packaging/ToolPackagingModal';
import { packagingFilesMetadata, packagingReferenceSource } from '../src/modules/Store/packaging/packagingDraft';
import {readPackagingArchive} from '../src/modules/Store/packaging/sourceArchive';
import type { NpmPackageMetadata, PackagingKind, RepositoryMetadata, RepositoryQuery, ToolBuild } from '../src/modules/Store/packaging/types';
import type {SourceUpload,SourceUploadIntent} from '../src/modules/Store/packaging/uploadTypes';

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
    value?: string; 'aria-label'?: string; disabled?:boolean;
    onChange?: (event: { target: { value: string } }) => void;
    onPaste?: (event: { clipboardData: { getData: (format: string) => string }; preventDefault: () => void }) => void;
}
interface ButtonProps { children?: ReactNode; disabled?: boolean; onClick?: () => void; htmlType?: string; }
interface SelectProps { 'aria-label'?: string; value?: string; onChange: (value: string) => void; }
const ui = vi.hoisted(() => ({
    flags:true as boolean|null, catalogFlag:true,scope: 'admin-a', projectId: 'project-a', open: true,
    start: undefined as {source:'files'} | {publication:{catalogId:string;kind:PackagingKind}} | undefined, active: false, unresolved:false,recoveryBlocked:false,pickerDisabled:false,
    inputs: new Map<string, InputProps>(), buttons: new Map<string, ButtonProps>(),
    selects: new Map<string, SelectProps>(),
    metadata: new Map<string, NpmPackageMetadata>(),
    repositoryMetadata: undefined as RepositoryMetadata | undefined, repositoryQuery: undefined as RepositoryQuery | undefined,
    publicationTarget:vi.fn(), draft:undefined as {request:import('../src/modules/Store/packaging/types').ToolBuildRequest}|undefined, resolve: vi.fn(), submit: vi.fn(), reset: vi.fn(), cancel: vi.fn(), retryCancel: vi.fn(),
    cancelling:false,cancelPending:false,cancelled:false,canCancel:false,canDetach:false,canRestoreArchived:false,archiving:false,
    archived:[] as Array<{requestKey:string;jobId:string;name:string}>,detach:vi.fn(),restoreArchived:vi.fn(),
    finish: undefined as (() => void) | undefined, close: undefined as (() => void) | undefined,
    job: undefined as ToolBuild | undefined,
    source: '' as string, selectSource: undefined as ((event: { target: { value: string } }) => void) | undefined,
    kind: '' as PackagingKind, selectKind: undefined as ((event: {target:{value:PackagingKind}})=>void)|undefined,
    kinds: [] as Array<{value:string;disabled?:boolean}>, selectFiles: undefined as ((files:File[],archive?:boolean)=>void)|undefined,
    owners: new Map<string, () => () => boolean>(),
    uploadSelect:vi.fn(),upload:undefined as SourceUpload|undefined,uploadIntent:undefined as SourceUploadIntent|undefined,uploadError:'',
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
vi.mock('../src/modules/Store/packaging/useToolBuild', () => ({ useToolBuild: () => ({ draft:ui.draft,job: ui.job, active: ui.active, submitting: false, unresolved: ui.unresolved,recoveryBlocked:ui.recoveryBlocked, submit: ui.submit, reset: ui.reset,
    cancel:ui.cancel,retryCancel:ui.retryCancel,cancelling:ui.cancelling,cancelPending:ui.cancelPending,cancelled:ui.cancelled,canCancel:ui.canCancel,
    canDetach:ui.canDetach,detach:ui.detach,canRestoreArchived:ui.canRestoreArchived,archived:ui.archived,archiving:ui.archiving,restoreArchived:ui.restoreArchived }) }));
vi.mock('../src/modules/Store/packaging/useSourceUpload', () => ({ useSourceUpload: () => ({ busy:false,error:ui.uploadError,select:ui.uploadSelect,upload:ui.upload,intent:ui.uploadIntent,forget:async()=>true }) }));
vi.mock('../src/modules/Store/packaging/api',()=>({packagingApi:{publicationTarget:(...args:unknown[])=>ui.publicationTarget(...args)}}));
vi.mock('../src/modules/Store/packaging/sourceArchive',()=>({readPackagingArchive:vi.fn()}));
vi.mock('../src/modules/Store/packaging/SourceFilesPicker',()=>({SourceFilesPicker:({onSelect,disabled}:{onSelect:typeof ui.selectFiles;disabled:boolean})=>{ui.selectFiles=onSelect;ui.pickerDisabled=disabled;return null;}}));
vi.mock('antd', () => {
    const content = ({ children }: { children?: ReactNode }) => children;
    const input = (props: InputProps) => { ui.inputs.set(props['aria-label'] ?? '', props); return null; };
    return {
        Alert: ({ message, description }: { message?: ReactNode; description?: ReactNode }) => createElement('div', null, message, description),
        Button: (props: ButtonProps) => { ui.buttons.set(String(props.children), props); return props.children; },
        Modal: ({ open, onCancel, children, footer }: { open: boolean; onCancel: () => void; children?: ReactNode; footer?: ReactNode }) => { ui.close = onCancel; return open ? createElement('div', null, children, createElement('footer', null, footer)) : null; },
        Form: Object.assign(({ children, onFinish }: { children?: ReactNode; onFinish: () => void }) => { ui.finish = onFinish; return children; }, { Item: content }),
        Input: Object.assign(input, { Search: input, TextArea: input }),
        Radio: { Group: ({ 'aria-label': label, value, onChange,options }: { 'aria-label': string; value: string; onChange: typeof ui.selectSource;options:typeof ui.kinds }) => { if (label === 'Источник инструмента') { ui.source = value; ui.selectSource = onChange; } else if(label==='Тип инструмента'){ui.kind=value as PackagingKind;ui.selectKind=onChange as typeof ui.selectKind;ui.kinds=options;} return null; } },
        Tooltip:content,Select: (props:SelectProps) => {ui.selects.set(props['aria-label']??'',props);return null;}, Collapse: Object.assign(content, { Panel: content }), Space: content,
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
    hooks.begin(); ui.inputs.clear(); ui.buttons.clear(); ui.selects.clear(); ui.finish = undefined; ui.selectFiles=undefined;
    const data=ui.flags===null?null:{flags:Object.fromEntries(featureFlagKeys.map(key=>[key,key==='tool_catalog'?ui.catalogFlag:ui.flags])),configured:{},blockedBy:Object.fromEntries(featureFlagKeys.map(key=>[key,[]]))}as IEvaluatedFeatureFlags;
    const html = renderToStaticMarkup(createElement(FeatureAvailabilityContext.Provider,{value:{data,loading:false,error:null,refresh:async()=>undefined}},createElement(ToolPackagingModal, { open: ui.open, start: ui.start, scope: ui.scope, projectId: ui.projectId, onClose: () => { ui.open = false; }, onPublished: vi.fn() })));
    hooks.commit(); return html;
}
function input(label: string, value: string) { ui.inputs.get(label)!.onChange!({ target: { value } }); }
function ready() { render(); input('npm-пакет или ссылка', metadata.package); ui.metadata.set(metadata.package, metadata); render(); }
beforeEach(() => {
    vi.resetAllMocks();ui.flags=true;ui.catalogFlag=true; ui.scope = 'admin-a'; ui.projectId = 'project-a'; ui.open = true; ui.start=undefined; ui.active=false; ui.source=''; ui.metadata.clear(); ui.owners.clear(); ui.job = undefined; ui.repositoryMetadata=undefined; ui.repositoryQuery=undefined;
    ui.resolve.mockImplementation(async () => metadata);
    ui.reset.mockImplementation(() => { ui.job = undefined;ui.cancelled=false; });
    ui.upload=undefined;ui.uploadIntent=undefined;ui.uploadError='';ui.uploadSelect.mockResolvedValue(undefined);
    ui.unresolved=false;ui.recoveryBlocked=false;ui.pickerDisabled=false;ui.cancelling=false;ui.cancelPending=false;ui.cancelled=false;ui.canCancel=false;
    ui.canDetach=false;ui.canRestoreArchived=false;ui.archiving=false;ui.archived=[];ui.draft=undefined;
    ui.publicationTarget.mockResolvedValue({catalogId:'native-tool',name:'Существующий инструмент',description:'Текущий инструмент',kind:'plugin',expectedVersion:7,expectedSourceHash:'b'.repeat(64),sourceSummaries:[],updateSupported:true});
});
afterEach(() => hooks.dispose());

describe('Проверка источника до добавления инструмента', () => {
    it('Явная новая версия читает свежую цель, требует подтверждения и отправляет CAS вместо нового инструмента',async()=>{
        ui.start={publication:{catalogId:'native-tool',kind:'plugin'}};render();render();await flush();render();
        expect(ui.publicationTarget).toHaveBeenCalledWith({catalogId:'native-tool',kind:'plugin'},expect.any(AbortSignal));
        expect(ui.buttons.has('Подготовить новую версию')).toBe(true);ui.finish!();await flush();expect(ui.submit).not.toHaveBeenCalled();
        ui.buttons.get('Подготовить новую версию')!.onClick!();render();ready();render();
        expect(ui.inputs.get('Название в каталоге')?.disabled).toBe(true);expect(ui.kind).toBe('plugin');
        ui.finish!();await flush();expect(ui.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({name:'Существующий инструмент',kind:'plugin',publication:{catalogId:'native-tool',expectedVersion:7,expectedSourceHash:'b'.repeat(64)}}));
    });
    it('Неподдерживаемая новая версия показывает продолжение и не отправляется через Enter',async()=>{
        ui.publicationTarget.mockResolvedValue({catalogId:'common/review',name:'Review',description:'Текст',kind:'skill',expectedVersion:2,expectedSourceHash:'c'.repeat(64),sourceSummaries:[],updateSupported:false,unsupportedReason:'Обновление скилла через упаковщик пока недоступно.'});
        ui.start={publication:{catalogId:'common/review',kind:'skill'}};render();render();await flush();expect(render()).toContain('Обновление скилла через упаковщик пока недоступно.');
        expect(ui.buttons.get('Подготовить новую версию')?.disabled).toBe(true);ready();ui.finish!();await flush();expect(ui.submit).not.toHaveBeenCalled();
    });
    it('Активный сохранённый запрос приоритетнее новой цели',async()=>{
        ui.start={publication:{catalogId:'native-tool',kind:'plugin'}};ui.active=true;render();render();await flush();expect(ui.publicationTarget).not.toHaveBeenCalled();
        ui.active=false;ui.unresolved=true;render();render();expect(ui.publicationTarget).not.toHaveBeenCalled();expect(ui.submit).not.toHaveBeenCalled();
    });
    it('Явное обновление CAS сохраняет источник и описание и требует нового подтверждения',async()=>{
        ui.start={publication:{catalogId:'native-tool',kind:'plugin'}};render();render();await flush();render();ui.buttons.get('Подготовить новую версию')!.onClick!();render();ready();input('Описание инструмента','Ручное описание');render();
        ui.publicationTarget.mockResolvedValue({catalogId:'native-tool',name:'Существующий инструмент',description:'Новое серверное описание',kind:'plugin',expectedVersion:8,expectedSourceHash:'c'.repeat(64),sourceSummaries:[],updateSupported:true});
        ui.buttons.get('Обновить цель')!.onClick!();render();await flush();render();expect(ui.inputs.get('npm-пакет или ссылка')!.value).toBe(metadata.package);
        ui.finish!();await flush();expect(ui.submit).not.toHaveBeenCalled();ui.buttons.get('Подготовить новую версию')!.onClick!();render();
        expect(ui.inputs.get('Описание инструмента')!.value).toBe('Ручное описание');ui.finish!();await flush();expect(ui.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({description:'Ручное описание',publication:{catalogId:'native-tool',expectedVersion:8,expectedSourceHash:'c'.repeat(64)},source:{type:'npm',specifier:metadata.specifier,entrypoint:'index.js'}}));
    });
    it('Поздний GET A не подменяет цель B; отказ сети даёт повтор без POST',async()=>{
        const a=deferred<unknown>();ui.publicationTarget.mockReturnValueOnce(a.promise);ui.start={publication:{catalogId:'old',kind:'plugin'}};render();render();await flush();
        ui.publicationTarget.mockRejectedValueOnce(Error('Target offline'));ui.start={publication:{catalogId:'native-tool',kind:'plugin'}};render();render();await flush();expect(render()).toContain('Target offline');
        a.resolve({catalogId:'old',name:'Stale target',kind:'plugin',expectedVersion:1,expectedSourceHash:'d'.repeat(64),updateSupported:true});await flush();expect(render()).not.toContain('Stale target');
        ui.buttons.get('Обновить цель')!.onClick!();render();await flush();render();ui.buttons.get('Подготовить новую версию')!.onClick!();render();ready();ui.finish!();await flush();expect(ui.submit).toHaveBeenCalledWith(expect.objectContaining({publication:expect.objectContaining({catalogId:'native-tool'})}));
    });
    it('Восстановленная цель и исходники не подменяются новым переходом',async()=>{
        ui.draft={request:{requestKey:'11111111-1111-4111-8111-111111111111',kind:'mcp',name:'Сохранённый MCP',description:'Мои данные',publication:{catalogId:'saved',expectedVersion:3,expectedSourceHash:'e'.repeat(64)},source:{type:'npm',specifier:'saved@2.0.0',entrypoint:'saved.js'}}};
        ui.unresolved=true;ui.start={publication:{catalogId:'native-tool',kind:'plugin'}};render();render();await flush();const html=render();expect(ui.publicationTarget).not.toHaveBeenCalled();expect(html).toContain('Сначала завершите сохранённый запрос');expect(html).toContain('Сохранённый MCP');expect(ui.inputs.get('npm-пакет или ссылка')!.value).toBe('saved@2.0.0');expect(ui.kind).toBe('mcp');expect(ui.inputs.get('Название в каталоге')!.disabled).toBe(true);
    });
    it.each([false,null])('Новая версия не публикуется при флагах %s; архивы и отмена видны',async flags=>{
        ui.start={publication:{catalogId:'native-tool',kind:'plugin'}};render();render();await flush();render();ui.buttons.get('Подготовить новую версию')!.onClick!();render();ready();ui.flags=flags;ui.archived=[{requestKey:'old',jobId:'old',name:'Сохранённый запрос'}];ui.canRestoreArchived=true;
        const html=render();ui.finish!();await flush();expect(ui.submit).not.toHaveBeenCalled();expect(html).toContain('Сохранённый запрос');expect(ui.buttons.get('Открыть сохранённый запрос')!.disabled).not.toBe(true);
        ui.catalogFlag=false;ui.flags=true;render();ui.finish!();await flush();expect(ui.submit).not.toHaveBeenCalled();
    });
    it('Поздняя проверка цели прежнего владельца не раскрывает её после смены профиля',async()=>{
        const wait=deferred<unknown>();ui.publicationTarget.mockReturnValueOnce(wait.promise);ui.start={publication:{catalogId:'old-owner',kind:'plugin'}};render();render();ui.scope='admin-b';render();render();wait.resolve({catalogId:'old-owner',name:'Private old target',kind:'plugin',expectedVersion:1,expectedSourceHash:'d'.repeat(64),updateSupported:true});await flush();expect(render()).not.toContain('Private old target');expect(ui.submit).not.toHaveBeenCalled();
    });
    it('Флаг, выключенный во время проверки источника, не допускает поздний POST новой версии',async()=>{
        ui.start={publication:{catalogId:'native-tool',kind:'plugin'}};render();render();await flush();render();ui.buttons.get('Подготовить новую версию')!.onClick!();render();ready();const wait=deferred<NpmPackageMetadata>();ui.resolve.mockReturnValueOnce(wait.promise);ui.finish!();ui.catalogFlag=false;render();wait.resolve(metadata);await flush();expect(ui.submit).not.toHaveBeenCalled();
    });
    it('Прямое добавление архива открывает выбор файла и не отправляет сборку', () => {
        ui.start={source:'files'}; render();
        const html=render(); expect(ui.source).toBe('files'); expect(ui.selectFiles).toBeTypeOf('function');
        expect(html).toContain('SKILL.md'); expect(ui.submit).not.toHaveBeenCalled();
        ui.selectSource!({target:{value:'repository'}}); render(); expect(ui.source).toBe('repository');
    });
    it('Архивный переход дожидается восстановления и сохраняет активную сборку', () => {
        ui.start={source:'files'}; ui.active=true; render(); render(); expect(ui.selectFiles).toBeUndefined();
        ui.job={id:'existing',operationId:'operation',state:'RUNNING',percent:10,message:'Проверяем'}; render();
        ui.active=false; expect(render()).toContain('Проверяем'); expect(ui.selectFiles).toBeUndefined(); expect(ui.submit).not.toHaveBeenCalled();
        ui.job=undefined; render(); render(); expect(ui.source).toBe('files');
    });
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

    it('GitHub остаётся доступен после переключения всех источников и сохраняет введённый адрес', () => {
        render(); input('npm-пакет или ссылка', '@team/tool');
        ui.selectSource!({ target: { value: 'repository' } }); render();
        input('Ссылка на репозиторий GitHub', 'https://github.com/team/tool/blob/main/SKILL.md');
        for (const source of ['files', 'upload', 'npm', 'repository']) {
            ui.selectSource!({ target: { value: source } }); render();
            expect(ui.source).toBe(source);
            if (source === 'npm') expect(ui.inputs.get('npm-пакет или ссылка')?.value).toBe('@team/tool');
        }
        expect(ui.inputs.get('Ссылка на репозиторий GitHub')?.value).toBe('https://github.com/team/tool/blob/main/SKILL.md');
        expect(ui.buttons.get('Проверить источник')?.disabled).toBe(false);
        expect(ui.submit).not.toHaveBeenCalled();
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

const skillText='---\nname: careful-reviewer\ndescription: Проверяет изменения и важные риски\n---\n\nПрочитай [правила](references/rules.md) и проверь код.';
function selectedFile(name:string,content:string):File {const bytes=new TextEncoder().encode(content);return {name,size:bytes.length,arrayBuffer:async()=>bytes.buffer} as File;}
describe('Python from the ordinary archive and files picker',()=>{
    const choose=()=>{render();ui.selectSource!({target:{value:'files'}});render();};
    it('Hands a single Python source to the checked runtime upload instead of reporting no entrypoint',async()=>{
        choose();ui.selectFiles!([selectedFile('server.py','print("MCP")')]);await flush();
        expect(ui.uploadSelect).toHaveBeenCalledOnce();const html=render();
        expect(ui.source).toBe('upload');expect(html).not.toContain('В исходниках нет SKILL.md');expect(ui.submit).not.toHaveBeenCalled();
        const file=ui.uploadSelect.mock.calls[0][0] as File;expect(file.name).toBe('python-source.zip');expect(file.size).toBeGreaterThan(0);
    });
    it('Hands parsed Python archives over and submits only the durable checked handle after an explicit click',async()=>{
        choose();vi.mocked(readPackagingArchive).mockResolvedValue({files:[{path:'server.py',content:'print("MCP")'}],skipped:0,rootName:'python-tool'});
        ui.selectFiles!([selectedFile('source.tar','source archive')],true);await flush();expect(ui.uploadSelect).toHaveBeenCalledOnce();
        ui.upload={id:'22222222-2222-4222-8222-222222222222',requestKey:'11111111-1111-4111-8111-111111111111',name:'python-source.zip',bytes:100,sha256:'a'.repeat(64),expiresAt:'2027-01-01',state:'READY',metadata:{name:'python-tool',adapter:'python',candidates:['server.py'],choices:[{entrypoint:'server.py',adapter:'python',targets:['darwin-arm64']}],entrypoint:'server.py',runnableKinds:['mcp'],requiresEntrypointChoice:false}};
        render();expect(ui.submit).not.toHaveBeenCalled();ui.finish!();await flush();
        expect(ui.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({kind:'mcp',name:'python-tool',source:{type:'upload',uploadId:ui.upload.id,sha256:ui.upload.sha256,bytes:100,entrypoint:'server.py'}}));
    });
    it.each(['close','project','owner','source'] as const)('Never starts a late Python upload after %s changes',async change=>{
        choose();const pending=deferred<ArrayBuffer>();
        ui.selectFiles!([{...selectedFile('server.py','print(1)'),arrayBuffer:()=>pending.promise} as File]);
        if(change==='close')ui.close!();if(change==='project')ui.projectId='project-b';if(change==='owner')ui.scope='admin-b';if(change==='source')ui.selectSource!({target:{value:'npm'}});
        render();pending.resolve(new TextEncoder().encode('print(1)').buffer);await flush();render();expect(ui.uploadSelect).not.toHaveBeenCalled();expect(ui.submit).not.toHaveBeenCalled();
    });
    it('Recreates identical sanitized bytes from the original Python archive to resume an existing intent',async()=>{
        choose();vi.mocked(readPackagingArchive).mockResolvedValue({files:[{path:'server.py',content:'print(1)'}],skipped:0,rootName:'tool'});
        const original=selectedFile('tool.tar','source archive');ui.selectFiles!([original],true);await flush();
        const first=ui.uploadSelect.mock.calls[0][0] as File;
        ui.uploadIntent={requestKey:'11111111-1111-4111-8111-111111111111',name:first.name,bytes:first.size,sha256:'a'.repeat(64)};
        render();ui.selectSource!({target:{value:'files'}});render();ui.selectFiles!([original],true);await flush();render();
        expect(ui.uploadSelect).toHaveBeenCalledTimes(2);expect(ui.source).toBe('upload');
        expect(new Uint8Array(await (ui.uploadSelect.mock.calls[1][0] as File).arrayBuffer())).toEqual(new Uint8Array(await first.arrayBuffer()));
        expect(ui.submit).not.toHaveBeenCalled();
    });
    it('Hands an existing intent to the upload identity check before any new Python submission',async()=>{
        ui.uploadIntent={requestKey:'11111111-1111-4111-8111-111111111111',name:'old.zip',bytes:100,sha256:'a'.repeat(64)};choose();
        ui.uploadSelect.mockImplementation(async()=>{ui.uploadError='Другой файл не отправится под её UUID.';});
        ui.selectFiles!([selectedFile('server.py','print(1)')]);await flush();render();expect(ui.uploadSelect).toHaveBeenCalledOnce();expect(ui.source).toBe('upload');expect(ui.submit).not.toHaveBeenCalled();
    });
    it('Rejecting a new Python archive cannot submit a different recovered READY upload',async()=>{
        ui.uploadIntent={requestKey:'11111111-1111-4111-8111-111111111111',name:'old.zip',bytes:100,sha256:'a'.repeat(64)};
        ui.upload={id:'22222222-2222-4222-8222-222222222222',...ui.uploadIntent,expiresAt:'2027-01-01',state:'READY',metadata:{adapter:'python',candidates:['old.py'],choices:[{entrypoint:'old.py',adapter:'python',targets:['darwin-arm64']}],entrypoint:'old.py',runnableKinds:['mcp'],requiresEntrypointChoice:false}};
        choose();ui.uploadSelect.mockImplementation(async()=>{ui.uploadError='Другой файл не отправится под её UUID.';});ui.selectFiles!([selectedFile('server.py','print(1)')]);await flush();
        render();expect(ui.source).toBe('upload');expect(ui.buttons.get('Выберите команду запуска')?.disabled).toBe(true);
        ui.finish!();await flush();expect(ui.uploadSelect).toHaveBeenCalledOnce();expect(ui.submit).not.toHaveBeenCalled();
    });
    it.each(['unresolved','recoveryBlocked'] as const)('Blocks Python selection and drop while build is %s',async state=>{
        choose();ui[state]=true;render();expect(ui.pickerDisabled).toBe(true);
        ui.selectFiles!([selectedFile('server.py','print(1)')]);await flush();expect(ui.uploadSelect).not.toHaveBeenCalled();
        expect(ui.submit).not.toHaveBeenCalled();expect(ui.source).toBe('files');
    });
    it('Does not turn invalid archive errors into a different upload',async()=>{
        choose();vi.mocked(readPackagingArchive).mockRejectedValue(Error('Ссылки в архиве запрещены'));
        ui.selectFiles!([selectedFile('bad.zip','bad')],true);await flush();expect(render()).toContain('Ссылки в архиве запрещены');expect(ui.uploadSelect).not.toHaveBeenCalled();
    });
    it('Keeps a skill containing Python scripts and a JS tool containing Python helpers in their original flow',async()=>{
        choose();ui.selectFiles!([selectedFile('SKILL.md',skillText),selectedFile('scripts/check.py','print(1)')]);await flush();render();render();
        expect(ui.source).toBe('files');expect(ui.kind).toBe('skill');expect(ui.uploadSelect).not.toHaveBeenCalled();
        ui.selectFiles!([selectedFile('index.js','console.log(1)'),selectedFile('test.py','print(1)')]);await flush();render();render();expect(ui.source).toBe('files');expect(ui.uploadSelect).not.toHaveBeenCalled();
    });
});
async function chooseSkill(content=skillText){render();ui.selectSource!({target:{value:'files'}});render();ui.selectFiles!([selectedFile('SKILL.md',content),selectedFile('references/rules.md','Проверь ошибки и граничные случаи.')]);await flush();render();return render();}

describe('Упаковка скилла через тот же поток',()=>{
    it('SKILL.md автоматически определяет тип, название и описание; ресурсы уходят без JS entrypoint',async()=>{
        const html=await chooseSkill();expect(ui.kind).toBe('skill');expect(html).toContain('careful-reviewer');expect(html).toContain('Инструкция определена: SKILL.md');
        expect(ui.buttons.get('Упаковать и добавить')?.disabled).toBe(false);ui.finish!();await flush();
        expect(ui.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({kind:'skill',name:'careful-reviewer',description:'Проверяет изменения и важные риски',source:{type:'files',entrypoint:'SKILL.md',files:[{path:'SKILL.md',content:skillText},{path:'references/rules.md',content:'Проверь ошибки и граничные случаи.'}]}}));
    });
    it('Некорректный SKILL.md блокирует отправку, исправление исходников снимает ошибку',async()=>{
        let html=await chooseSkill('---\nname: [broken\n---\nТекст');expect(html).toContain('некорректный YAML');ui.finish!();await flush();expect(ui.submit).not.toHaveBeenCalled();
        ui.selectFiles!([selectedFile('SKILL.md',skillText),selectedFile('references/rules.md','Проверь код')]);await flush();render();html=render();expect(html).not.toContain('некорректный YAML');ui.finish!();await flush();expect(ui.submit).toHaveBeenCalledOnce();
    });
    it('Замена скилла исходниками JS сбрасывает автоматический тип и требует реальный JS файл',async()=>{
        await chooseSkill();ui.selectFiles!([selectedFile('index.ts','console.log("MCP");')]);await flush();render();render();expect(ui.kind).toBe('mcp');ui.finish!();await flush();expect(ui.submit).toHaveBeenCalledWith(expect.objectContaining({kind:'mcp',source:expect.objectContaining({entrypoint:'index.ts'})}));
    });
    it.each(['npm','upload'])('Источник %s явно исключает скилл и сбрасывает предыдущий выбор',async source=>{
        await chooseSkill();ui.selectSource!({target:{value:source}});const html=render();expect(ui.kind).toBe('mcp');expect(ui.kinds.find(kind=>kind.value==='skill')?.disabled).toBe(true);expect(html.toLowerCase()).toContain('скилл');
    });
    it('Репозиторий с SKILL.md закрепляет commit и подпапку без команды запуска',async()=>{
        render();ui.selectSource!({target:{value:'repository'}});render();input('Ссылка на репозиторий GitHub','https://github.com/team/skills');
        ui.repositoryMetadata={url:'https://github.com/team/skills',commit:'a'.repeat(40),ref:'main',subdirectory:'skills/careful-reviewer',entrypoint:'SKILL.md',candidates:['SKILL.md'],name:'careful-reviewer',description:'Проверяет изменения',recommendedKind:'skill',runnableKinds:['skill']};
        const html=render();render();expect(html).toContain('Инструкция скилла');ui.finish!();await flush();expect(ui.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({kind:'skill',source:{type:'repository',url:'https://github.com/team/skills',ref:'a'.repeat(40),subdirectory:'skills/careful-reviewer',entrypoint:'SKILL.md'}}));
    });
    it('Прямая ссылка на SKILL.md становится проверенным источником с commit, без blob-URL в POST',async()=>{
        render(); const preventDefault=vi.fn();
        ui.inputs.get('npm-пакет или ссылка')!.onPaste!({clipboardData:{getData:()=> 'https://github.com/team/skills/blob/main/skills/careful-reviewer/SKILL.md#L4'},preventDefault});
        render();expect(ui.source).toBe('repository');
        ui.repositoryMetadata={url:'https://github.com/team/skills',commit:'c'.repeat(40),ref:'main',subdirectory:'skills/careful-reviewer',entrypoint:'SKILL.md',candidates:['SKILL.md'],name:'careful-reviewer',description:'Проверяет изменения',recommendedKind:'skill',runnableKinds:['skill']};
        render();render();ui.finish!();await flush();
        expect(preventDefault).toHaveBeenCalledOnce();
        expect(ui.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({kind:'skill',source:{type:'repository',url:'https://github.com/team/skills',ref:'c'.repeat(40),subdirectory:'skills/careful-reviewer',entrypoint:'SKILL.md'}}));
    });
    it('Находит SKILL.md во вложенной папке архива и сохраняет полный путь в запросе',async()=>{
        render();ui.selectSource!({target:{value:'files'}});render();ui.selectFiles!([selectedFile('README.md','Опись архива'),selectedFile('download/my-skill/SKILL.md',skillText),selectedFile('download/my-skill/references/rules.md','Правила')]);await flush();render();let html=render();
        expect(ui.kind).toBe('skill');expect(html).toContain('download/my-skill/SKILL.md');ui.finish!();await flush();expect(ui.submit).toHaveBeenCalledWith(expect.objectContaining({kind:'skill',source:expect.objectContaining({entrypoint:'download/my-skill/SKILL.md'})}));
    });
    it('Несколько SKILL.md показывают выбор по пути и до выбора POST не отправляется',async()=>{
        render();ui.selectSource!({target:{value:'files'}});render();ui.selectFiles!(['first','second'].flatMap(root=>[selectedFile(root+'/SKILL.md',skillText),selectedFile(root+'/references/rules.md',root)]));await flush();render();render();
        expect(ui.buttons.get('Выберите скилл')?.disabled).toBe(true);ui.finish!();await flush();expect(ui.submit).not.toHaveBeenCalled();render();ui.selects.get('Скилл в исходниках')!.onChange('second/SKILL.md');render();render();
        ui.finish!();await flush();expect(ui.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({kind:'skill',source:expect.objectContaining({entrypoint:'second/SKILL.md'})}));
    });
    it('Архив с папкой-обёрткой сохраняет вложенную инструкцию и base64 ресурс в POST',async()=>{
        const files=[{path:'README.md',content:'Опись'}, {path:'bundle/review/SKILL.md',content:skillText},{path:'bundle/review/references/rules.md',content:'Правила'},{path:'bundle/review/assets/image.png',content:'iVBORw0KGgoA//4=',encoding:'base64' as const}];
        vi.mocked(readPackagingArchive).mockResolvedValue({files,skipped:0});
        render();ui.selectSource!({target:{value:'files'}});render();ui.selectFiles!([selectedFile('review.zip','synthetic archive')],true);await flush();render();render();
        ui.finish!();await flush();expect(ui.submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({kind:'skill',source:{type:'files',entrypoint:'bundle/review/SKILL.md',files}}));
    });
});

describe('Отмена сборки отличается от скрытия окна',()=>{
    it('Скрыть сохраняет сборку, отдельная отмена вызывает серверное действие',async()=>{
        ui.active=true;ui.canCancel=true;ui.job={id:'existing',operationId:'operation',state:'RUNNING',percent:10,message:'Проверяем'};
        render();expect(ui.buttons.has('Отменить сборку')).toBe(true);
        ui.buttons.get('Скрыть')!.onClick!();expect(ui.open).toBe(false);expect(ui.cancel).not.toHaveBeenCalled();
        ui.open=true;render();ui.buttons.get('Отменить сборку')!.onClick!();await flush();expect(ui.cancel).toHaveBeenCalledOnce();expect(ui.open).toBe(true);
    });
    it('После подтверждённой отмены возвращает заполненную форму, без нового POST',async()=>{
        ready();input('Название в каталоге','Моя ручная карточка');input('Описание инструмента','Моё описание');render();
        ui.cancelled=true;ui.job={id:'existing',operationId:'operation',state:'CANCELLED',percent:10,message:'Отменено'};
        let html=render();expect(html).toContain('Упаковка отменена');expect(ui.buttons.has('Вернуться к исходникам')).toBe(true);
        ui.buttons.get('Вернуться к исходникам')!.onClick!();await flush();html=render();
        expect(ui.inputs.get('Название в каталоге')?.value).toBe('Моя ручная карточка');expect(ui.inputs.get('Описание инструмента')?.value).toBe('Моё описание');expect(ui.submit).not.toHaveBeenCalled();
    });
    it('Потерянный ответ отмены предлагает повторить DELETE и не повторять сохранённый POST',async()=>{
        ui.cancelPending=true;ui.unresolved=true;render();
        expect(ui.buttons.has('Повторить отмену')).toBe(true);expect(ui.buttons.has('Повторить сохранённый запрос')).toBe(false);
        ui.buttons.get('Повторить отмену')!.onClick!();await flush();expect(ui.retryCancel).toHaveBeenCalledOnce();expect(ui.submit).not.toHaveBeenCalled();
    });
    it('Незавершённая очистка показывает причину сервера и доступный повтор, без подтверждения отмены',async()=>{
        ui.active=true;ui.cancelPending=true;ui.job={id:'existing',operationId:'operation',requestKey:'11111111-1111-4111-8111-111111111111',publicationStartedAt:null,state:'CANCELLING',percent:30,
            message:'Сборщик остановлен; очистка временных файлов будет повторена.',error:'Не удалось очистить временные файлы. Отмена ещё не завершена.'};
        const html=render();expect(html).toContain(ui.job.message);expect(html).toContain(ui.job.error);
        expect(html).not.toContain('Отмена подтверждена сервером');expect(ui.buttons.has('Вернуться к исходникам')).toBe(false);
        expect(ui.buttons.has('Повторить отмену')).toBe(true);ui.buttons.get('Повторить отмену')!.onClick!();await flush();expect(ui.retryCancel).toHaveBeenCalledOnce();
    });
    it('Ожидание подтверждения прежнего worker показывает авторитетное продолжение и позволяет скрыть окно',()=>{
        ui.active=true;ui.cancelPending=true;ui.job={id:'existing',operationId:'operation',requestKey:'11111111-1111-4111-8111-111111111111',publicationStartedAt:null,state:'CANCELLING',percent:30,
            message:'Ожидаем подтверждение остановки прежнего сборщика. Можно продолжить работу и запустить другую сборку.'};
        const html=render();expect(html).toContain(ui.job.message);expect(html).not.toContain('Отмена подтверждена сервером');
        expect(ui.buttons.has('Повторить отмену')).toBe(true);ui.buttons.get('Скрыть')!.onClick!();expect(ui.open).toBe(false);expect(ui.reset).not.toHaveBeenCalled();
    });
    it('После границы публикации показывает продолжение без ложного обещания отмены',()=>{
        ui.active=true;ui.job={id:'existing',operationId:'operation',state:'RUNNING',percent:90,message:'Публикуем',publicationStartedAt:'2026-10-23T00:00:00.000Z'};
        const html=render();expect(ui.buttons.has('Отменить сборку')).toBe(false);expect(html).toContain('Публикация уже началась');expect(html).toContain('дождитесь результата');
    });
});

describe('Новая сборка после принятой отмены и доступный архив',()=>{
    it('Явный переход к новой сборке сохраняет ручные поля и не заявляет, что старая отменена',async()=>{
        ready();input('Название в каталоге','Ручная карточка');input('Описание инструмента','Точное описание');render();
        ui.active=true;ui.cancelPending=true;ui.canDetach=true;ui.job={id:'old',operationId:'op',state:'CANCELLING',percent:30,message:'Ожидаем подтверждение остановки прежнего сборщика.'};
        ui.detach.mockImplementation(async()=>{ui.active=false;ui.cancelPending=false;ui.canDetach=false;ui.job=undefined;return true;});
        const html=render();expect(html).toContain('Можно начать другую сборку');expect(html).not.toContain('Отмена подтверждена сервером');
        ui.buttons.get('К новой сборке')!.onClick!();await flush();render();
        expect(ui.detach).toHaveBeenCalledOnce();expect(ui.reset).not.toHaveBeenCalled();expect(ui.inputs.get('Название в каталоге')?.value).toBe('Ручная карточка');expect(ui.inputs.get('Описание инструмента')?.value).toBe('Точное описание');expect(ui.submit).not.toHaveBeenCalled();
    });
    it('Неизвестный DELETE ACK не показывает переход даже при видимом CANCELLING',()=>{
        ui.active=true;ui.cancelPending=true;ui.job={id:'old',operationId:'op',state:'CANCELLING',percent:30,message:'Ожидаем остановку'};
        render();expect(ui.buttons.has('К новой сборке')).toBe(false);expect(ui.buttons.has('Повторить отмену')).toBe(true);
    });
    it('Сохранённый запрос открывается отдельным действием; активная B защищена от перезаписи',async()=>{
        const key='11111111-1111-4111-8111-111111111111';ui.archived=[{requestKey:key,jobId:'old-job',name:'Старая карточка'}];ui.canRestoreArchived=true;
        const html=render();expect(html).toContain('Старая карточка');expect(html).toContain('Открытие вернёт сохранённые исходники');
        ui.buttons.get('Открыть сохранённый запрос')!.onClick!();await flush();expect(ui.restoreArchived).toHaveBeenCalledExactlyOnceWith(key);expect(ui.submit).not.toHaveBeenCalled();
        ui.active=true;ui.canRestoreArchived=false;render();expect(ui.buttons.get('Открыть сохранённый запрос')?.disabled).toBe(true);
    });
});
