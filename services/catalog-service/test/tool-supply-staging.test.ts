import {afterEach,beforeEach,expect,it} from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {cleanStaleSupplyStages,markSupplyStage} from '../src/package-build/supply-staging';

let root:string;
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'nc-supply-stage-'));});
afterEach(async()=>{await fs.rm(root,{recursive:true,force:true});});
async function stage(name:string,old:boolean,owner:unknown){
 const dir=path.join(root,name);await fs.mkdir(dir);await fs.writeFile(path.join(dir,'payload'),'retained temporary output');
 if(owner!==undefined)await fs.writeFile(path.join(dir,'owner.json'),JSON.stringify(owner));
 if(old){const when=new Date(Date.now()-20*60*1000);if(owner!==undefined)await fs.utimes(path.join(dir,'owner.json'),when,when);await fs.utimes(dir,when,when);}return dir;
}
it('Reaps only identified old local/foreign replica stages and preserves fresh replicas and unknown directories',async()=>{
 const old={version:1,host:os.hostname(),createdAt:Date.now()-20*60*1000};
 await stage('export-oldone',true,old);await stage('export-oldtwo',true,{...old,host:'previous-container'});
 await stage('export-active',false,{...old,host:'another-replica',createdAt:Date.now()});
 await stage('export-unknow',true,undefined);await stage('export-badown',true,{version:0,host:'unknown',createdAt:old.createdAt});await stage('unrelated-directory',true,old);
 await cleanStaleSupplyStages(root);expect((await fs.readdir(root)).sort()).toEqual(['export-active','export-badown','export-unknow','unrelated-directory']);
});
it('Does not follow directory or marker symlinks and preserves the outside target',async()=>{
 const outside=await stage('outside',true,{version:1,host:'old',createdAt:Date.now()-20*60*1000});await fs.symlink(outside,path.join(root,'export-symlnk'));
 const target=await stage('export-marksy',true,undefined);await fs.symlink(path.join(outside,'owner.json'),path.join(target,'owner.json'));await fs.utimes(target,new Date(0),new Date(0));
 await cleanStaleSupplyStages(root);expect(await fs.readFile(path.join(outside,'payload'),'utf8')).toBe('retained temporary output');expect((await fs.lstat(path.join(root,'export-symlnk'))).isSymbolicLink()).toBe(true);expect(await fs.readdir(target)).toContain('owner.json');
});
it('A new ownership marker is private, exclusive, and stays fresh after cleanup',async()=>{
 const dir=await stage('export-marked',false,undefined);await markSupplyStage(dir);await expect(markSupplyStage(dir)).rejects.toMatchObject({code:'EEXIST'});
 expect((await fs.stat(path.join(dir,'owner.json'))).mode&0o777).toBe(0o600);await cleanStaleSupplyStages(root);expect(await fs.readdir(dir)).toContain('owner.json');
});
