import fs from 'node:fs/promises';
import path from 'node:path';
import {extractRelease} from './source-adapters.mjs';
import {detectReadyPayload} from './release-inspection.mjs';

/** Local durable bytes use the same safe extractor and executable evidence as GitHub releases. */
export async function inspectUploadArchive(filename,{name,format}){
 const directory=await fs.mkdtemp(path.join(path.dirname(filename),'.upload-inspection-'));
 try{
  if(format==='file')await fs.copyFile(filename,path.join(directory,name));
  else await extractRelease(filename,{format},directory);
  const choices=await detectReadyPayload(directory),candidates=[...new Set(choices.map(choice=>choice.entrypoint))];
  if(choices.some(choice=>choices.filter(other=>other.entrypoint===choice.entrypoint).length>1))throw new Error('В архиве несколько runtime для одного приложения. Выберите готовую поставку с одним runtime.');
  const single=choices.length===1?choices[0]:undefined;
  return {candidates,choices,entrypoint:single?.entrypoint??'',requiresEntrypointChoice:!single,runnableKinds:['mcp'],...(single?{adapter:single.adapter,supportedTargets:single.targets}:{})};
 }finally{await fs.rm(directory,{recursive:true,force:true});}
}
