import { ConflictException } from '@nestjs/common';
import { buildPackage } from '../catalog/bundle-package';
import type { IImportItem } from './import-types';

/** Native install graph budget проверяется по virtual plan до первого binary fetch или native write. */
export function validateImportPlan(items:IImportItem[]):void {
 const tools=items.filter(item=>item.publication&&item.native&&item.action!=='conflict');
 for(const root of tools){
  const selected=new Map<string,IImportItem>(),visiting=new Set<string>();let files=0,bytes=0;
  const visit=(item:IImportItem):void=>{
   const native=item.native!,key=native.kind+':'+native.id,previous=selected.get(key);
   if(visiting.has(key)){throw new ConflictException('Native зависимости образуют цикл.');}
   if(previous){if(previous.native!.version!==native.version||previous.native!.manifest!==native.manifest){throw new ConflictException('В одном устанавливаемом графе требуются разные версии одного инструмента.');}return;}
   selected.set(key,item);const publication=item.publication!,dependencies=publication.dependencies??[];
   const config=dependencies.length?{...publication.config,extra:{...publication.config?.extra,requirements:{mcp:[],plugins:[],dependencies}}}:publication.config;
   const pkg=buildPackage({id:native.id,name:publication.name,kind:publication.kind,version:native.version},(publication.files??[]).map(file=>({path:file.path,content:file.content??''})),'',config);
   files+=pkg.files.length;bytes+=pkg.files.reduce((sum,file)=>sum+file.size,0);
   if(selected.size>20||files>200||bytes>16*1024*1024){throw new ConflictException('Комплект превышает 20 инструментов, 200 файлов или 16 МиБ. Разделите зависимости.');}
   visiting.add(key);
   for(const dependency of dependencies){const next=tools.find(candidate=>candidate.native!.id===dependency.id&&candidate.native!.version===dependency.version&&candidate.native!.manifest===dependency.manifest);
    if(!next){throw new ConflictException('В плане отсутствует точный native снимок зависимости.');}visit(next);}
   visiting.delete(key);
  };visit(root);
 }
 const names=new Map<string,string>();
 for(const item of tools){const name=item.publication!.name.toLocaleLowerCase('en-US'),id=item.native!.id,previous=names.get(name);if(previous&&previous!==id){throw new ConflictException('Несколько выбранных ассетов занимают одно название в native-каталоге.');}names.set(name,id);}
}
