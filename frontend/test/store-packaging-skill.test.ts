import {describe,expect,it} from 'vitest';
import {skillPackagingSource} from '../src/modules/Store/packaging/skillPackagingSource';
import {packagingEntrypoints,readPackagingFiles} from '../src/modules/Store/packaging/sourceFiles';
import {packagingKind} from '../src/modules/Store/packaging/packagingKind';

const instruction='---\nname: careful-reviewer\ndescription: >-\n  Проверяет код\n  и риски\n---\n\nПроверь [правила](references/rules.md).';
const files=()=>[{path:'SKILL.md',content:instruction},{path:'references/rules.md',content:'Проверь границы.'},{path:'scripts/check.py',content:'print("ok")'},{path:'assets/template.txt',content:'Шаблон'}];

describe('Общий с сервером разбор скилла в упаковщике',()=>{
    it('Определяет скилл с YAML multiline description и сохраняет текстовые ресурсы',()=>{
        expect(skillPackagingSource(files())).toEqual({name:'careful-reviewer',description:'Проверяет код и риски'});
        expect(packagingEntrypoints(files(),'skill')).toEqual(['SKILL.md']);
        expect(packagingKind('mcp',{recommendedKind:'skill'},false)).toBe('skill');
    });
    it('Не принимает README за скилл; вложенный SKILL.md находит по полному пути',()=>{
        expect(skillPackagingSource([{path:'README.md',content:instruction}])).toBeUndefined();
        expect(packagingEntrypoints([{path:'skills/first/SKILL.md',content:instruction}],'skill')).toEqual(['skills/first/SKILL.md']);
    });
    it.each([
        ['пустая инструкция','---\nname: skill\ndescription: Описание\n---\n'],
        ['нет YAML','Просто текст без имени и описания'],
        ['нет закрытия YAML','---\nname: skill\ndescription: Описание'],
        ['битый YAML','---\nname: [broken\n---\nТекст'],
        ['плохой slug','---\nname: Unsafe Name\ndescription: Описание\n---\nТекст'],
        ['нет описания','---\nname: skill\n---\nТекст'],
        ['зависимости','---\nname: skill\ndescription: Описание\nmcp: [some-mcp]\n---\nТекст'],
    ])('%s возвращает понятную ошибку до отправки сборки',(_label,content)=>{
        expect(skillPackagingSource([{path:'SKILL.md',content}])?.error).toBeTruthy();
    });
    it.each(['skills/another/SKILL.md','references/SKILL.md','skill.md'])('Второй SKILL.md %s не превращается в ресурс',path=>{
        expect(skillPackagingSource([...files(),{path,content:instruction}])?.error).toBeTruthy();
    });
    it.each(['../escape.txt','references/.env','references/id_rsa','references/file.key','References/RULES.md'])('Небезопасный или конфликтующий путь %s отклоняется',path=>{
        expect(skillPackagingSource([...files(),{path,content:'fixture'}])?.error).toBeTruthy();
    });
    it('Чтение папки с ресурсами снимает общий корень и сохраняет содержимое SKILL.md',async()=>{
        const selection=files().map(file=>{const bytes=new TextEncoder().encode(file.content);return {name:file.path.split('/').at(-1)!,webkitRelativePath:'careful-reviewer/'+file.path,size:bytes.length,arrayBuffer:async()=>bytes.buffer};});
        const result=await readPackagingFiles(selection);expect(result.files).toEqual(files());expect(result.rootName).toBe('careful-reviewer');expect(result.skipped).toBe(0);
    });
    it('Текстовые scripts/build и assets/dist остаются ресурсами скилла',async()=>{
        const content=[...files(),{path:'scripts/build/check.py',content:'print("check")'},{path:'assets/dist/example.md',content:'Образец'}];
        const input=content.map(file=>{const bytes=new TextEncoder().encode(file.content);return {name:file.path,size:bytes.length,arrayBuffer:async()=>bytes.buffer};});
        const result=await readPackagingFiles(input);expect(result.files).toEqual(content);expect(result.skipped).toBe(0);expect(skillPackagingSource(result.files)?.error).toBeUndefined();
    });
    it('Обёртки архива и соседний README не мешают определению единственного скилла',()=>{
        const nested=files().map(file=>({...file,path:'download/my-skill/'+file.path}));
        expect(skillPackagingSource([{path:'README.md',content:'Опись'},...nested])).toEqual({name:'careful-reviewer',description:'Проверяет код и риски'});
    });
    it('Несколько скиллов требуют явного выбора реального пути, без выбора первого',()=>{
        const both=[...files().map(file=>({...file,path:'first/'+file.path})),...files().map(file=>({...file,path:'second/'+file.path}))];
        expect(packagingEntrypoints(both,'skill')).toEqual(['first/SKILL.md','second/SKILL.md']);
        expect(skillPackagingSource(both)?.error).toBeTruthy();
        expect(skillPackagingSource(both,{entrypoint:'second/SKILL.md'})).toEqual({name:'careful-reviewer',description:'Проверяет код и риски'});
    });
    it.each([
        ['assets/image.png',new Uint8Array([137,80,78,71,13,10,26,10,0,255,254])],
        ['references/manual.pdf',new Uint8Array([37,80,68,70,45,49,46,55,10,0,255,254])],
    ])('Бинарный ресурс %s переносится побайтно через штатный base64',async(path,bytes)=>{
        const text=new TextEncoder().encode(instruction),rules=new TextEncoder().encode('Правила'),result=await readPackagingFiles([{name:'SKILL.md',size:text.length,arrayBuffer:async()=>text.buffer},{name:'references/rules.md',size:rules.length,arrayBuffer:async()=>rules.buffer},{name:path,size:bytes.length,arrayBuffer:async()=>bytes.buffer}]);
        const resource=result.files.find(file=>file.path===path)!;expect(resource.encoding).toBe('base64');expect(Uint8Array.from(atob(resource.content),char=>char.charCodeAt(0))).toEqual(bytes);expect(skillPackagingSource(result.files)?.error).toBeUndefined();
    });
    it('Бинарный SKILL.md не превращается в текст с символами замены',async()=>{
        const bytes=new Uint8Array([255,254,0,1]);await expect(readPackagingFiles([{name:'SKILL.md',size:bytes.length,arrayBuffer:async()=>bytes.buffer}])).rejects.toThrow('UTF-8');
    });
    it('UTF-8 BOM текстового ресурса сохраняется побайтно, без скрытого удаления декодером',async()=>{
        const original=[...files(),{path:'references/bom.md',content:'\uFEFFЗапись с BOM'}],selected=original.map(file=>{const bytes=new TextEncoder().encode(file.content);return {name:file.path,size:bytes.length,arrayBuffer:async()=>bytes.buffer};});
        const result=await readPackagingFiles(selected),resource=result.files.find(file=>file.path==='references/bom.md')!;expect(resource.content).toBe('\uFEFFЗапись с BOM');expect(new TextEncoder().encode(resource.content)).toEqual(new TextEncoder().encode(original.at(-1)!.content));
    });
});
