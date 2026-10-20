import {ConflictException} from '@nestjs/common';
import {constants,createWriteStream} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Transform,type Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

/** No paths leave this boundary; all names derive from server-owned UUIDs. */
export class UploadFiles{
 constructor(readonly root:string){}
 async setup(){await fs.mkdir(this.root,{recursive:true,mode:0o700});const info=await fs.lstat(this.root);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Хранилище исходников недоступно.');}
 filename(id:string){return path.join(this.root,id.toLowerCase()+'.source');}
 partial(id:string,token:string){return path.join(this.root,id.toLowerCase()+'.'+token+'.partial');}
 async remove(id:string){
  id=id.toLowerCase();
  for(const name of await fs.readdir(this.root))if(name===id.toLowerCase()+'.source'||name.startsWith(id+'.')&&name.endsWith('.partial'))await fs.rm(path.join(this.root,name),{force:true});
 }
 async hash(filename:string,expectedBytes:number,expectedSha:string){
  const file=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
   const before=await file.stat();if(!before.isFile()||before.nlink!==1||before.size!==expectedBytes)throw new ConflictException('Сохранённый файл загрузки отсутствует или повреждён. Выберите архив повторно.');
   const hash=createHash('sha256');let bytes=0;
   for await(const chunk of file.createReadStream({autoClose:false})){bytes+=chunk.length;if(bytes>expectedBytes)throw new ConflictException('Размер исходника изменился.');hash.update(chunk);}
   const after=await file.stat();if(bytes!==expectedBytes||hash.digest('hex')!==expectedSha||before.ino!==after.ino||before.mtimeMs!==after.mtimeMs||before.size!==after.size||after.nlink!==1)throw new ConflictException('SHA-256 исходника изменился. Выберите архив повторно.');
  }finally{await file.close();}
 }
 async receive(input:Readable,id:string,token:string,bytes:number,sha256:string,signal:AbortSignal,check:()=>Promise<void>){
  const filename=this.partial(id,token),hash=createHash('sha256');let received=0,lastCheck=0;
  try{
   await pipeline(input,new Transform({transform(chunk:Buffer,_encoding,done){
    received+=chunk.length;if(received>bytes){done(new ConflictException('Загрузка превышает заявленный размер.'));return;}
    hash.update(chunk);const now=Date.now();
    if(now-lastCheck>500){lastCheck=now;void check().then(()=>done(null,chunk),error=>done(error));}else done(null,chunk);
   }}),createWriteStream(filename,{flags:'wx',mode:0o600}),{signal});
   if(received!==bytes||hash.digest('hex')!==sha256)throw new ConflictException('Загрузка оборвалась или SHA-256 не совпала. Повторите тот же файл.');
   const file=await fs.open(filename,'r+');try{await file.sync();await file.chmod(0o400);}finally{await file.close();}
   await check();await fs.rename(filename,this.filename(id));
   const directory=await fs.open(this.root,'r');try{await directory.sync();}finally{await directory.close();}
  }finally{await fs.rm(filename,{force:true});}
 }
}
