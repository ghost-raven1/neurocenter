import {describe,expect,it} from 'vitest';
import {localRagUi,ragUiReady} from '../src/features/rag-ui/contract.js';
import {browserWindowCommands} from '../src/features/rag-ui/browser-window.js';
import {missingLaunchFields} from '../src/features/local-configuration/launch-fields.js';
import type {Package} from '../src/bridge/package.js';
import type {LocalConfigurationSchema} from '../src/features/local-configuration/schema.js';
const localUi={schemaVersion:1,application:'opencode-rag',entrypoint:'opencode-rag.mjs',args:['ui','--port','0','--no-open']};
const pkg={schemaVersion:5,plugin:{kind:'mcp'},config:{extra:{runtimeArtifacts:[{}],localUi}}} as unknown as Package;
const url='http://127.0.0.1:49152/#neurocenter-token='+'a'.repeat(48);
describe('Закреплённый контракт локального интерфейса RAG',()=>{
    it.each(['mcp','plugin'])('Один descriptor поддерживает карточку %s без shell',kind=>{expect(localRagUi({...pkg,plugin:{...pkg.plugin,kind}})).toEqual(localUi);});
    it.each([{entrypoint:'../../evil.mjs'},{args:['ui','--host','0.0.0.0']},{application:'other'},{command:'node'},{schemaVersion:2}])('Не расширяет закреплённую команду: %j',changed=>{
        expect(()=>localRagUi({...pkg,config:{extra:{runtimeArtifacts:[{}],localUi:{...localUi,...changed}}}})).toThrow();
    });
    it('Принимает только строгое loopback IPC с токеном в fragment',()=>{expect(ragUiReady({type:'neurocenter-rag-ui-ready',url,port:49152})).toEqual({url,port:49152});});
    it.each([url.replace('127.0.0.1','localhost'),url.replace('http:','https:'),url.replace('127.0.0.1','evil.test'),url.replace('/#','/?token=x#'),url.replace('49152','49153'),url+'x',url.replace('/#','/index#')])('Отклоняет неподтверждённый URL',bad=>{expect(()=>ragUiReady({type:'neurocenter-rag-ui-ready',url:bad,port:49152})).toThrow();});
    it.each(['darwin','win32','linux'])('Каждый opener %s запрашивает отдельное окно без URL fallback',platform=>{
        const commands=browserWindowCommands(url,platform,{ProgramFiles:'C:\\Program Files'});expect(commands.length).toBeGreaterThan(0);
        for(const command of commands){expect(command.args).toContain(url);expect(command.file).not.toMatch(/xdg-open|rundll32|cmd\.exe/);if(!command.file.endsWith('osascript'))expect(command.args.some(arg=>['--new-window','-new-window'].includes(arg))).toBe(true);}
    });
    it('Safari получает URL отдельным argv, без вставки в AppleScript',()=>{
        const safari=browserWindowCommands(url,'darwin').find(command=>command.file.endsWith('osascript'))!;
        expect(safari.args[1]).not.toContain(url);expect(safari.args.at(-1)).toBe(url);
    });
    const schema:LocalConfigurationSchema={schemaVersion:1,fields:[{id:'embeddingUrl',type:'url',label:'URL',required:true,target:{kind:'env',name:'NEUROCENTER_RAG_EMBEDDING_URL'}},
        {id:'embeddingModel',type:'string',label:'Модель',required:true,target:{kind:'env',name:'NEUROCENTER_RAG_EMBEDDING_MODEL'}}]};
    it('Defaults CLI не меняют обязательную схему и не затирают сохранённые значения',()=>{
        const values={embeddingUrl:'https://my-model.test/v1',embeddingModel:'private-model'};
        expect(missingLaunchFields(pkg,schema,{})).toEqual([]);expect(missingLaunchFields(pkg,schema,values)).toEqual([]);
        expect(schema.fields.every(field=>field.required)).toBe(true);expect(values.embeddingUrl).toBe('https://my-model.test/v1');
    });
    it('Остальные required поля и посторонние MCP не получают неявных defaults',()=>{
        expect(missingLaunchFields({...pkg,config:null},schema,{})).toEqual(['embeddingUrl','embeddingModel']);
        expect(missingLaunchFields(pkg,{schemaVersion:1,fields:[...schema.fields,{id:'other',type:'string',label:'Другой',required:true,target:{kind:'env',name:'OTHER'}}]},{})).toEqual(['other']);
        expect(missingLaunchFields(pkg,{schemaVersion:1,fields:[{...schema.fields[0]!,target:{kind:'env',name:'OTHER'}}]},{})).toEqual(['embeddingUrl']);
    });
});
