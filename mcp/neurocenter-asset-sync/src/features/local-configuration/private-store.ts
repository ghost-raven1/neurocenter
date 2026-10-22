import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stateDir } from '../../bridge/state.js';
const exec = promisify(execFile);
const safeName = /^[a-f0-9]{64}$/;
const privateBudget = 1024*1024*1024;
let writes:Promise<void>=Promise.resolve();
export async function assertPrivateWindowsAcl(file: string): Promise<void> {
    if (process.platform !== 'win32') {return;}
    const script = '$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;'
        + '$acl=Get-Acl -LiteralPath $env:NEUROCENTER_PRIVATE_ACL_PATH;if(-not $acl.AreAccessRulesProtected){exit 2};'
        + '$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;'
        + 'if($owner -ne $sid){exit 3};foreach($rule in $acl.Access){'
        + 'if($rule.AccessControlType -eq "Allow" -and $rule.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -ne $sid){exit 4}}';
    try {await exec('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],
        {timeout:5000,windowsHide:true,env:{...process.env,NEUROCENTER_PRIVATE_ACL_PATH:file}});}
    catch {throw new Error('Небезопасные права локальной настройки.');}
}

export async function enforcePrivateWindowsAcl(file: string, directory: boolean): Promise<void> {
    if (process.platform !== 'win32') {return;}
    const sid = (await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command','[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'],{timeout:5000,windowsHide:true})).stdout.trim();
    if (!/^S-1-[0-9-]+$/.test(sid)) {throw new Error('Не удалось определить владельца локальной настройки.');}
    await exec('icacls.exe',[file,'/inheritance:r','/grant:r',`*${sid}:${directory ? '(OI)(CI)' : ''}F`],{timeout:5000,windowsHide:true});
}
async function directory() {
    const parent = stateDir(); await fs.mkdir(parent,{recursive:true,mode:0o700});
    const parentStat = await fs.lstat(parent); if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {throw new Error('Небезопасный каталог настройки.');}
    const root = path.join(await fs.realpath(parent),'local-configuration');
    try {await fs.mkdir(root,{mode:0o700}); await enforcePrivateWindowsAcl(root,true);} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {throw error;}}
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) {throw new Error('Небезопасные права каталога настройки.');}
    await assertPrivateWindowsAcl(root); return {root,stat};
}
async function unchanged(root: string, before: Awaited<ReturnType<typeof fs.lstat>>) {
    const after = await fs.lstat(root); if (!after.isDirectory() || after.isSymbolicLink() || after.ino !== before.ino || after.dev !== before.dev) {throw new Error('Каталог настройки изменился.');}
}
async function assertBudget(root:string,target:string,size:number):Promise<void> {
    let bytes=size;let count=0;
    const directory=await fs.opendir(root);
    for await(const entry of directory){
        if(++count>10_000){throw new Error('Превышен лимит приватных записей настройки.');}
        const file=path.join(root,entry.name);const stat=await fs.lstat(file);
        if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1){throw new Error('Небезопасная приватная запись настройки.');}
        if(file!==target){bytes+=stat.size;}
        if(bytes>privateBudget){throw new Error('Превышен приватный бюджет настройки 1 ГиБ.');}
    }
    if(count===10_000){try{await fs.lstat(target);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT'){throw new Error('Превышен лимит приватных записей настройки.');}throw error;}}
}
/** Закрытое чтение не следует по symlink и сверяет открытый inode с именем. */
export async function readPrivateConfiguration<T>(key: string): Promise<T | undefined> {
    if (!safeName.test(key)) {throw new Error('Некорректный ключ настройки.');}
    const {root,stat} = await directory(); const file = path.join(root,key + '.json'); let handle;
    try {
        const before = await fs.lstat(file);
        if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > 8 * 1024 * 1024
            || process.platform !== 'win32' && ((before.mode & 0o077) !== 0 || before.uid !== process.getuid?.())) {throw new Error('Небезопасный файл настройки.');}
        await assertPrivateWindowsAcl(file);
        handle = await fs.open(file,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); const opened = await handle.stat();
        if (before.ino !== opened.ino || before.dev !== opened.dev) {throw new Error('Файл настройки изменился.');}
        const value = await handle.readFile('utf8'); const after = await handle.stat();
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || Buffer.byteLength(value) !== opened.size) {throw new Error('Файл настройки изменился.');}
        await unchanged(root,stat); return JSON.parse(value) as T;
    } catch (error) {if ((error as NodeJS.ErrnoException).code === 'ENOENT') {return undefined;} throw error;}
    finally {await handle?.close();}
}
/** Атомарная замена закрытого файла с CAS; старые значения не попадают в backup проекта. */
export async function writePrivateConfiguration(key: string, value: unknown, expected: unknown, beforeCommit:()=>void=()=>{}): Promise<void> {
    const prior=writes;let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});writes=prior.then(()=>gate);
    await prior;try{await commitPrivateConfiguration(key,value,expected,beforeCommit);}finally{release();}
}
async function commitPrivateConfiguration(key: string, value: unknown, expected: unknown, beforeCommit:()=>void): Promise<void> {
    const raw = JSON.stringify(value); if (!safeName.test(key) || Buffer.byteLength(raw) > 8 * 1024 * 1024) {throw new Error('Превышен размер настройки.');}
    if (JSON.stringify(await readPrivateConfiguration(key)) !== JSON.stringify(expected)) {throw new Error('Настройка изменена в другом окне.');}
    const {root,stat} = await directory(); const file = path.join(root,key + '.json'); const temporary = path.join(root,'.' + randomUUID() + '.tmp');
    await assertBudget(root,file,Buffer.byteLength(raw));
    let handle;
    try {
        handle = await fs.open(temporary,constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,0o600);
        await handle.writeFile(raw); await handle.sync(); await handle.close(); handle = undefined; await enforcePrivateWindowsAcl(temporary,false);
        if (JSON.stringify(await readPrivateConfiguration(key)) !== JSON.stringify(expected)) {throw new Error('Настройка изменена в другом окне.');}
        await unchanged(root,stat);beforeCommit();await fs.rename(temporary,file); await unchanged(root,stat);
    } finally {await handle?.close(); await fs.rm(temporary,{force:true});}
}

/** CAS-удаление только собственного временного профиля при rollback journal. */
export async function removePrivateConfiguration(key:string,expected:unknown):Promise<void>{
    if(!safeName.test(key))throw new Error('Некорректный ключ настройки.');
    const prior=writes;let release:()=>void=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});writes=prior.then(()=>gate);await prior;
    try{
        if(JSON.stringify(await readPrivateConfiguration(key))!==JSON.stringify(expected))throw new Error('Настройка изменена в другом окне.');
        const {root,stat}=await directory();await unchanged(root,stat);await fs.unlink(path.join(root,key+'.json'));await unchanged(root,stat);
    }finally{release();}
}
