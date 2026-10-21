import {expect,it} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {inspectUploadArchive} from '../../shared/upload-inspection.cjs';
import {uploadRuntime,type UploadChoice,type UploadMetadata} from '../src/source-upload/source-upload.model';

it('Python upload retains its checked plan and immutable runtime assets across metadata persistence',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-upload-python-'));
 try{
  const filename=path.join(root,'source.upload');await fs.writeFile(filename,'print("ready")\n');
  const checked=await inspectUploadArchive(filename,{name:'hello.py',format:'file'}) as UploadMetadata;
  const restored=JSON.parse(JSON.stringify(checked)) as UploadMetadata;
  expect(restored.choices).toHaveLength(1);expect(restored.requiresEntrypointChoice).toBe(false);
  const runtime=uploadRuntime(restored.choices[0]);
  expect(runtime.python).toEqual({schemaVersion:1,projectDirectory:'.',entry:{type:'script',value:'hello.py'},searchPaths:['.'],requirements:[]});
  expect(runtime.assets['darwin-arm64']?.runtime).toEqual(checked.choices[0].runtimeAssets?.['darwin-arm64']);
  expect(runtime.assets['linux-x64-glibc']?.runtime?.sha256).toMatch(/^[a-f0-9]{64}$/);
  const modified:UploadChoice={...restored.choices[0],runtimeAssets:{}};
  expect(()=>uploadRuntime(modified)).toThrow(/runtime/);
 }finally{await fs.rm(root,{recursive:true,force:true});}
});
