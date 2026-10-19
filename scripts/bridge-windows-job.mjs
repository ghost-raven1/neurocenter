import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

/** В Windows-пакет попадает только PE helper нужной архитектуры, закреплённый собственным SHA. */
export async function packageWindowsJobHelper({platform=process.platform,arch=process.arch,content,args=process.argv.slice(2)}){
    if(platform!=='win32')return undefined;
    const input=args.find(value=>value.startsWith('--windows-job-helper='))?.slice('--windows-job-helper='.length);
    if(!input)throw new Error('Сначала соберите Windows Job Objects helper и укажите --windows-job-helper=<файл>.');
    const source=path.resolve(input);const stat=await fs.lstat(source);
    if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<256||stat.size>4*1024*1024)throw new Error('Некорректный Windows Job Objects helper.');
    const bytes=await fs.readFile(source);const after=await fs.lstat(source);
    if(after.ino!==stat.ino||after.dev!==stat.dev||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||after.ctimeMs!==stat.ctimeMs)throw new Error('Windows helper изменился во время чтения.');
    const offset=bytes.readUInt32LE(0x3c);const machine={x64:0x8664,arm64:0xaa64}[arch];
    if(bytes.toString('ascii',0,2)!=='MZ'||offset<64||offset+6>bytes.length||bytes.readUInt32LE(offset)!==0x4550||!machine||bytes.readUInt16LE(offset+4)!==machine)throw new Error('Windows helper собран для другой архитектуры или повреждён.');
    const file='bin/neurocenter-job.exe';await fs.writeFile(path.join(content,file),bytes,{flag:'wx',mode:0o700});
    return {file,sha256:createHash('sha256').update(bytes).digest('hex')};
}
