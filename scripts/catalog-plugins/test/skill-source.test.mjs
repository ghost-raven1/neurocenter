import {afterEach,test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {readSkillRepository} from '../skill-source.mjs';

const require=createRequire(new URL('../../../services/catalog-service/package.json',import.meta.url)),tar=require('tar');
const commit='a'.repeat(40),source={type:'repository',url:'https://github.com/fixture/skills',commit,subdirectory:'skills/helper',entrypoint:'SKILL.md'};
const roots=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
async function fixture(files,{archiveCommit=commit,symlink=false}={}){
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-skill-git-'));roots.push(root);
    const contents=path.join(root,'contents'),wrapper='skills-'+archiveCommit;await fs.mkdir(contents);
    for(const [relative,bytes]of Object.entries(files)){
        const filename=path.join(contents,wrapper,relative);await fs.mkdir(path.dirname(filename),{recursive:true});await fs.writeFile(filename,bytes);
    }
    if(symlink)await fs.symlink('../outside',path.join(contents,wrapper,'unsafe'));
    const archivePath=path.join(root,'repository.tar.gz');await tar.c({file:archivePath,cwd:contents,gzip:true,portable:true},[wrapper]);
    const stage=path.join(root,'stage');await fs.mkdir(stage);return {stage,downloadArchive:async()=>({archivePath})};
}
const instruction='---\nname: helper\ndescription: Repository helper\n---\n\n[Rules](references/rules.md)\n';
test('Pinned GitHub subdirectory retains its whole skill tree and canonical binary bytes without executing sources',async()=>{
    const binary=Buffer.from([137,80,78,71,0,255,128]);
    const f=await fixture({'README.md':'Outside selected skill','skills/helper/SKILL.md':instruction,'skills/helper/references/rules.md':'Rules',
        'skills/helper/scripts/build/check.py':'raise RuntimeError("must never execute")','skills/helper/assets/dist/image.png':binary,'skills/helper/references/bom.md':'\uFEFFExact BOM'});
    const files=await readSkillRepository(source,f.stage,f);
    assert.deepEqual(files.map(file=>file.path),['SKILL.md','assets/dist/image.png','references/bom.md','references/rules.md','scripts/build/check.py']);
    assert.equal(files.find(file=>file.path==='references/bom.md').content,'\uFEFFExact BOM');
    const image=files.find(file=>file.path==='assets/dist/image.png');assert.equal(image.encoding,'base64');assert.deepEqual(Buffer.from(image.content,'base64'),binary);
    assert.equal(files.some(file=>file.content==='Outside selected skill'),false);
});
test('A manually selected nested SKILL.md retains its prefix for parser selection and excludes sibling packages',async()=>{
    const f=await fixture({'bundle/a/SKILL.md':instruction,'bundle/a/references/rules.md':'Rules','bundle/b/SKILL.md':'Another skill'});
    const files=await readSkillRepository({...source,subdirectory:undefined,entrypoint:'bundle/a/SKILL.md'},f.stage,f);
    assert.deepEqual(files.map(file=>file.path),['bundle/a/SKILL.md','bundle/a/references/rules.md']);
});
test('A repository archive from another commit cannot be accepted as the pinned source',async()=>{
    const f=await fixture({'skills/helper/SKILL.md':instruction},{archiveCommit:'b'.repeat(40)});
    await assert.rejects(readSkillRepository(source,f.stage,f),/другой корневой|небезопасный/);
});
test('Symlinks in the upstream snapshot are rejected without dereferencing them',async()=>{
    const f=await fixture({'skills/helper/SKILL.md':instruction},{symlink:true});
    await assert.rejects(readSkillRepository(source,f.stage,f),/ссылку/);
});
test('SKILL.md must remain valid UTF-8 even though binary resources are supported',async()=>{
    const f=await fixture({'skills/helper/SKILL.md':Buffer.from([255,0])});
    await assert.rejects(readSkillRepository(source,f.stage,f),/UTF-8/);
});
test('Unsupported source and a missing selected directory fail explicitly',async()=>{
    const f=await fixture({'skills/helper/SKILL.md':instruction});
    await assert.rejects(readSkillRepository({...source,entrypoint:'index.js'},f.stage,f),/SKILL.md/);
    await assert.rejects(readSkillRepository({...source,subdirectory:'missing'},f.stage,f));
});
