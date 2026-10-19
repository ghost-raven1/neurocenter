import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { IAiPlugin, IBundlePackage, IDependencyPin, ISkillFile } from '../src/core/api/interfaces';
import { appendDependencyPin, checkDependencyPins, readDependencyPin } from '../src/modules/Store/publication/dependencyPins';
import { DependencyPinsEditor } from '../src/modules/Store/publication/DependencyPinsEditor';
import { publicationPayload } from '../src/modules/Store/publication/publicationDraft';
import { pluginEditPayload, skillEditPayload, storeEditValuesChanged } from '../src/modules/Store/storeEditHelpers';

const pin: IDependencyPin = {kind: 'mcp', id: 'ai-plug-search', version: 2, manifest: 'a'.repeat(64)};
const values = {name: 'Помощник', description: 'Описание', tags: '', body: 'Инструкция', config: '{"transport":"remote","url":"https://example.org/mcp"}'};
const pkg = (): IBundlePackage => ({schemaVersion: 4, plugin:{id: pin.id, name: 'Поиск', kind: pin.kind, version: pin.version}, config: null, files: [], manifest:{sha256: pin.manifest, createdAt: '2026-10-17', filesCount: 0}});

describe('Закреплённые зависимости в редакторах', () => {
    it('Запрашивает только выбранный номер версии, даже если в каталоге уже новый head', async () => {
        const getAiPluginPackage = vi.fn().mockResolvedValue(pkg());
        expect(await readDependencyPin({getAiPluginPackage}, {id: pin.id, kind: pin.kind}, 2)).toEqual(pin);
        expect(getAiPluginPackage).toHaveBeenCalledExactlyOnceWith(pin.id, 2);
    });
    it.each([
        {plugin:{...pkg().plugin, id:'ai-plug-other'}},
        {plugin:{...pkg().plugin, version:3}},
        {plugin:{...pkg().plugin, kind:'plugin'}},
        {manifest:{...pkg().manifest, sha256:'broken'}},
    ])('Не закрепляет ошибочный ответ с другой идентичностью: %j', async changes => {
        const getAiPluginPackage = vi.fn().mockResolvedValue({...pkg(), ...changes});
        await expect(readDependencyPin({getAiPluginPackage}, {id:pin.id,kind:pin.kind}, 2)).rejects.toThrow('Зависимость не добавлена');
    });
    it('Не отправляет запрос без явной положительной версии', async () => {
        const getAiPluginPackage = vi.fn();
        await expect(readDependencyPin({getAiPluginPackage}, pin, NaN)).rejects.toThrow('конкретную версию');
        expect(getAiPluginPackage).not.toHaveBeenCalled();
    });
    it('Сетевой отказ не подставляет текущую версию вместо выбранной', async () => {
        const getAiPluginPackage = vi.fn().mockRejectedValue(new Error('Нет связи'));
        await expect(readDependencyPin({getAiPluginPackage}, pin, 2)).rejects.toThrow('Нет связи');
        expect(getAiPluginPackage).toHaveBeenCalledExactlyOnceWith(pin.id, 2);
    });
    it('Не заменяет существующий pin другой версией или дублем и не меняет исходный массив', () => {
        const original = [pin];
        expect(() => appendDependencyPin(original, {...pin,version:3})).toThrow('несколько раз');
        expect(() => appendDependencyPin([], pin, pin.id)).toThrow('самого себя');
        expect(original).toEqual([pin]);
    });
    it.each([
        [{...pin,kind:'skill'}], [{...pin,id:'Свободное имя'}], [{...pin,version:0}], [{...pin,version:Number.MAX_SAFE_INTEGER + 1}],
        [{...pin,manifest:'A'.repeat(64)}], [{...pin,unexpected:true}], Array.from({length:21},(_,i)=>({...pin,id:`ai-plug-${i}`})),
    ])('Отклоняет неполные, неподдерживаемые и лишние требования: %j', pins => { expect(() => checkDependencyPins(pins)).toThrow(); });
    it('Стабильно упорядочивает pins, не изменяя выбранные версии и хэши', () => {
        const plugin: IDependencyPin = {...pin,kind:'plugin',id:'ai-plug-a'};
        expect(checkDependencyPins([plugin,pin])).toEqual([pin,plugin]);
    });
    it('Передаёт зависимости скилла в meta, MCP и плагина в верхнем уровне', () => {
        const skill = publicationPayload({...values,kind:'skill',slug:'helper',instruction:'Инструкция',dependencies:[pin]},[]);
        expect(skill).toHaveProperty('meta.dependencies',[pin]); expect(skill).not.toHaveProperty('dependencies');
        const mcp = publicationPayload({...values,kind:'mcp',mode:'remote',url:'https://example.org/mcp',dependencies:[pin]},[]);
        expect(mcp).toHaveProperty('dependencies',[pin]); expect(mcp).not.toHaveProperty('meta');
        const plugin = publicationPayload({...values,kind:'plugin',entrypoint:'index.js',dependencies:[pin]},[{path:'index.js',content:'export default {}'}]);
        expect(plugin).toHaveProperty('dependencies',[pin]);
    });
    it('Старый черновик не удаляет pins, а явное удаление всех передаёт пустой массив', () => {
        const skill = {meta:{version:4,dependencies:[pin]}} as ISkillFile;
        expect(skillEditPayload(skill,values).meta).not.toHaveProperty('dependencies');
        expect(skillEditPayload(skill,{...values,dependencies:[]}).meta).toHaveProperty('dependencies',[]);
        const plugin = {id:'ai-plug-parent',kind:'mcp',version:5,dependencies:[pin]} as IAiPlugin;
        expect(pluginEditPayload(plugin,values)).not.toHaveProperty('dependencies');
        expect(pluginEditPayload(plugin,{...values,dependencies:[]})).toMatchObject({dependencies:[],expectedVersion:5});
    });
    it('Добавление pins не стирает старые требования без явного выбора пользователя', () => {
        const skill = {meta:{version:4,mcp:['старый сервер'],plugins:['старый плагин']}} as ISkillFile;
        const next = skillEditPayload(skill,{...values,dependencies:[pin]});
        expect(next.meta).not.toHaveProperty('mcp'); expect(next.meta).not.toHaveProperty('plugins');
        expect(skillEditPayload(skill,{...values,dependencies:[pin],clearLegacyRequirements:true}).meta).toMatchObject({mcp:[],plugins:[],dependencies:[pin]});
        expect(skill.meta.mcp).toEqual(['старый сервер']);
    });
    it('Добавление и удаление pin обратно в исходное состояние восстанавливает чистый черновик', () => {
        expect(storeEditValuesChanged(values,{...values,dependencies:[pin]})).toBe(true);
        expect(storeEditValuesChanged(values,{...values,dependencies:[]})).toBe(false);
        expect(storeEditValuesChanged({...values,dependencies:[pin]},{...values,dependencies:[]})).toBe(true);
        expect(storeEditValuesChanged({...values,dependencies:[pin]},{...values,dependencies:[pin]})).toBe(false);
        expect(storeEditValuesChanged(values,{...values,clearLegacyRequirements:true})).toBe(true);
        expect(storeEditValuesChanged(values,{...values,clearLegacyRequirements:false})).toBe(false);
    });
    it('Показывает сохранённый ID и полный хэш до загрузки каталога, не выдавая его за head', () => {
        const html = renderToStaticMarkup(createElement(DependencyPinsEditor,{value:[pin],disabled:true}));
        expect(html).toContain(pin.id); expect(html).toContain(pin.manifest); expect(html).toContain('версия 2');
        expect(html).toContain('новые версии не подставляются автоматически');
    });
});
