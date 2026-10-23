import path from 'node:path';
import {lstat,readFile} from 'node:fs/promises';
import {auditedUnitException,runtimePg} from './unit-safe-profile.mjs';

/** Unit-safe never activates PG/S3 fallbacks; explicit integration profiles own those fixtures. */
export async function externalSuite(file,focused=false){
 const source=await readFile(file,'utf8');
 if(/(?:database|postgres|(?:^|-)db|(?:^|-)s3)\.test\./.test(path.basename(file))||/databaseFixture|(?:[A-Z_]*TEST[A-Z_]*PG|[A-Z_]*TEST[A-Z_]*S3|TEST_STORAGE_CONFIG)/.test(source)
  ||focused&&(/\.(?:integration|e2e)\.test\./.test(path.basename(file))||/\bNEUROCENTER_CATALOG_READY\b/.test(source)))return true;
 return await auditedUnitException(file)?false:runtimePg(source);
}

/** Admit bounded exact unit files before the runner creates evidence or starts any worker. */
export async function focusedSelection({root,packages,chosen,testFiles,unit,native,integration,ownedPg}){
 if(!testFiles.length)return null;
 if(!unit||native||integration||ownedPg)throw Error('--test-file supports only the default unit-safe profile.');
 if(chosen.size!==1)throw Error('--test-file requires exactly one --package canonical ID.');
 if(testFiles.length>32)throw Error('--test-file accepts at most 32 files.');
 if(new Set(testFiles).size!==testFiles.length)throw Error('--test-file must not repeat a file.');
 for(const file of testFiles){
  if(typeof file!=='string'||file.length>512||!/^test\/.+\.test\.(?:ts|tsx|js|cjs|mjs)$/.test(file)
   ||/[\\\u0000-\u001f\u007f*?\[\]{}]/.test(file)||path.posix.normalize(file)!==file
   ||file.split('/').some(part=>!part||part==='.'||part==='..'))throw Error('--test-file must be a canonical test/<relative>.test.{ts,tsx,js,cjs,mjs} path without options or patterns.');
 }
 const name=[...chosen][0],relative=packages.find(([id])=>id===name)?.[1];
 if(!relative)throw Error('Unknown coverage package: '+name);
 const cwd=path.join(root,relative),absoluteFiles=[];
 for(const file of testFiles){
  const parts=[...relative.split('/'),...file.split('/')];let current=root;
  for(const[index,part]of parts.entries()){
   current=path.join(current,part);const entry=await lstat(current);
   if(entry.isSymbolicLink()||(index===parts.length-1?!entry.isFile():!entry.isDirectory()))throw Error('--test-file requires ordinary files and directories without symlinks.');
  }
  if(await externalSuite(current,true))throw Error('--test-file cannot select infrastructure suites in unit-safe coverage: '+file);
  absoluteFiles.push(current);
 }
 return{package:name,cwd,files:[...testFiles],absoluteFiles:absoluteFiles.sort()};
}

/** The reporter describes actual Vitest selection; separately prove that it equals the requested scope. */
export function reconcileFocusedSelection(inventory,selection){
 if(!selection)return inventory;
 const requestedFiles=selection.absoluteFiles,actual=new Set(inventory.expectedFiles),requested=new Set(requestedFiles);
 const missingRequestedFiles=requestedFiles.filter(file=>!actual.has(file));
 const unexpectedSelectedFiles=[...actual].filter(file=>!requested.has(file)).sort();
 return{...inventory,complete:inventory.complete&&!missingRequestedFiles.length&&!unexpectedSelectedFiles.length,
  requestedFiles,missingRequestedFiles,unexpectedSelectedFiles};
}
