import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseImportArguments} from '../production/import-runtime-artifact.mjs';
test('Операторский импорт принимает только явный готовый архив и descriptor',()=>{
    const input=parseImportArguments(['--archive','/tmp/готовый.tar.gz','--descriptor','/tmp/descriptor.json','--project-name','nc-own-fixture','--directory','/tmp/config']);assert.equal(input.archive,'/tmp/готовый.tar.gz');assert.equal(input.projectName,'nc-own-fixture');
    for(const args of [[],['--archive','a'],['--archive','a','--descriptor','b','--archive','c'],['--url','https://example.org/install.sh'],['--archive','--descriptor','b']]){assert.throws(()=>parseImportArguments(args));}
});
