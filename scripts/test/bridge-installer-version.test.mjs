import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
for(const [file,declaration]of [['install.sh',"VERSION='__BRIDGE_VERSION__'"],['install.ps1',"$Version = '__BRIDGE_VERSION__'"]]){
    test(file+': версия устанавливается только Gateway из импортированного ассета',async()=>{
        const script=await readFile(new URL('../../bridge-dist/'+file,import.meta.url),'utf8');assert.ok(script.includes(declaration));
        assert.equal(script.split('__BRIDGE_VERSION__').length,2);assert.equal(/github\.com|registry\.npmjs\.org/.test(script),false);
    });
}
