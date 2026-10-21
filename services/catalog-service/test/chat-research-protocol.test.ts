import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {ChatResearchMcpClient,researchPublicUrl} from '../src/model-chat/chat-research-client';
import {researchCommand,researchPlannerPrompt} from '../src/model-chat/chat-research-planner';
import type {IPackage} from '../src/catalog/bundle-package';

const enabled={project:true,external:true},pkg={schemaVersion:5,plugin:{id:'search',name:'Поиск',kind:'mcp',version:1}}as IPackage;
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
beforeEach(()=>{vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','unit-internal-only');vi.stubEnv('API_GATEWAY_URL','http://127.0.0.1:4000');});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});

describe('Модель выбирает только один допустимый readonly шаг',()=>{
    it.each([
        {kind:'finish'}, {kind:'project_search',query:'как работает авторизация'}, {kind:'project_read',sourceId:'chunk-1'},
        {kind:'external_search',query:'NestJS docs',objective:'Find lifecycle reference',numResults:3},
        {kind:'external_fetch',urls:['https://docs.nestjs.com/fundamentals/lifecycle-events'],maxCharacters:4000},
    ])('Принимает %j без исполнения команд',command=>{expect(researchCommand(JSON.stringify(command),enabled)).toEqual(command);});
    it('Принимает единственный fenced JSON; не извлекает команду из произвольного текста',()=>{
        expect(researchCommand('```json\n{"kind":"finish"}\n```',enabled)).toEqual({kind:'finish'});
        expect(()=>researchCommand('Сначала выполню {"kind":"finish"}',enabled)).toThrow('допустимый шаг');
    });
    it.each([
        null,[],{kind:'shell',command:'rm -rf /'},{kind:'finish',command:'curl attacker'},
        {kind:'external_search',query:'x'}, {kind:'external_search',query:'x',objective:'y',numResults:11},
        {kind:'external_fetch',urls:['https://docs.nestjs.com'],maxCharacters:10001},
        {kind:'external_fetch',urls:Array(6).fill('https://docs.nestjs.com')},
        {kind:'project_read',sourceId:''},{kind:'project_search',query:'x'.repeat(4097)},
    ])('Отклоняет malformed/недопустимый шаг %j',value=>{expect(()=>researchCommand(JSON.stringify(value),enabled)).toThrow('допустимый шаг');});
    it('Выключенный источник не становится доступен по команде модели',()=>{
        expect(()=>researchCommand('{"kind":"external_search","query":"x","objective":"y"}',{project:true,external:false})).toThrow();
        expect(()=>researchCommand('{"kind":"project_search","query":"x"}',{project:false,external:true})).toThrow();
        expect(researchPlannerPrompt({project:true,external:false})).not.toContain('external_fetch');
    });
    it('Ограничивает байты JSON до persistence, включая escape-последовательности',()=>{
        expect(()=>researchCommand(JSON.stringify({kind:'external_search',query:'\n'.repeat(2000),objective:'\t'.repeat(2000)}),enabled)).toThrow();
        expect(()=>researchCommand(' '.repeat(16385),enabled)).toThrow();
    });
});

describe('Внешние источники и транспорт Gateway',()=>{
    it.each(['file:///etc/passwd','http://localhost/x','http://10.1.2.3','http://127.0.0.1','http://[::1]/','http://2130706433/',
        'https://intranet.local/','https://private.internal/','https://example.test/','https://user:secret@docs.nestjs.com/','https://docs.nestjs.com:8080/'])('Не разрешает %s',url=>{
        expect(researchPublicUrl(url)).toBeUndefined();expect(()=>researchCommand(JSON.stringify({kind:'external_fetch',urls:[url]}),enabled)).toThrow();
    });
    it('Использует фиксированный internal endpoint и token, передаёт точный пакет без изменения pin',async()=>{
        const fetcher=vi.fn(async()=>json({text:'Найдено в официальных документах',sources:[{url:'https://docs.nestjs.com/#x',title:'NestJS'}]}));vi.stubGlobal('fetch',fetcher);
        const client=new ChatResearchMcpClient(),signal=new AbortController().signal,result=await client.call(pkg,'web_search_exa',{query:'NestJS',objective:'Docs'},signal);
        const [url,init]=fetcher.mock.calls[0]as unknown as[string,RequestInit];expect(url).toBe('http://127.0.0.1:4000/internal/research-mcp/call');expect(init.redirect).toBe('error');
        expect(init.headers).toMatchObject({'x-neurocenter-internal':'unit-internal-only'});expect(JSON.parse(String(init.body))).toEqual({pkg,name:'web_search_exa',arguments:{query:'NestJS',objective:'Docs'}});
        expect(result.sources).toEqual([{url:'https://docs.nestjs.com/',title:'NestJS'}]);
    });
    it.each([
        {text:'',sources:[]},{text:'x'.repeat(65537),sources:[]},{text:'x',sources:[{url:'http://localhost/'}]},
        {text:'x',sources:Array(13).fill({url:'https://docs.nestjs.com/'})},{text:'x',sources:[{url:'https://docs.nestjs.com/',title:42}]},
    ])('Отклоняет неподтверждённый output %j',async data=>{
        vi.stubGlobal('fetch',vi.fn(async()=>json(data)));await expect(new ChatResearchMcpClient().call(pkg,'web_search_exa',{},new AbortController().signal)).rejects.toThrow('неподтверждённый ответ');
    });
    it('Без internal token даже не открывает сетевой запрос',async()=>{
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','');const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
        await expect(new ChatResearchMcpClient().list(pkg,new AbortController().signal)).rejects.toThrow('не настроен');expect(fetcher).not.toHaveBeenCalled();
    });
    it('Не повторяет abort или внешнюю ошибку скрытым запросом',async()=>{
        const abort=new AbortController();abort.abort(new Error('explicit-stop'));const fetcher=vi.fn(async()=>{throw abort.signal.reason;});vi.stubGlobal('fetch',fetcher);
        await expect(new ChatResearchMcpClient().list(pkg,abort.signal)).rejects.toThrow('explicit-stop');expect(fetcher).toHaveBeenCalledOnce();
    });
    it('Проверяет обе объявленные readonly схемы из Gateway; unknown tools не появляются',async()=>{
        const tool=(name:string)=>({name,description:'Поиск',inputSchema:{type:'object'}});
        const fetcher=vi.fn().mockResolvedValueOnce(json({tools:[tool('web_search_exa'),tool('web_fetch_exa')]})).mockResolvedValueOnce(json({tools:[tool('web_search_exa'),tool('shell')]}));vi.stubGlobal('fetch',fetcher);
        const client=new ChatResearchMcpClient();expect((await client.list(pkg,new AbortController().signal)).map(item=>item.name)).toEqual(['web_search_exa','web_fetch_exa']);
        await expect(client.list(pkg,new AbortController().signal)).rejects.toThrow('неподтверждённый ответ');
    });
    it('Ограничивает JSON до разбора и не выдаёт HTML/ошибку сервера за данные поиска',async()=>{
        const fetcher=vi.fn().mockResolvedValueOnce(new Response('x'.repeat(512*1024+1))).mockResolvedValueOnce(new Response('<html>offline</html>')).mockResolvedValueOnce(json({message:'private stack'},500));vi.stubGlobal('fetch',fetcher);
        const client=new ChatResearchMcpClient();for(let n=0;n<3;n++)await expect(client.call(pkg,'web_search_exa',{},new AbortController().signal)).rejects.toThrow(/неподтверждённый|не выполнил/);
    });
});
