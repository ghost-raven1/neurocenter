import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
/** An actual manifest fixture, independent from an installed daemon or real model weights. */
export async function runtimeManifest(root:string,name:string,fileSha='a'.repeat(64),size=4){const file=path.join(root,'models','manifests','registry.ollama.ai',...name.split(':')[0].split('/'),name.split(':')[1]),bytes=Buffer.from(JSON.stringify({schemaVersion:2,layers:[{mediaType:'application/vnd.ollama.image.model',digest:'sha256:'+fileSha,size}]}));await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,bytes);return {file,digest:createHash('sha256').update(bytes).digest('hex')};}
