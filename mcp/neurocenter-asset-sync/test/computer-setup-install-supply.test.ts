import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,expect,it} from 'vitest';
import {bundledOpenCodeInstallSource} from '../src/features/computer-setup/install-supply.js';
const roots:string[]=[];afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>fs.rm(root,{recursive:true,force:true})));});
async function fixture(target:string){const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'nc-cli-supply-')));roots.push(root);await fs.mkdir(path.join(root,'bin'));
    await fs.writeFile(path.join(root,'runtime.json'),JSON.stringify({buildId:'a'.repeat(64),target,probeEngine:{file:'bin/opencode-probe',version:'1.14.48',sha256:'b'.repeat(64)}}));return root;}
it.each(['darwin-arm64','darwin-x64','linux-x64','linux-arm64','linux-x64-musl','linux-arm64-musl'])('reads exact package metadata target %s without assuming its operating system',async target=>{
    const root=await fixture(target);expect(await bundledOpenCodeInstallSource(root)).toEqual({file:path.join(root,'bin','opencode-probe'),source:{buildId:'a'.repeat(64),target,version:'1.14.48',sha256:'b'.repeat(64)}});
});
it('does not trust an invented package glibc suffix or a symlinked runtime bin directory',async()=>{
    await expect(bundledOpenCodeInstallSource(await fixture('linux-x64-glibc'))).rejects.toThrow();
    const root=await fixture('darwin-arm64'),outside=await fixture('darwin-arm64');await fs.rmdir(path.join(root,'bin'));await fs.symlink(path.join(outside,'bin'),path.join(root,'bin'));
    await expect(bundledOpenCodeInstallSource(root)).rejects.toThrow('Недоступна закреплённая поставка');
});
