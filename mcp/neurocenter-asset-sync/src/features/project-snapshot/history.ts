import fs from 'node:fs/promises';
import path from 'node:path';
import {fileFingerprint} from '../../bridge/read-bounded.js';

/** Evaluation history is private and excluded; it cannot conceal another namespace or database. */
export async function assertEvaluationHistory(directory:string,maximumEntries:number,maximumDepth:number){
 let count=0;
 const fail=()=>new Error('История оценок содержит неподдерживаемый путь, вложенную LanceDB или превышает предел проверки. Полный снимок не обрезан.');
 const walk=async(file:string,depth:number):Promise<void>=>{
  if(++count>maximumEntries||depth>maximumDepth)throw fail();const stat=await fs.lstat(file,{bigint:true});
  if(stat.isSymbolicLink())throw fail();
  if(stat.isDirectory()){
   for await(const entry of await fs.opendir(file)){
    if(entry.name.toLowerCase().endsWith('.lance')||entry.name.toLowerCase()==='__manifest')throw fail();await walk(path.join(file,entry.name),depth+1);
   }
   if(fileFingerprint(await fs.lstat(file,{bigint:true}))!==fileFingerprint(stat))throw fail();
  }else if(!stat.isFile()||stat.nlink!==1n)throw fail();
 };
 await walk(directory,0);
}
