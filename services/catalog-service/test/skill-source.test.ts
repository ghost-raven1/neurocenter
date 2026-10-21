import {describe,expect,it,vi} from 'vitest';
import {inspectSkillSource} from '../src/package-build/skill-source';
import {resolveRepositorySource,validateRepositorySource} from '../../shared/repository-source.cjs';
import {parseSkillSource} from '../../shared/skill-source.mjs';
import {JSON_SCHEMA,load} from 'js-yaml';

const yaml=(value:string)=>load(value,{schema:JSON_SCHEMA});
const instruction=(yaml='name: careful-reviewer\ndescription: Проверяет код и риски',body='Проверь изменения.')=>'---\n'+yaml+'\n---\n\n'+body;
const files=()=>[{path:'SKILL.md',content:instruction()},{path:'references/rules.md',content:'Граничные случаи'},{path:'scripts/build/check.py',content:'print("ok")'},{path:'assets/dist/template.md',content:'Шаблон'}];

describe('One strict skill source parser across preview and backend',()=>{
    it('SKILL.md и ресурсы не требуют JS entrypoint; ресурсы build/dist не пропадают',()=>{
        const parsed=inspectSkillSource(files());expect(parsed).toMatchObject({slug:'careful-reviewer',name:'careful-reviewer',description:'Проверяет код и риски',body:'\nПроверь изменения.',meta:{description:'Проверяет код и риски',mcp:[],plugins:[]}});
        expect(parsed.resources.map(file=>file.path)).toEqual(['assets/dist/template.md','references/rules.md','scripts/build/check.py']);
        expect(parsed).toEqual(parseSkillSource(files(),undefined,yaml));
    });
    it('BOM, CRLF и YAML folded description сохраняют смысл; overrides меняют карточку, сохраняя slug',()=>{
        const raw='\uFEFF'+instruction('name: careful-reviewer\ndescription: >-\n  Проверяет код\n  и риски').replaceAll('\n','\r\n');
        expect(inspectSkillSource([{path:'SKILL.md',content:raw}],{name:'Ревьюер',description:'Описание карточки'})).toMatchObject({slug:'careful-reviewer',name:'Ревьюер',description:'Описание карточки'});
    });
    it.each(['>','|'])('Стандартное YAML multiline description %s принимается без требований к chomping indicator',style=>{
        const content=instruction('name: careful-reviewer\ndescription: '+style+'\n  Проверяет код\n  и риски');
        expect(inspectSkillSource([{path:'SKILL.md',content}]).description).toBe('Проверяет код и риски');
    });
    it('Scope/version/actor из исходника не становятся authority metadata',()=>{
        const parsed=inspectSkillSource([{path:'SKILL.md',content:instruction('name: careful-reviewer\ndescription: Проверка\nscope: project\nprojectId: foreign\nowner: attacker\nversion: 900\narchivedAt: now')}]);
        expect(parsed.meta).toEqual({description:'Проверка',tags:[],mcp:[],plugins:[]});
    });
    it.each([
        ['duplicate YAML',instruction('name: first\nname: second\ndescription: Проверка')],
        ['malformed YAML',instruction('name: [broken\ndescription: Проверка')],
        ['array YAML',instruction('- first\n- second')],
        ['empty YAML',instruction('')],
        ['empty body',instruction('name: careful-reviewer\ndescription: Проверка','')],
        ['no slug',instruction('description: Проверка')],
        ['bad slug',instruction('name: ../escape\ndescription: Проверка')],
        ['long slug',instruction('name: '+ 'a'.repeat(65)+'\ndescription: Проверка')],
        ['no description',instruction('name: careful-reviewer')],
        ['MCP name dependency',instruction('name: careful-reviewer\ndescription: Проверка\nmcp: [server]')],
        ['native dependency',instruction('name: careful-reviewer\ndescription: Проверка\ndependencies: [{kind: mcp, id: server}]')],
        ['invalid tags',instruction('name: careful-reviewer\ndescription: Проверка\ntags: [null]')],
    ])('%s отклоняется понятным HTTP400, без публикации',(_label,content)=>{
        expect(()=>inspectSkillSource([{path:'SKILL.md',content}])).toThrow();
        try{inspectSkillSource([{path:'SKILL.md',content}]);}catch(error){expect(error).toMatchObject({status:400});}
    });
    it.each(['../escape.md','references/.env','assets/key.pem','scripts/id_rsa','references/CON.txt','references/trailing.','references\\bad.md','README.'])('Небезопасный ресурс %s отвергается',path=>{
        expect(()=>inspectSkillSource([...files(),{path,content:'fixture'}])).toThrow();
    });
    it.each(['references/RULES.md','references/rules.md/file','references','nested/SKILL.md','skill.md'])('Повторный или конфликтующий путь %s отвергается',path=>{
        expect(()=>inspectSkillSource([...files(),{path,content:instruction()}])).toThrow();
    });
    it('Root README/LICENSE source files не попадают в native resources',()=>{
        const parsed=inspectSkillSource([...files(),{path:'README.md',content:'Описание поставки'},{path:'LICENSE',content:'MIT'}]);
        expect(parsed.resources).toHaveLength(3);expect(parsed.resources.some(file=>file.path==='README.md')).toBe(false);
    });
    it('Единственный SKILL.md среди обёрток сохраняет ресурсы относительно папки скилла',()=>{
        const nested=files().map(file=>({...file,path:'archive/skills/first/'+file.path}));
        const result=inspectSkillSource([{path:'README.md',content:'Опись архива'},...nested]);expect(result).toMatchObject({slug:'careful-reviewer',entrypoint:'archive/skills/first/SKILL.md'});expect(result.resources.map(file=>file.path)).toEqual(['assets/dist/template.md','references/rules.md','scripts/build/check.py']);
    });
    it('Выбор одного из нескольких SKILL.md не включает соседние инструкции в ресурсы',()=>{
        const all=[...files().map(file=>({...file,path:'first/'+file.path})),...files().map(file=>({...file,path:'second/'+file.path}))];
        expect(()=>inspectSkillSource(all)).toThrow();const selected=inspectSkillSource(all,{entrypoint:'second/SKILL.md'});expect(selected.resources).toHaveLength(3);expect(selected.resources.some(file=>file.path.includes('first/'))).toBe(false);
    });
    it('Размер и тип ресурсов ограничены до публикации',()=>{
        expect(()=>inspectSkillSource([...files(),{path:'assets/large.txt',content:'x'.repeat(1024**2+1)}])).toThrow();
        expect(()=>inspectSkillSource([...files(),{path:'assets/binary.txt',content:'\0'}])).toThrow();
        expect(()=>inspectSkillSource(Array.from({length:101},(_,index)=>({path:'references/'+index+'.md',content:'x'})))).toThrow();
        expect(()=>inspectSkillSource([...files(),{path:'references/'+ 'a'.repeat(187)+'.md',content:'x'}])).toThrow();
    });
    it.each(['references/missing.md','../outside.md','file:///etc/passwd','references/%broken.md','%2e%2e/outside.md'])('Локальная ссылка %s, которую отвергнет мост, блокируется до публикации',target=>{
        expect(()=>inspectSkillSource([{path:'SKILL.md',content:instruction(undefined,'Прочитай [правила]('+target+').')}])).toThrow();
    });
    it('Ссылки на ресурсы и HTTPS/anchors принимаются; metadata-only не проверяет ещё не скачанные ресурсы',()=>{
        const content=instruction(undefined,'Прочитай [правила](./references/rules.md#check), [сайт](https://example.test), [секцию](#intro).');
        expect(inspectSkillSource([{path:'SKILL.md',content},...files().slice(1)])).toMatchObject({slug:'careful-reviewer'});
        expect(inspectSkillSource([{path:'SKILL.md',content}],{metadataOnly:true})).toMatchObject({slug:'careful-reviewer'});
    });
    it('Бинарные PNG/PDF ресурсы сохраняются в native base64 без перекодировки',()=>{
        const png=Buffer.from([137,80,78,71,13,10,26,10,0,255,254]),pdf=Buffer.from([37,80,68,70,45,49,46,55,10,0,255,254]);
        const resources=[{path:'assets/image.png',content:png.toString('base64'),encoding:'base64' as const},{path:'references/manual.pdf',content:pdf.toString('base64'),encoding:'base64' as const}];
        const parsed=inspectSkillSource([{path:'SKILL.md',content:instruction(undefined,'![образец](assets/image.png) и [инструкция](references/manual.pdf)')},...resources]);
        expect(parsed.resources).toEqual(resources);expect(Buffer.from(parsed.resources[0].content,'base64')).toEqual(png);expect(Buffer.from(parsed.resources[1].content,'base64')).toEqual(pdf);
    });
    it.each(['/w','/w===','/x==','garbage'])('Неканонический base64 %j не публикуется',content=>{
        expect(()=>inspectSkillSource([{path:'SKILL.md',content:instruction()},{path:'assets/image.png',content,encoding:'base64'}])).toThrow();
    });
    it('SKILL.md не принимает base64 даже с правильными байтами UTF-8',()=>{
        expect(()=>inspectSkillSource([{path:'SKILL.md',content:Buffer.from(instruction()).toString('base64'),encoding:'base64'}])).toThrow();
    });
});

const commit='a'.repeat(40),base='/repos/team/skills';
function githubFixture(options:{prefix?:string;content?:string;fileType?:string;status?:number}={}){
    const prefix=options.prefix??'',content=options.content??instruction();
    const fetch=vi.fn(async(url:URL|RequestInfo,init?:RequestInit)=>{
        expect(init?.redirect).toBe('error');
        const target=new URL(String(url));expect(target.origin).toBe('https://api.github.com');
        if(options.status)return Response.json({message:'upstream failure'},{status:options.status});
        if(target.pathname===base)return Response.json({private:false,default_branch:'main',name:'skills',description:'Набор скиллов'});
        if(target.pathname===base+'/commits/main')return Response.json({sha:commit});
        expect(target.searchParams.get('ref')).toBe(commit);
        const directory=base+'/contents'+(prefix?'/'+prefix:'');
        if(target.pathname===directory)return Response.json([{type:'file',name:'SKILL.md',size:Buffer.byteLength(content)},{type:'dir',name:'references'}]);
        if(target.pathname===directory+'/SKILL.md')return Response.json({type:options.fileType??'file',encoding:'base64',size:Buffer.byteLength(content),content:Buffer.from(content).toString('base64')});
        throw new Error('Unexpected synthetic GitHub request: '+target.pathname);
    });
    return fetch as typeof fetch&ReturnType<typeof vi.fn>;
}

describe('GitHub skill metadata pins the exact source commit',()=>{
    it.each(['','skills/careful-reviewer'])('Автоматически определяет root SKILL.md после выбора подпапки %s',async subdirectory=>{
        const fetch=githubFixture({prefix:subdirectory}),result=await resolveRepositorySource({url:'https://github.com/team/skills',...(subdirectory?{subdirectory}:{})},{fetch,inspectSkill:inspectSkillSource});
        expect(result).toMatchObject({url:'https://github.com/team/skills',commit,ref:'main',entrypoint:'SKILL.md',candidates:['SKILL.md'],recommendedKind:'skill',runnableKinds:['skill'],name:'careful-reviewer',description:'Проверяет код и риски'});
        expect(result.subdirectory).toBe(subdirectory||undefined);
        expect(result.runtimeSource).toBeUndefined();expect(result.adapter).toBeUndefined();
        expect(fetch).toHaveBeenCalledTimes(4);
        expect(validateRepositorySource({type:'repository',url:result.url,commit:result.commit,entrypoint:result.entrypoint,...(subdirectory?{subdirectory}:{})})).toMatchObject({commit,entrypoint:'SKILL.md'});
    });
    it('Явный SKILL.md проверяется в точном commit, без поисков JS',async()=>{
        const fetch=githubFixture();expect(await resolveRepositorySource({url:'https://github.com/team/skills',entrypoint:'SKILL.md'},{fetch,inspectSkill:inspectSkillSource})).toMatchObject({recommendedKind:'skill'});expect(fetch).toHaveBeenCalledTimes(3);
    });
    it.each(['symlink','dir'])('GitHub %s не принимается за SKILL.md',async fileType=>{
        await expect(resolveRepositorySource({url:'https://github.com/team/skills'},{fetch:githubFixture({fileType}),inspectSkill:inspectSkillSource})).rejects.toThrow();
    });
    it('Malformed YAML отклоняется до объявления готового metadata результата',async()=>{
        await expect(resolveRepositorySource({url:'https://github.com/team/skills'},{fetch:githubFixture({content:instruction('name: [broken')}),inspectSkill:inspectSkillSource})).rejects.toThrow('некорректный YAML');
    });
    it.each([403,404,429,500])('Отказ GitHub HTTP%s остаётся ошибкой без JS/npm fallback',async status=>{
        const fetch=githubFixture({status});await expect(resolveRepositorySource({url:'https://github.com/team/skills'},{fetch,inspectSkill:inspectSkillSource})).rejects.toThrow();expect(fetch).toHaveBeenCalledOnce();
    });
    it('Отсутствующий skill inspector не маскируется фиктивным MCP',async()=>{
        await expect(resolveRepositorySource({url:'https://github.com/team/skills'},{fetch:githubFixture()})).rejects.toThrow('Проверка SKILL.md недоступна');
    });
    it('URL с credentials отвергается до любого HTTP запроса',async()=>{
        const fetch=githubFixture();await expect(resolveRepositorySource({url:'https://owner:secret@github.com/team/skills'},{fetch,inspectSkill:inspectSkillSource})).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();
    });
});
