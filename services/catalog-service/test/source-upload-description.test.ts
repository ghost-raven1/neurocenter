import {expect,it} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import fixture from '../../../scripts/test/runtime-artifact-fixture.cjs';
import {inspectUploadArchive} from '../../shared/upload-inspection.cjs';
import {uploadRuntime} from '../src/source-upload/source-upload.model';

function executable(){const bytes=Buffer.alloc(64);bytes.writeUInt32LE(0xfeedfacf);bytes.writeUInt32LE(0x100000c,4);bytes.writeUInt32LE(2,12);bytes.writeUInt32LE(1,16);bytes.writeUInt32LE(24,20);bytes.writeUInt32LE(0x32,32);bytes.writeUInt32LE(24,36);bytes.writeUInt32LE(1,40);return bytes;}
async function inspect(files:Array<{path:string;content:string|Buffer}>){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-upload-description-'));
 try{const filename=path.join(root,'source.upload');await fs.writeFile(filename,fixture.artifactFixture(files).archive);return await inspectUploadArchive(filename,{name:'source.tar.gz',format:'tar.gz'});}
 finally{await fs.rm(root,{recursive:true,force:true});}
}
const project='[project]\nname="time-mcp"\nversion="1.2.3"\ndescription="  Time zone conversion for team projects  "\ndependencies=[]\n[project.scripts]\ntime-mcp="server:main"\n';
it('Python archive keeps declared public description separately from its immutable runtime plan',async()=>{
 const metadata=await inspect([{path:'wrapper/pyproject.toml',content:project},{path:'wrapper/server.py',content:'raise RuntimeError("source must never run during inspection")\ndef main(): pass\n'},{path:'wrapper/package.json',content:'{"description":"Unrelated frontend metadata"}'},{path:'wrapper/README.md',content:'PRIVATE README MUST NOT ENTER CARD'}]);
 expect(metadata.description).toBe('Time zone conversion for team projects');
 const runtime=uploadRuntime(metadata.choices[0]);
 expect(runtime.python).toEqual({schemaVersion:1,projectDirectory:'wrapper',entry:{type:'callable',value:'server:main'},searchPaths:['.'],requirements:[],distribution:{name:'time-mcp',version:'1.2.3'}});
 expect(runtime.assets['darwin-arm64']?.runtime).toEqual(metadata.choices[0].runtimeAssets?.['darwin-arm64']);
});
it('Ready native archive uses adjacent package description instead of unrelated projects or README',async()=>{
 const metadata=await inspect([{path:'app/bin/server',content:executable()},{path:'app/package.json',content:'{"name":"ready-server","description":"Ready packaged server"}'},{path:'other/package.json',content:'{"description":"Wrong project"}'},{path:'README.md',content:'PRIVATE README MUST NOT ENTER CARD'}]);
 expect(metadata.description).toBe('Ready packaged server');
});
it('An existing Python runtime keeps its native launch plan and uses the selected app pyproject description',async()=>{
 const metadata=await inspect([{path:'app/main.py',content:'if __name__ == "__main__": print("ready")\n'},{path:'app/pyproject.toml',content:project},{path:'python/bin/python3',content:executable()},{path:'package.json',content:'{"description":"Unrelated web project"}'}]);
 expect(metadata.description).toBe('Time zone conversion for team projects');expect(metadata.choices[0].python).toBeUndefined();
 expect(metadata.choices[0].runtimeEntrypoint).toBe('python/bin/python3');expect(uploadRuntime(metadata.choices[0]).assets['darwin-arm64']?.runtime?.entrypoint).toBe('python/bin/python3');
});
it('Description is bounded public text; invalid metadata and README never become a description',async()=>{
 for(const [raw,expected]of [[{description:'  First\u0001 second\nThird  '},'First  second\nThird'],[{description:'x'.repeat(2100)},'x'.repeat(2000)],[{description:{file:'README.md'}},undefined],[{description:['not text']},undefined],[{description:'   '},undefined]] as const){
  const metadata=await inspect([{path:'bin/server',content:executable()},{path:'package.json',content:JSON.stringify(raw)},{path:'README.md',content:'PRIVATE README MUST NOT ENTER CARD'}]);expect(metadata.description).toBe(expected);
 }
 for(const content of ['{invalid JSON',JSON.stringify({description:'x'.repeat(65536)}),Buffer.from([0xff,0xfe])]){
  const metadata=await inspect([{path:'bin/server',content:executable()},{path:'package.json',content},{path:'README.md',content:'PRIVATE README MUST NOT ENTER CARD'}]);expect(metadata.description).toBeUndefined();
 }
});
it('Ambiguous apps cannot borrow descriptions even when their text happens to match',async()=>{
 const files=[{path:'one/bin/server',content:executable()},{path:'two/bin/server',content:executable()}];
 for(const second of ['Second app','Same app description']){
  const metadata=await inspect([...files,{path:'one/package.json',content:JSON.stringify({description:'Same app description'})},{path:'two/package.json',content:JSON.stringify({description:second})}]);
  expect(metadata.requiresEntrypointChoice).toBe(true);expect(metadata.description).toBeUndefined();
 }
 const common=await inspect([...files,{path:'package.json',content:'{"description":"Common declared application"}'}]);expect(common.description).toBe('Common declared application');
});
it('Missing or dynamic Python descriptions do not fall back to JS metadata or README',async()=>{
 for(const manifest of [project.replace(/description=.*\n/,''),project.replace('dependencies=[]','dynamic=["description"]\ndependencies=[]')]){
  const metadata=await inspect([{path:'pyproject.toml',content:manifest},{path:'server.py',content:'def main(): pass\n'},{path:'package.json',content:'{"description":"Unrelated web project"}'},{path:'README.md',content:'PRIVATE README MUST NOT ENTER CARD'}]);
  expect(metadata.description).toBeUndefined();
 }
});
it('Python commands in the same declared project share its description without altering command selection',async()=>{
 const metadata=await inspect([{path:'pyproject.toml',content:project+'time-mcp-other="server:main"\n'},{path:'server.py',content:'def main(): pass\n'}]);
 expect(metadata.requiresEntrypointChoice).toBe(true);expect(metadata.description).toBe('Time zone conversion for team projects');
});
