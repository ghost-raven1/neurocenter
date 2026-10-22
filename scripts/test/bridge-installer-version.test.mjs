import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
for(const [file,declaration]of [['install.sh',"VERSION='__BRIDGE_VERSION__'"],['install.ps1',"$Version = '__BRIDGE_VERSION__'"]]){
    test(file+': версия устанавливается только Gateway из импортированного ассета',async()=>{
        const script=await readFile(new URL('../../bridge-dist/'+file,import.meta.url),'utf8');assert.ok(script.includes(declaration));
        assert.equal(script.split('__BRIDGE_VERSION__').length,2);assert.equal(/github\.com|registry\.npmjs\.org/.test(script),false);
    });
}
test('Самодостаточный установщик сохраняет общий контекст и работает до пересборки прежнего Gateway',async()=>{
    const script=await readFile(new URL('../../bridge-dist/install.sh',import.meta.url),'utf8');
    const helper=await readFile(new URL('../../bridge-dist/context.cjs',import.meta.url),'utf8');
    const start='cat > "$CONTEXT_HELPER" <<\'JS\'\n',end='\nJS\ncontext() {';
    const offset=script.indexOf(start),last=script.indexOf(end,offset);
    assert.ok(offset>=0&&last>offset);assert.equal(script.slice(offset+start.length,last)+'\n',helper);
    assert.equal(script.includes('__BRIDGE_CONTEXT__'),false);
});
