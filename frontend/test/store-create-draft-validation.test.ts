import './feature-flags-enabled';
import {cloneElement, createElement, isValidElement, type ReactElement, type ReactNode} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import StoreCreateModal from '../src/modules/Store/StoreCreateModal';
import bffApi from '../src/core/api/bff';
import type {IPublicationDraft} from '../src/modules/Store/publication/publicationDraft';

interface Control {value?: unknown; options?: Array<{value: string}>; onChange?: (value: unknown) => void;}
const ui = vi.hoisted(() => ({
    cursor: 0, slots: [] as Array<{value: unknown}>, open: true,
    values: {} as IPublicationDraft, fields: new Map<string, Control>(), errors: [] as string[],
    buttons: new Map<string, {onClick?: () => void}>(), submit: undefined as ((values: IPublicationDraft) => void) | undefined,
    valuesChange: undefined as ((changed: Partial<IPublicationDraft>, values: IPublicationDraft) => void) | undefined,
    reset: vi.fn(), setFields: vi.fn(), close: vi.fn(), created: vi.fn(),
}));
vi.mock('react', async original => ({...await original<typeof import('react')>(),
    useState: (initial: unknown) => {
        const slot = ui.slots[ui.cursor++] ??= {value: initial};
        return [slot.value, (value: unknown) => {slot.value = value;}];
    },
    useRef: (initial: unknown) => (ui.slots[ui.cursor++] ??= {value: {current: initial}}).value,
}));
vi.mock('../src/features/UserBlock/useAuthRequestOwner', () => ({useAuthRequestOwner: () => ({captureOwner: () => () => true})}));
vi.mock('../src/core/api/bff', () => ({default: {createSkill: vi.fn(), createAiPlugin: vi.fn()}}));
vi.mock('../src/modules/Store/publication/SkillResourceEditor', () => ({SkillResources: () => null}));
vi.mock('../src/modules/Store/publication/DependencyPinsEditor', () => ({DependencyPinsEditor: () => null}));
vi.mock('antd', () => {
    const content = ({children}: {children?: ReactNode}) => children;
    const control = (props: Control & {'data-field'?: string; 'aria-label'?: string}) => {
        const name = props['data-field'] || props['aria-label']; if (name) ui.fields.set(name, props); return null;
    };
    return {
        Form: Object.assign(({children, onFinish, onValuesChange}: {children?: ReactNode; onFinish: typeof ui.submit; onValuesChange: typeof ui.valuesChange}) => {
            ui.submit = onFinish; ui.valuesChange = onValuesChange; return children;
        }, {
            Item: ({name, children}: {name?: keyof IPublicationDraft; children?: ReactNode}) => !name || !isValidElement(children) ? children : cloneElement(children as ReactElement<Record<string, unknown>>, {
                'data-field': name, value: ui.values[name], onChange: (input: unknown) => {
                    const value = input && typeof input === 'object' && 'target' in input ? (input as {target: {value: unknown}}).target.value : input;
                    ui.values = {...ui.values, [name]: value}; ui.valuesChange?.({[name]: value}, ui.values);
                },
            }),
            useForm: () => [{resetFields: ui.reset, getFieldValue: (name: keyof IPublicationDraft) => ui.values[name], setFieldsValue: ui.setFields}],
            useWatch: (name: keyof IPublicationDraft) => ui.values[name],
        }),
        Input: Object.assign(control, {TextArea: control}), Radio: {Group: control}, Select: control, Checkbox: content,
        Button: (props: {children?: ReactNode; onClick?: () => void}) => {ui.buttons.set(Array.isArray(props.children) ? props.children.join('') : String(props.children), props); return null;},
        Modal: ({open, children}: {open: boolean; children?: ReactNode}) => open ? children : null,
        Alert: ({type, message}: {type: string; message: string}) => {if (type === 'error') ui.errors.push(message); return null;},
        Space: content, Typography: {Paragraph: content, Text: content}, message: {success: vi.fn()},
    };
});
function render() {
    ui.cursor = 0; ui.fields.clear(); ui.errors = []; ui.buttons.clear();
    renderToStaticMarkup(createElement(StoreCreateModal, {open: ui.open, onClose: ui.close, onCreated: ui.created, onPackage: vi.fn()}));
}
function change(name: string, value: unknown) {expect(ui.fields.has(name)).toBe(true); ui.fields.get(name)!.onChange!({target: {value}}); render();}
function click(label: string) {expect(ui.buttons.has(label)).toBe(true); ui.buttons.get(label)!.onClick!(); render();}
async function submit() {ui.submit!({...ui.values}); for (let index = 0; index < 8; index++) await Promise.resolve(); render();}
function addFile(index: number, name: string, content: string) {
    click('Добавить текстовый файл'); change(`Путь файла ${index}`, name); change(`Содержимое файла ${index}`, content);
}
beforeEach(() => {
    vi.resetAllMocks(); ui.slots = []; ui.open = true;
    ui.values = {kind: 'skill', mode: 'remote', name: 'Фикстура', description: 'Описание фикстуры', slug: 'Bad_Skill', instruction: 'Инструкция фикстуры'};
    ui.setFields.mockImplementation((next: Partial<IPublicationDraft>) => {ui.values = {...ui.values, ...next};});
    ui.close.mockImplementation(() => {ui.open = false;});
});

describe('Ошибка ручной публикации принадлежит текущему черновику', () => {
    it('Ошибка slug исчезает при переключении типа и не возвращается вместе с сохранёнными полями', async () => {
        render(); await submit(); expect(ui.errors.join()).toContain('Идентификатор скилла:');
        change('kind', 'mcp'); expect(ui.errors).toEqual([]);
        change('kind', 'skill'); expect(ui.errors).toEqual([]);
        expect(ui.values).toMatchObject({name: 'Фикстура', slug: 'Bad_Skill', instruction: 'Инструкция фикстуры'});
        expect(ui.reset).not.toHaveBeenCalled(); expect(bffApi.createSkill).not.toHaveBeenCalled(); expect(bffApi.createAiPlugin).not.toHaveBeenCalled();
    });

    it('Смена режима MCP скрывает прежнюю ошибку заголовков и сохраняет её исходный текст', async () => {
        ui.values = {...ui.values, kind: 'mcp', url: 'https://example.test/mcp', headers: '{'};
        render(); await submit(); expect(ui.errors.join()).toContain('Заголовки: проверьте JSON');
        change('mode', 'bundle'); expect(ui.errors).toEqual([]); change('mode', 'remote'); expect(ui.errors).toEqual([]);
        expect(ui.values.headers).toBe('{'); expect(ui.reset).not.toHaveBeenCalled(); expect(bffApi.createAiPlugin).not.toHaveBeenCalled();
    });

    it('Исправление текущего поля отзывает ошибку, закрытие и повторное открытие сохраняют остальные поля', async () => {
        render(); await submit(); change('slug', 'fixture-skill'); expect(ui.errors).toEqual([]);
        click('Закрыть'); ui.open = true; render();
        expect(ui.values).toMatchObject({name: 'Фикстура', description: 'Описание фикстуры', slug: 'fixture-skill', instruction: 'Инструкция фикстуры'});
        expect(ui.reset).not.toHaveBeenCalled(); expect(ui.created).not.toHaveBeenCalled();
    });

    it.each(['plugin', 'mcp'] as const)('%s: удаление выбранного пустого файла отзывает ошибку и старую точку входа', async kind => {
        ui.values = {...ui.values, kind, mode: 'bundle'}; render();
        addFile(1, 'index.js', ''); addFile(2, 'helper.js', 'export const fixture = true;'); change('entrypoint', 'index.js');
        await submit(); expect(ui.errors.join()).toContain('Укажите непустой файл запуска');
        click('Удалить файл 1');
        expect(ui.errors).toEqual([]); expect(ui.fields.get('entrypoint')!.value).toBeUndefined();
        expect(ui.fields.get('entrypoint')!.options).toEqual([{value: 'helper.js', label: 'helper.js'}]);
        expect(ui.fields.get('Содержимое файла 1')!.value).toBe('export const fixture = true;');
        expect(ui.values.name).toBe('Фикстура'); expect(ui.reset).not.toHaveBeenCalled(); expect(bffApi.createAiPlugin).not.toHaveBeenCalled();
    });

    it.each(['plugin', 'mcp'] as const)('%s: переименование выбранного файла очищает только выбор точки входа', kind => {
        ui.values = {...ui.values, kind, mode: 'bundle'}; render();
        addFile(1, 'index.js', 'export default {};'); addFile(2, 'helper.js', 'export const fixture = true;'); change('entrypoint', 'index.js');
        change('Путь файла 1', 'renamed.js');
        expect(ui.fields.get('entrypoint')!.value).toBeUndefined();
        expect(ui.fields.get('Путь файла 2')!.value).toBe('helper.js'); expect(ui.fields.get('Содержимое файла 1')!.value).toBe('export default {};');
        expect(ui.values.name).toBe('Фикстура'); expect(ui.reset).not.toHaveBeenCalled();
    });

    it.each(['plugin', 'mcp'] as const)('%s: изменение содержимого и удаление другого файла сохраняют выбранную точку входа', kind => {
        ui.values = {...ui.values, kind, mode: 'bundle'}; render();
        addFile(1, 'index.js', 'export default {};'); addFile(2, 'helper.js', 'export const fixture = true;'); change('entrypoint', 'index.js');
        change('Содержимое файла 1', 'export default {fixture: true};'); click('Удалить файл 2');
        expect(ui.fields.get('entrypoint')!.value).toBe('index.js'); expect(ui.values.description).toBe('Описание фикстуры');
        expect(ui.fields.get('Содержимое файла 1')!.value).toBe('export default {fixture: true};'); expect(ui.reset).not.toHaveBeenCalled();
    });
});
