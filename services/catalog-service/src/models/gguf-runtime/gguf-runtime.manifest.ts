import {ConflictException} from '@nestjs/common';
import {constants} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import type {GgufImportPolicy} from '../../../../shared/gguf-import-policy.cjs';

/** Reads only the owned alias manifest and proves its single model layer is the accepted file SHA. */
export async function ggufRuntimeManifest(root:string,alias:string,sha256:string,bytes:number,limits:GgufImportPolicy):Promise<string>{
 if(!/^neurocenter\/gguf-[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}:v1$/.test(alias))throw new ConflictException('Не подтверждено собственное имя GGUF runtime.');
 const [name,tag]=alias.split(':'),parts=['models','manifests','registry.ollama.ai',...name.split('/')];let parent=path.resolve(root);
 for(const item of ['',...parts]){if(item)parent=path.join(parent,item);const info=await fs.lstat(parent);if(!info.isDirectory()||info.isSymbolicLink())throw new ConflictException('Каталог manifest runtime не подтверждён. Проверьте настройку хранилища.');}
 const filename=path.join(parent,tag),file=await fs.open(filename,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const before=await file.stat();if(!before.isFile()||before.nlink!==1||before.size<1||before.size>limits.runtimeResponseBytes)throw new ConflictException('Manifest GGUF отсутствует или превышает настроенный лимит.');const data=Buffer.alloc(before.size);let received=0;while(received<data.length){const result=await file.read(data,received,data.length-received,received);if(!result.bytesRead)throw new ConflictException('Manifest обрезан во время чтения.');received+=result.bytesRead;}
  const manifest=JSON.parse(data.toString('utf8')) as {schemaVersion?:unknown;layers?:Array<{mediaType?:unknown;digest?:unknown;size?:unknown}>};
  const modelLayers=Array.isArray(manifest.layers)?manifest.layers.filter(layer=>layer?.mediaType==='application/vnd.ollama.image.model'):[];
  if(manifest.schemaVersion!==2||modelLayers.length!==1||modelLayers[0].digest!=='sha256:'+sha256||modelLayers[0].size!==bytes||manifest.layers?.some(layer=>typeof layer?.mediaType!=='string'||/adapter|projector/.test(layer.mediaType)))throw new ConflictException('Manifest runtime не соответствует единственному принятому GGUF. Чужая модель сохранена.');
  const after=await file.stat(),current=await fs.lstat(filename);if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||after.nlink!==1||current.isSymbolicLink()||current.ino!==after.ino)throw new ConflictException('Manifest GGUF изменился во время проверки.');return createHash('sha256').update(data).digest('hex');
 }catch(error){if(error instanceof ConflictException||(error as NodeJS.ErrnoException).code)throw error;throw new ConflictException('Manifest GGUF повреждён. Проверьте runtime.');}finally{await file.close();}
}
