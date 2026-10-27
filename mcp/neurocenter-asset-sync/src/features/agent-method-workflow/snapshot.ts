import fs from 'node:fs/promises';
import {safeTarget} from '../../bridge/workspace.js';
import {hash} from '../../bridge/state.js';
import {readBoundedSnapshot} from '../../bridge/read-bounded.js';
import {MethodExecutionError,type MethodCommandRunner} from './process.js';
import type {AgentMethodWorkflowPayload,AgentMethodWorkflowResult} from './contract.js';

export type WorkspaceSnapshot=Map<string,string>;
/** Git's tracked and non-ignored inventory avoids dependencies and never follows a symlink outside the project. */
export async function snapshotWorkspace(root:string,run:MethodCommandRunner):Promise<WorkspaceSnapshot>{
 const result=await run('git',['ls-files','-z','--cached','--others','--exclude-standard'],true);
 if(result.code!==0)throw new MethodExecutionError('OBSERVATION_LIMIT');
 const paths=[...new Set(result.stdout.split('\0').filter(file=>!!file&&file!=='.opencode/neurocenter/files.lock'))].sort();
 if(paths.length>20000)throw new MethodExecutionError('OBSERVATION_LIMIT');
 const snapshot:WorkspaceSnapshot=new Map();let bytes=0;
 for(const relative of paths){
  const full=await safeTarget(root,relative),stat=await fs.lstat(full).catch((error:NodeJS.ErrnoException)=>{if(error.code==='ENOENT')return null;throw error;});
  if(!stat)continue;
  if(!stat.isFile()||stat.isSymbolicLink())throw new MethodExecutionError('OBSERVATION_LIMIT');
  bytes+=stat.size;if(stat.size>8*1024*1024||bytes>512*1024*1024||Buffer.byteLength(relative)>256)throw new MethodExecutionError('OBSERVATION_LIMIT');
  snapshot.set(relative,hash((await readBoundedSnapshot(full,8*1024*1024)).bytes));
 }
 return snapshot;
}
/** Compare against the actual pre-dispatch bytes, so pre-existing dirty work is not attributed to this run. */
export function methodChanges(before:WorkspaceSnapshot,after:WorkspaceSnapshot,method:AgentMethodWorkflowPayload['method']){
 const paths=[...new Set([...before.keys(),...after.keys()])].sort();
 const changes=paths.filter(file=>before.get(file)!==after.get(file)).map(file=>({path:file,beforeSha256:before.get(file)??null,afterSha256:after.get(file)??null}));
 const prefixes=method==='combined'?['_bmad-output/','openspec/']:[method==='bmad'?'_bmad-output/':'openspec/'];
 const artifacts=[...after].filter(([file])=>prefixes.some(prefix=>file.startsWith(prefix))).map(([file,sha256])=>({path:file,sha256}));
 if(changes.length>64||artifacts.length>64)throw new MethodExecutionError('OBSERVATION_LIMIT');
 const codeChanged=changes.some(row=>!row.path.startsWith('openspec/')&&!row.path.startsWith('_bmad/')&&!row.path.startsWith('_bmad-output/')&&!/^\.\w+\/skills\//.test(row.path));
 return {changes,artifacts,codeChanged} satisfies Pick<AgentMethodWorkflowResult,'changes'|'artifacts'|'codeChanged'>;
}
