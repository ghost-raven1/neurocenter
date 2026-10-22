import { describe, expect, it } from 'vitest';
import { checkSkillResources, readSkillResources } from '../src/features/Catalog/publication/skillResourceFiles';
import { publicationPayload } from '../src/features/Catalog/publication/publicationDraft';
import { skillEditPayload } from '../src/features/Catalog/storeEditHelpers';
import type { ISkillFile } from '../src/core/api/interfaces';

describe('Ресурсы в формах скилла', () => {
    const resource = {path:'assets/пример.bin',content:'AP+A',encoding:'base64' as const};
    it('Публикация передаёт ресурсы только для скилла', () => {
        const skill=publicationPayload({kind:'skill',name:'Помощник',description:'Описание',slug:'helper',instruction:'Инструкция',resources:[resource]},[]);
        expect(skill).toHaveProperty('resources',[resource]);
        const mcp=publicationPayload({kind:'mcp',name:'MCP',description:'Описание',mode:'remote',url:'https://example.org/mcp',resources:[resource]},[]);
        expect(mcp).not.toHaveProperty('resources');
    });
    it('Редактирование явно передаёт удаление всех ресурсов, старый клиент не удаляет их отсутствующим полем', () => {
        const skill={meta:{version:2}} as ISkillFile;
        const values={name:'Помощник',description:'Описание',tags:'',body:'Инструкция',config:''};
        expect(skillEditPayload(skill,{...values,resources:[]})).toHaveProperty('resources',[]);
        expect(skillEditPayload(skill,values)).not.toHaveProperty('resources');
    });
    it('Читает бинарные файлы без преобразования UTF-8', async () => {
        const file={name:'пример.bin',size:3,webkitRelativePath:'',arrayBuffer:async()=>new Uint8Array([0,255,128]).buffer} as File;
        expect(await readSkillResources([file])).toEqual([resource]);
    });
    it('Сохраняет структуру папки скилла и пропускает отдельный SKILL.md', async () => {
        const file=(relative:string)=>({name:relative.split('/').pop(),size:1,webkitRelativePath:relative,arrayBuffer:async()=>new Uint8Array([65]).buffer} as File);
        const result=await readSkillResources([file('helper/SKILL.md'),file('helper/references/guide.md'),file('helper/scripts/check.js')]);
        expect(result.map(item=>item.path)).toEqual(['references/guide.md','scripts/check.js']);
    });
    it('Неверный файл блокирует весь импорт без частичного результата', async () => {
        const file={name:'large.bin',size:1048577,webkitRelativePath:'',arrayBuffer:async()=>new ArrayBuffer(0)} as File;
        await expect(readSkillResources([file])).rejects.toThrow('Лимит');
    });
    it('Отклоняет конфликт регистра, небезопасные пути и превышение бюджета', () => {
        expect(()=>checkSkillResources([resource,{...resource,path:'assets/ПРИМЕР.bin'}])).toThrow('конфликтуют');
        expect(()=>checkSkillResources([{...resource,path:'assets/../secret'}])).toThrow('путь');
        expect(()=>checkSkillResources([{path:'assets/large',content:'x'.repeat(1048577)}])).toThrow('Лимит');
    });
});
