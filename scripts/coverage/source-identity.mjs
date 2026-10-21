import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {readFileSync,lstatSync,readlinkSync} from 'node:fs';

/** New source files must participate in provenance before their first commit. Ignored files stay outside the inventory. */
export function untrackedContentDigest(root,files){
 const hash=createHash('sha256');
 for(const file of [...files].sort()){
  hash.update(file+'\0');
  try{const filename=path.join(root,file),info=lstatSync(filename);hash.update(info.isSymbolicLink()?readlinkSync(filename):readFileSync(filename));}
  catch(error){if(error.code!=='ENOENT')throw error;hash.update('[removed during identity]');}
  hash.update('\0');
 }
 return hash.digest('hex');
}
export function sourceIdentity(root){
 const git=args=>{const result=spawnSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:32*1024**2});if(result.status!==0)throw Error('Cannot identify Git worktree');return result.stdout.trim();};
 return {head:git(['rev-parse','HEAD']),status:git(['status','--porcelain=v1','--untracked-files=all']),
  trackedDiffSha256:createHash('sha256').update(git(['diff','--binary','HEAD'])).digest('hex'),
  untrackedContentSha256:untrackedContentDigest(root,git(['ls-files','--others','--exclude-standard','-z']).split('\0').filter(Boolean))};
}
