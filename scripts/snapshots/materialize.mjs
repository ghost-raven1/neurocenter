import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import contract from '../../services/shared/project-snapshot.cjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');

/** Reconstruct only a newly owned directory; no config or checkout path is accepted from the API. */
export async function materializeSnapshot(stage,claim,api,workerId,signal){
 const manifest=contract.normalizeSnapshotManifest(claim.manifest);
 if(contract.snapshotManifestHash(manifest)!==claim.manifestSha256||!/^[a-f0-9-]{36}$/.test(claim.snapshotId))throw new Error('FILES_CHANGED');
 const bytes=manifest.files.reduce((sum,file)=>sum+file.size,0),limit=Number(process.env.SNAPSHOT_MAX_BYTES||16*1024**3);
 if(!Number.isSafeInteger(limit)||limit<1||bytes>limit)throw new Error('RESOURCE_LIMIT');
 const disk=await fs.statfs(stage,{bigint:true});if(disk.bavail*disk.bsize<BigInt(bytes)+BigInt(256*1024**2))throw new Error('RESOURCE_LIMIT');
 const database=path.join(stage,'database');await fs.mkdir(database,{mode:0o755});
 for(const entry of manifest.files){
  signal?.throwIfAborted();const filename=path.join(database,...entry.path.split('/'));
  await fs.mkdir(path.dirname(filename),{recursive:true,mode:0o755});const file=await fs.open(filename,'wx',0o444),digest=createHash('sha256');let size=0;
  try{for(const part of entry.chunks){
    signal?.throwIfAborted();const block=await api(`${claim.snapshotId}/${workerId}/blobs/${part.sha256}`,{bytes:true,signal});
    if(block.length!==part.size||sha(block)!==part.sha256)throw new Error('FILES_CHANGED');
    await file.writeFile(block);digest.update(block);size+=block.length;
   }
   if(size!==entry.size||digest.digest('hex')!==entry.sha256)throw new Error('FILES_CHANGED');await file.sync();
  }finally{await file.close();}
 }
 await fs.writeFile(path.join(stage,'manifest.json'),contract.snapshotCanonicalJson(manifest),{flag:'wx',mode:0o444});await fs.chmod(stage,0o755);
 return manifest;
}
