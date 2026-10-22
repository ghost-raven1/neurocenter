import { describe, expect, it } from 'vitest';
import type { IAiPlugin } from '../src/core/api/interfaces';
import { editMcpConfig, pluginEditPayload } from '../src/features/Catalog/storeEditHelpers';

const artifact={target:'darwin-arm64',sha256:'a'.repeat(64),compressedBytes:100,unpackedBytes:200,filesCount:2,entrypoint:'runtime/index.mjs'};
const field={id:'token',label:'Ключ доступа',type:'string',required:true,secret:true,target:{kind:'env',name:'SERVICE_TOKEN'}};
const configuration={schemaVersion:1,fields:[field,{id:'verbose',label:'Подробный режим',type:'boolean',required:false,target:{kind:'env',name:'VERBOSE'}}]};
const config={transport:'stdio',extra:{runtimeArtifacts:[artifact],localConfiguration:configuration}};
const parse=(value:unknown)=>editMcpConfig(JSON.stringify(value));

describe('Редактирование MCP формата 5 без потери локальной схемы',()=>{
    it('Сохраняет готовые артефакты и локальную схему при редактировании только описания',()=>{
        const plugin={id:'mcp',kind:'mcp',name:'Поиск',version:3,config,description:'Было',tags:[]} as unknown as IAiPlugin;
        const payload=pluginEditPayload(plugin,{name:'Поиск',description:' Новое описание ',tags:'Поиск',body:'',config:JSON.stringify(config)});
        expect(payload).toEqual({description:'Новое описание',tags:['Поиск'],expectedVersion:3,config});
        expect(plugin.config).toBe(config);expect(parse(config)).toEqual(config);
    });
    it('Разрешает artifact-only запуск без command и entrypoint и сохраняет аргументы',()=>{
        const value={...config,args:['--name','Два слова'],env:{MODE:'local'}};
        expect(parse(value)).toEqual(value);
        expect(parse({...config,command:'node',entrypoint:artifact.entrypoint})).toHaveProperty('command','node');
    });
    it('Нативный MCP получает команду из descriptor, без подмены внешней командой',()=>{
        const value={transport:'stdio',extra:{runtimeArtifacts:[{...artifact,entrypoint:'bin/tool',executable:true}]}};
        expect(parse(value)).toEqual(value);
        expect(()=>parse({...value,command:'node'})).toThrow('Готовый комплект');
        expect(()=>parse({...config,command:'curl'})).toThrow('Готовый комплект');
        expect(()=>parse({...config,entrypoint:'other.mjs'})).toThrow('Точка входа');
    });
    it('Удалённый MCP разрешает схему заголовка, но не готовый локальный комплект',()=>{
        const remote={transport:'remote',url:'https://mcp.example.test/bridge',extra:{localConfiguration:{schemaVersion:1,fields:[{
            ...field,target:{kind:'header',name:'Authorization',prefix:'Bearer '},
        }]}}};
        expect(parse(remote)).toEqual(remote);
        expect(()=>parse({...remote,extra:{...remote.extra,runtimeArtifacts:[artifact]}})).toThrow('Удалённый MCP');
    });
    it.each([{requirements:{dependencies:[]}},{token:'fixture-secret'},{url:'https://registry.example.test/archive'},{localConfiguration:configuration,unknown:true}])('Extra не становится произвольным хранилищем: %j',extra=>{
        expect(()=>parse({transport:'stdio',command:'node',extra})).toThrow('Поддерживаются поля extra');
    });
    it.each([{...artifact,url:'https://example.test/runtime'},{...artifact,entrypoint:'../run.mjs'},{...artifact,compressedBytes:0},{...artifact,sha256:'bad'}])('Не принимает недостоверную поставку: %j',value=>{
        expect(()=>parse({transport:'stdio',extra:{runtimeArtifacts:[value]}})).toThrow('runtimeArtifacts');
    });
    it.each([{...configuration,values:{token:'fixture-secret'}},{...configuration,fields:[{...field,value:'fixture-secret'}]},
        {...configuration,fields:[{...field,target:{kind:'env',name:'NODE_OPTIONS'}}]},
        {...configuration,fields:[{...field,target:{kind:'header',name:'Authorization'}}]},
        {...configuration,fields:[field,field]}])('Схема не принимает значения, опасные назначения и дубликаты: %j',localConfiguration=>{
        expect(()=>parse({transport:'stdio',command:'node',extra:{localConfiguration}})).toThrow('localConfiguration');
    });
    it('Без артефактов локальному MCP по-прежнему нужна команда; прежний контракт сохраняется',()=>{
        expect(()=>parse({transport:'stdio',extra:{localConfiguration:configuration}})).toThrow('Укажите команду');
        expect(parse({transport:'stdio',command:'node',entrypoint:'index.mjs',extra:{localConfiguration:configuration}})).toHaveProperty('command','node');
    });
});
