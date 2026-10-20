import {constants,createWriteStream} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import type {PinnedUploadSource} from './source-upload.model';
import {UploadFiles} from './source-upload.files';
import {runtimeArtifactDirectory} from '../runtime-artifacts/runtime-artifacts';

/** The builder receives a private stage copy, never a user-controlled server path. */
export async function stageUploadSource(source:PinnedUploadSource,stage:string){
 const files=new UploadFiles(path.join(runtimeArtifactDirectory(),'.source-uploads'));await files.hash(files.filename(source.uploadId),source.bytes,source.sha256);
 const filename=path.join(stage,'source.upload'),input=await fs.open(files.filename(source.uploadId),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{await pipeline(input.createReadStream({autoClose:false}),createWriteStream(filename,{flags:'wx',mode:0o600}));}finally{await input.close();}
 await files.hash(filename,source.bytes,source.sha256);
 return {type:'archive',file:'source.upload',sha256:source.sha256,bytes:source.bytes,format:source.format,runtimeSource:source.runtimeSource};
}
