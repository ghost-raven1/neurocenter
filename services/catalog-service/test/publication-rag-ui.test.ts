import {describe,expect,it} from 'vitest';
import {validatePublication} from '../src/publication/publication-validation';
import {assertLocalUiInventory} from '../src/publication/publication-runtime';
import {buildPackage,verifyPackage} from '../src/catalog/bundle-package';
import {assertInstallablePackage} from '../src/devices/installation-set';

const localUi={schemaVersion:1,application:'opencode-rag',entrypoint:'opencode-rag.mjs',args:['ui','--port','0','--no-open']};
const artifact={target:'darwin-arm64',sha256:'a'.repeat(64),compressedBytes:100,unpackedBytes:200,filesCount:2,entrypoint:'opencode-rag.mjs'};
const configuration={schemaVersion:1,fields:[{id:'embeddingUrl',label:'URL',type:'url',required:true,target:{kind:'env',name:'NEUROCENTER_RAG_EMBEDDING_URL'}}]};
const source=(kind:'mcp'|'plugin'='mcp')=>({name:'OpenCodeRAG',kind,description:'Локальный интерфейс и инструменты',files:[],
    config:{...(kind==='mcp'?{transport:'stdio',command:'node',args:['mcp']}:{entrypoint:'rag-plugin.mjs'}),extra:{
        runtimeArtifacts:[{...artifact,entrypoint:kind==='mcp'?'opencode-rag.mjs':'rag-plugin.mjs'}],localUi,
        ...(kind==='mcp'?{localConfiguration:configuration}:{})}}});

describe('Публикация закреплённого интерфейса OpenCodeRAG',()=>{
    it.each(['mcp','plugin'] as const)('Core-only %s publishes the exact fixed engine and requires its real archive entry',kind=>{
        const input=source(kind),{localUi,...extra}=input.config.extra;
        const result=validatePublication({...input,config:{...input.config,extra:{...extra,
            ragCore:{schemaVersion:1,application:'opencode-rag',entrypoint:'opencode-rag.mjs'},
            hostedEmbedding:{schemaVersion:1,profileSchemaVersion:2,reindexSchemaVersion:1}}}});
        expect(result.config?.extra?.localUi).toBeUndefined();expect(result.config?.extra?.ragCore).toEqual({schemaVersion:1,application:'opencode-rag',entrypoint:'opencode-rag.mjs'});
        expect(result.config?.extra?.hostedEmbedding).toEqual({schemaVersion:1,profileSchemaVersion:2,reindexSchemaVersion:1});
        const entry={path:'opencode-rag.mjs',size:10,sha256:'b'.repeat(64),executable:false};
        expect(()=>assertLocalUiInventory(result.config,kind,[entry])).not.toThrow();expect(()=>assertLocalUiInventory(result.config,kind,[])).toThrow('описи');
        const pkg=buildPackage({id:'ai-plug-core',kind,name:result.name,version:1},[],'',result.config);expect(verifyPackage(pkg)).toBe(true);
    });
    it.each(['mcp','plugin'] as const)('Принимает %s с полным descriptor и сохраняет остальные разрешённые extra',kind=>{
        const result=validatePublication(source(kind));
        expect(result.config?.extra?.localUi).toEqual(localUi);
        expect(result.config?.extra?.runtimeArtifacts).toEqual(source(kind).config.extra.runtimeArtifacts);
        if(kind==='mcp')expect(result.config?.extra?.localConfiguration).toEqual(configuration);
        const pkg=buildPackage({id:'ai-plug-rag',kind,name:result.name,version:1},[],'',result.config);
        expect(verifyPackage(pkg)).toBe(true);expect(()=>assertInstallablePackage(pkg)).not.toThrow();
    });
    it.each([{command:'sh'},{schemaVersion:2},{application:'other'},{entrypoint:'../private.mjs'},{entrypoint:'rag-ui.mjs'},
        {args:['ui','--host','0.0.0.0']},{args:['ui','--port','0','--no-open','--command','other']},null])('Не принимает произвольные поля или команды localUi: %j',changed=>{
        const input=source();input.config.extra.localUi=(changed===null?null:{...localUi,...changed}) as typeof localUi;
        expect(()=>validatePublication(input)).toThrow();
    });
    it.each(['remote','local','http',''])('Не переносит localUi на транспорт %s',transport=>{
        const input=source();expect(()=>validatePublication({...input,config:{...input.config,transport,url:'https://example.test/mcp'}})).toThrow();
    });
    it('Не позволяет объявить UI без закреплённого runtime-архива',()=>{
        const input=source();expect(()=>validatePublication({...input,config:{transport:'stdio',command:'node',entrypoint:'opencode-rag.mjs',extra:{localUi}},files:[{path:'opencode-rag.mjs',content:'export {};'}]})).toThrow();
        expect(()=>validatePublication({...source('plugin'),config:{entrypoint:'plugin.mjs',extra:{localUi}},files:[{path:'plugin.mjs',content:'export default {};'}]})).toThrow();
    });
    it('Не расширяет общий extra произвольными параметрами',()=>{
        const input=source();expect(()=>validatePublication({...input,config:{...input.config,extra:{...input.config.extra,shell:'sh'}}})).toThrow();
    });
    it.each(['mcp','plugin'] as const)('UI entrypoint %s должен присутствовать непустым файлом в проверенной описи',kind=>{
        const {config}=validatePublication(source(kind));const entry={path:'opencode-rag.mjs',size:10,sha256:'b'.repeat(64),executable:false};
        expect(()=>assertLocalUiInventory(config,kind,[entry])).not.toThrow();
        for(const entries of [[],[{...entry,path:'other.mjs'}],[{...entry,size:0}]])expect(()=>assertLocalUiInventory(config,kind,entries)).toThrow('описи');
    });
    it('Старые runtime и localConfiguration не требуют UI entrypoint',()=>{
        expect(()=>assertLocalUiInventory({transport:'stdio',extra:{runtimeArtifacts:[artifact],localConfiguration:configuration}},'mcp',[])).not.toThrow();
    });
});
