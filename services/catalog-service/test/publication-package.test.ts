import {describe,expect,it} from 'vitest';
import {buildPackage,verifyPackage} from '../src/catalog/bundle-package';
import {publicationHash} from '../src/publication/publication-validation';
import {vi} from 'vitest';

describe('Доставка версии инструмента',()=>{
    const plugin={id:'ai-id',name:'Помощник',kind:'mcp',version:2};
    it('Формат 4 для русских путей не использует сортировку языка ОС',()=>{
        const locale=vi.spyOn(String.prototype,'localeCompare').mockImplementation(()=>{throw new Error('Локаль не должна влиять на хэш');});
        try{
            const pkg=buildPackage(plugin,[{path:'assets/я.txt',content:'я'},{path:'assets/z.txt',content:'z'}],'now');
            expect(pkg.schemaVersion).toBe(4);expect(verifyPackage(pkg)).toBe(true);
            expect(buildPackage(plugin,[...pkg.files].reverse(),'later').manifest.sha256).toBe(pkg.manifest.sha256);
        }finally{locale.mockRestore();}
    });
    it('Новые ASCII-пакеты с разным регистром путей не зависят от локали',()=>{
        const locale=vi.spyOn(String.prototype,'localeCompare').mockImplementation(()=>{throw new Error('Локаль не должна влиять на хэш');});
        try{
            const pkg=buildPackage(plugin,[{path:'I_foo.js',content:'I'},{path:'i_bar.js',content:'i'}],'now');
            expect(pkg.schemaVersion).toBe(4);expect(verifyPackage(pkg)).toBe(true);
            expect(buildPackage(plugin,[...pkg.files].reverse(),'later').manifest.sha256).toBe(pkg.manifest.sha256);
        }finally{locale.mockRestore();}
    });
    it.each([2,3] as const)('Ранее опубликованный формат %s остаётся доступным для чтения',schemaVersion=>{
        const pkg=buildPackage(plugin,[{path:'index.js',content:'console.log(1)'}],'then');
        const legacy={...pkg,schemaVersion};
        legacy.manifest={...legacy.manifest,sha256:publicationHash({schemaVersion,plugin:legacy.plugin,config:legacy.config,
            files:legacy.files.map(({path,size,sha256})=>({path,size,sha256})).sort((a,b)=>a.path.localeCompare(b.path))})};
        expect(verifyPackage(legacy)).toBe(true);
        expect(verifyPackage({...legacy,config:{transport:'remote',url:'https://changed.example.test'}})).toBe(false);
    });
    it('Удалённый MCP передаётся вместе с конфигурацией даже без файлов',()=>{const pkg=buildPackage(plugin,[],'now',{transport:'remote',url:'https://example.org/mcp'});expect(verifyPackage(pkg)).toBe(true);expect(pkg.config?.url).toBe('https://example.org/mcp');});
    it('Подмена URL или номера версии нарушает целостность',()=>{const pkg=buildPackage(plugin,[],'now',{transport:'remote',url:'https://example.org/mcp'});expect(verifyPackage({...pkg,config:{transport:'remote',url:'https://other.example.org'}})).toBe(false);expect(verifyPackage({...pkg,plugin:{...plugin,version:3}})).toBe(false);});
    it('Русские файлы учитываются в байтах; размер нельзя подменить',()=>{const pkg=buildPackage(plugin,[{path:'notes.md',content:'Привет'}],'now');expect(pkg.files[0].size).toBe(12);expect(verifyPackage(pkg)).toBe(true);expect(verifyPackage({...pkg,files:[{...pkg.files[0],size:6}]})).toBe(false);});
});
