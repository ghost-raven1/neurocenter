import path from 'node:path';
import {lstat,readFile,realpath} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {auditedUnitException,runtimeDependencies,runtimePg} from './unit-safe-profile.mjs';

const repository=fileURLToPath(new URL('../../',import.meta.url));
const slash=value=>value.split(path.sep).join('/');
const verification=file=>/(?:^|\/)(?:test|tests|fixtures|__tests__)(?:\/|$)/.test(file);
const extensions=['.ts','.tsx','.js','.jsx','.mts','.cts','.mjs','.cjs'];
const aliases={'.js':['.ts','.tsx'],'.jsx':['.tsx'],'.mjs':['.mts'],'.cjs':['.cts']};
const maxHelpers=64,maxEdges=256,maxBytes=2*1024*1024;
const inside=(root,file)=>{const relative=path.relative(root,file);return !!relative&&!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative);};
const hardMarker=(file,source,focused)=>/(?:database|postgres|(?:^|-)db|(?:^|-)s3)\.test\./.test(path.basename(file))||/databaseFixture|(?:[A-Z_]*TEST[A-Z_]*PG|[A-Z_]*TEST[A-Z_]*S3|TEST_STORAGE_CONFIG)/.test(source)
 ||focused&&(/\.(?:integration|e2e)\.test\./.test(path.basename(file))||/\bNEUROCENTER_CATALOG_READY\b/.test(source));
let parser;
/** Help/bootstrap stays Node-only; classification lazily uses the already installed Catalog parser. */
function classificationParser(){
 if(parser)return parser;
 try{
  const value=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url))('typescript');
  if(value.version!=='5.9.3')throw Error('Unsupported parser version');
  return parser=value;
 }catch{throw Error('Unit-safe classification requires installed Catalog TypeScript 5.9.3. Install the declared workspace dependencies before admission.');}
}

/** Parse input as data only: no program resolution, typecheck, emit or execution of test/fixture modules. */
function moduleSyntax(source,file){
 const ts=classificationParser(),spans=[];let opaque=false,tree;
 const extension=path.extname(file),kind=extension==='.tsx'?ts.ScriptKind.TSX:extension==='.jsx'?ts.ScriptKind.JSX
  :['.js','.cjs','.mjs'].includes(extension)?ts.ScriptKind.JS:ts.ScriptKind.TS;
 try{tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,false,kind);}
 catch{return {source:'',invalid:true,opaque:false};}
 if(tree.parseDiagnostics.length)return {source:'',invalid:true,opaque:false};
 const literal=node=>{
  if(!node||!ts.isStringLiteral(node)){opaque=true;return;}
  const statement='import '+JSON.stringify(node.text),dependencies=runtimeDependencies(statement);
  // The shared scanner must retain the complete decoded identity, including escaped literal targets.
  if(dependencies.length!==1||dependencies[0]!==node.text){opaque=true;return;}
  spans.push(statement);
 };
 const visit=node=>{
  if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)&&node.moduleSpecifier)literal(node.moduleSpecifier);
  else if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference))literal(node.moduleReference.expression);
  else if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword
   ||ts.isIdentifier(node.expression)&&node.expression.text==='require')){
   if(node.arguments.length!==1)opaque=true;else literal(node.arguments[0]);
  }
  ts.forEachChild(node,visit);
 };
 ts.forEachChild(tree,visit);return {source:spans.join(';\n'),invalid:false,opaque};
}

/** Read only ordinary retained source; redirected, unavailable or oversized helpers cannot be admitted. */
async function ordinarySource(root,file,remaining){
 if(!inside(root,file))return null;
 try{
  const stat=await lstat(file);
  if(!stat.isFile()||stat.size>remaining||await realpath(file)!==file)return null;
  const source=await readFile(file,'utf8');return Buffer.byteLength(source)>remaining?null:source;
 }catch{return null;}
}

/** Literal verification imports only: honor exact files, then TS aliases and bounded extension/index lookup. */
async function helperPath(root,target){
 const extension=path.extname(target),fallback=aliases[extension]?.map(value=>target.slice(0,-extension.length)+value)
  ??(extensions.includes(extension)?[]:extensions.flatMap(value=>[target+value,path.join(target,'index'+value)]));
 for(const candidates of [[target],fallback]){
  const matches=[];
  for(const file of candidates){
   if(!inside(root,file))return null;
   try{
    const stat=await lstat(file);
    if(stat.isSymbolicLink()||await realpath(file)!==file)return null;
    if(stat.isDirectory()&&file===target)continue;
    if(!stat.isFile()||!extensions.includes(path.extname(file)))return null;
    matches.push(file);
   }catch(error){if(!['ENOENT','ENOTDIR'].includes(error.code))return null;}
  }
  if(matches.length)return matches.length===1?matches[0]:null;
 }
 return null;
}

/** Never walk production imports or execute helpers; cycles/opaque paths and exhausted budgets fail closed. */
async function helperInfrastructure(root,file,source,state){
 const modules=moduleSyntax(source,file);
 if(modules.invalid||modules.opaque||runtimePg(modules.source))return true;
 state.active.add(file);
 for(const specifier of runtimeDependencies(modules.source)){
  if(path.isAbsolute(specifier)||specifier.startsWith('file:'))return true;
  if(!specifier.startsWith('.'))continue;
  const target=path.resolve(path.dirname(file),specifier);
  if(!inside(root,target))return true;
  if(!verification(slash(path.relative(root,target))))continue;
  if(++state.edges>maxEdges)return true;
  const helper=await helperPath(root,target);
  if(!helper||state.active.has(helper))return true;
  if(state.done.has(helper))continue;
  if(state.count>=maxHelpers)return true;
  const content=await ordinarySource(root,helper,maxBytes-state.bytes);
  if(content===null)return true;
  state.count++;state.bytes+=Buffer.byteLength(content);
  if(hardMarker(helper,content,state.focused)||await helperInfrastructure(root,helper,content,state))return true;
 }
 state.active.delete(file);state.done.add(file);return false;
}

/** Unit-safe never activates PG/S3 fallbacks; explicit integration profiles own those fixtures. */
export async function externalSuite(file,focused=false,{root=repository}={}){
 root=path.resolve(root);file=path.resolve(file);
 const source=await ordinarySource(root,file,maxBytes);
 if(source===null||hardMarker(file,source,focused))return true;
 if(await auditedUnitException(file,root))return false;
 if(runtimePg(source))return true;
 return helperInfrastructure(root,file,source,{active:new Set(),done:new Set(),count:1,edges:0,bytes:Buffer.byteLength(source),focused});
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
  if(await externalSuite(current,true,{root}))throw Error('--test-file cannot select infrastructure suites in unit-safe coverage: '+file);
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
