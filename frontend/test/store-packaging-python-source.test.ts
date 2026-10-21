import {describe,expect,it} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createPythonSourceUpload,isPythonSourceUpload} from '../src/modules/Store/packaging/pythonSourceUpload';
import {readPackagingFiles,type PackagingFilesResult} from '../src/modules/Store/packaging/sourceFiles';
import {inspectUploadArchive} from '../../services/shared/upload-inspection.cjs';

const source=(files:Record<string,string>,rootName?:string):PackagingFilesResult=>({files:Object.entries(files).map(([path,content])=>({path,content})),skipped:0,...(rootName?{rootName}:{})});
const project='[project]\nname="example-mcp"\nversion="1.0.0"\ndependencies=[]\n[project.scripts]\nexample="server:main"\n';

describe('Python selected from the generic source picker',()=>{
    it('Recognizes Python folders and standalone files, including incidental JavaScript resources',()=>{
        for(const value of [source({'server.py':'print(1)'}),source({'pyproject.toml':project,'server.py':'def main(): pass','web.js':'// web resource'}),source({'tool/requirements.txt':'mcp>=1','tool/server.py':'print(1)','web.js':'// web resource'})])expect(isPythonSourceUpload(value)).toBe(true);
    });
    it('Keeps skills and explicit JavaScript packages in their existing flow',()=>{
        const code={'server.py':'print(1)','index.js':'console.log(1)'};
        for(const metadata of [{bin:'index.js'},{main:'index.js'},{module:'index.js'},{exports:{'.':{import:'./index.js'}}},{dependencies:{'@opencode-ai/plugin':'1.0.0'}}])expect(isPythonSourceUpload(source({...code,'pyproject.toml':project,'package.json':JSON.stringify(metadata)}))).toBe(false);
        expect(isPythonSourceUpload(source({'nested/SKILL.md':'# Instructions','nested/scripts/tool.py':'print(1)'}))).toBe(false);
        expect(isPythonSourceUpload(source(code))).toBe(false);
        expect(isPythonSourceUpload(source({'README.md':'No executable'}))).toBe(false);
    });
    it('Produces deterministic stored ZIP bytes with Unicode and exact binary resources',async()=>{
        const input=source({'server.py':'print("Привет")\n','ресурсы/данные.bin':'placeholder'},'Мой MCP');
        input.files[1]={path:'ресурсы/данные.bin',content:'AP9B',encoding:'base64'};
        const first=createPythonSourceUpload(input),second=createPythonSourceUpload({...input,files:[...input.files].reverse()});
        expect(first.name).toBe('python-source.zip');expect(first.lastModified).toBe(0);
        const bytes=Buffer.from(await first.arrayBuffer());expect(Buffer.from(await second.arrayBuffer())).toEqual(bytes);
        expect(bytes.readUInt16LE(6)).toBe(0x800);expect(bytes.readUInt16LE(8)).toBe(0);expect(bytes.readUInt16LE(12)).toBe(0x21);
        const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
        const yauzl=require('yauzl') as {fromBufferPromise:(bytes:Buffer,options:Record<string,boolean>)=>Promise<{on:(event:string,listener:(entry:{fileName:string})=>void)=>void;readEntry:()=>void;openReadStreamPromise:(entry:unknown)=>Promise<NodeJS.ReadableStream>;close:()=>void}>};
        const zip=await yauzl.fromBufferPromise(bytes,{lazyEntries:true});const restored=new Map<string,Buffer>();
        await new Promise<void>((resolve,reject)=>{zip.on('error',reject);zip.on('end',()=>resolve());zip.on('entry',entry=>{void zip.openReadStreamPromise(entry).then(async stream=>{const chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk));restored.set(entry.fileName,Buffer.concat(chunks));zip.readEntry();}).catch(reject);});zip.readEntry();});zip.close();
        expect(restored.get('Мой MCP/server.py')?.toString('utf8')).toBe('print("Привет")\n');
        expect(restored.get('Мой MCP/ресурсы/данные.bin')).toEqual(Buffer.from([0,255,65]));
    });
    it('The real durable inspector retains the Python package wrapper needed for relative imports',async()=>{
        const root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-browser-python-zip-'));
        try{
            const input=source({'__init__.py':'','__main__.py':'from .helpers import run\nrun()\n','helpers.py':'def run(): print("ready")\n'},'package_name');
            const upload=createPythonSourceUpload(input),filename=path.join(root,'source.zip');await fs.writeFile(filename,Buffer.from(await upload.arrayBuffer()));
            const metadata=await inspectUploadArchive(filename,{name:upload.name,format:'zip'}) as {adapter:string;choices:Array<{python:{projectDirectory:string;entry:{type:string;value:string}}}>};
            expect(metadata.adapter).toBe('python');expect(metadata.choices[0].python.entry).toEqual({type:'module',value:'package_name'});
            expect(metadata.choices[0].python.projectDirectory).toBe('.');
        }finally{await fs.rm(root,{recursive:true,force:true});}
    });
    it('Never restores ignored secret bytes when repacking filtered folder sources',async()=>{
        const secret='fixture-secret-must-not-enter-the-archive',file=(name:string,content:string)=>({name,webkitRelativePath:'tool/'+name,size:new TextEncoder().encode(content).length,arrayBuffer:async()=>new TextEncoder().encode(content).buffer});
        const filtered=await readPackagingFiles([file('server.py','print(1)'),file('.env',secret),file('.npmrc',secret)]);
        expect(filtered.skipped).toBe(2);const zip=Buffer.from(await createPythonSourceUpload(filtered).arrayBuffer());
        expect(zip.includes(Buffer.from(secret))).toBe(false);expect(zip.includes(Buffer.from('.env'))).toBe(false);expect(zip.includes(Buffer.from('tool/server.py'))).toBe(true);
    });
    it.each(['../outside.py','/absolute.py','folder/.env','folder/.npmrc','folder/id_rsa.backup','id_ed25519.pub','key.pem','NUL.py','a\\server.py'])('Rejects unsafe or secret path %s before building an upload',bad=>{
        expect(()=>createPythonSourceUpload(source({'server.py':'print(1)',[bad]:'private'}))).toThrow();
    });
    it('Rejects path aliases, missing code, invalid encodings and quotas',()=>{
        for(const value of [source({}),source({'server.py':''}),source({'README.md':'No code'}),source({'A.py':'1','a.py':'2'}),source({'folder/a.py':'1','FOLDER/b.py':'2'}),source({'parent.py':'1','parent.py/child':'2'}),source({'server.py':'a'.repeat(1024**2+1)}),source(Object.fromEntries(Array.from({length:101},(_,index)=>[index+'.py','1']))),source(Object.fromEntries(Array.from({length:6},(_,index)=>[index+'.py','a'.repeat(1024**2)])))])expect(()=>createPythonSourceUpload(value)).toThrow();
        const binary=source({'server.py':'1'});binary.files.push({path:'image.bin',content:'%%%=',encoding:'base64'});expect(()=>createPythonSourceUpload(binary)).toThrow();
        expect(()=>createPythonSourceUpload(source({'server.py':'1'},'../escape'))).toThrow();
    });
});
