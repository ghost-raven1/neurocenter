import {createHash} from 'node:crypto';
import {createRequire,stripTypeScriptTypes,isBuiltin} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import {TARGETS} from './recipes/upstream.mjs';
import {validateSourceDependencies} from './source-dependency-lock.mjs';
import {assertPortableSourceResources} from './source-resource-validation.mjs';
const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const code=file=>/\.[cm]?[jt]s$/.test(file)&&!/\.d\.[cm]?ts$/.test(file);
const children=node=>Object.values(node).flatMap(value=>Array.isArray(value)?value.filter(item=>item?.type):value?.type?[value]:[]);
const fail=(message,code='SOURCE_RUNTIME_UNSUPPORTED')=>{throw Object.assign(new Error(message),{code});};

/** Inspect pinned bytes without loading a source module, dependency or lifecycle hook. */
export async function sourceInventory(files,candidates,targets){
 if(files.length>200||files.reduce((total,file)=>total+Buffer.byteLength(file.content),0)>5*1024**2)
  fail('Автоматическому рецепту нужны до 200 исходных файлов и 5 МиБ. Выберите готовую поставку.');
 const entries=new Map(files.map(file=>[file.path,file])),manifest=entries.has('package.json')?JSON.parse(entries.get('package.json').content):{};
 if(!manifest||typeof manifest!=='object'||Array.isArray(manifest))fail('package.json должен содержать объект.','SOURCE_DEPENDENCY_INVALID');
 if(manifest.type!==undefined&&!['module','commonjs'].includes(manifest.type))fail('package.json type должен быть module или commonjs.','SOURCE_DEPENDENCY_INVALID');
 const lockFile=entries.get('package-lock.json'),lock=lockFile?JSON.parse(lockFile.content):undefined;
 validateSourceDependencies(manifest,lock,{requireLock:true});
 const semver=require('semver');
 if(Number(process.versions.node.split('.')[0])!==24||manifest.engines?.bun||manifest.engines?.node&&!semver.satisfies(process.versions.node,manifest.engines.node))fail('Исходник требует другой runtime, который не входит в профиль Node24.');
 const permits=(values,value)=>!Array.isArray(values)||(!values.some(item=>typeof item!=='string'||!item.startsWith('!'))||values.includes(value))&&!values.includes('!'+value);
 if(targets.some(target=>!TARGETS[target]||!permits(manifest.os,TARGETS[target].os)||!permits(manifest.cpu,TARGETS[target].cpu)))
  fail('package.json не поддерживает одну из выбранных платформ. Выберите совместимые платформы.');
 if(Object.entries(lock?.packages??{}).some(([name,entry])=>name&&!entry.dev&&(entry.engines?.bun||entry.engines?.node&&!semver.satisfies(process.versions.node,entry.engines.node))))
  fail('Закреплённая зависимость требует runtime, несовместимый с Node24.');
 if(files.some(file=>/\.(?:node|dll|dylib|so|exe)$/.test(file.path))||Object.entries(lock?.packages??{}).some(([name,entry])=>name&&!entry.dev&&(entry.hasInstallScript||entry.os||entry.cpu||entry.libc)))
  fail('Исходнику нужны платформенные нативные зависимости или install hooks. Для них требуется отдельный проверенный адаптер.');
 const dependencies=Object.entries({...manifest.dependencies,...manifest.optionalDependencies}).map(([name,range])=>({name,range,version:lock?.packages?.['node_modules/'+name]?.version??''}));
 if(dependencies.length&&!lockFile)fail('Для автоматического рецепта сохраните package-lock.json с точными зависимостями.','SOURCE_DEPENDENCY_LOCK_REQUIRED');
 const nodes=new Map();
 for(const file of files.filter(file=>code(file.path))){
  let source=String(file.content),tree;
  try{if(/\.[cm]?ts$/.test(file.path))source=stripTypeScriptTypes(source,{mode:'transform'});tree=require('acorn').parse(source,{ecmaVersion:'latest',sourceType:'module',allowReturnOutsideFunction:true});}
  catch{continue;}
  const imports=[];let bun=false,dynamic=false;
  const walk=node=>{
   if(node.type==='Identifier'&&['Bun','Deno'].includes(node.name)||node.type==='MemberExpression'&&node.object.type==='MetaProperty'&&['dir','path','file'].includes(node.property.name))bun=true;
   if(node.type==='ImportDeclaration'||node.type==='ExportNamedDeclaration'||node.type==='ExportAllDeclaration'){if(node.source?.value)imports.push(node.source.value);}
   if(node.type==='ImportExpression'){if(typeof node.source?.value==='string')imports.push(node.source.value);else dynamic=true;}
   if(node.type==='CallExpression'&&node.callee.name==='require'){if(typeof node.arguments[0]?.value==='string')imports.push(node.arguments[0].value);else dynamic=true;}
   for(const child of children(node))walk(child);
  };walk(tree);
  let relativeResources=false;
  try{await assertPortableSourceResources(source,file.path);}catch(error){if(error.code!=='SOURCE_RESOURCE_UNSUPPORTED')throw error;relativeResources=true;}
  nodes.set(file.path,{imports,bun:bun||imports.some(value=>value==='bun'||value.startsWith('bun:')),dynamic,relativeResources});
 }
 const resolve=(from,specifier)=>{
  const base=path.posix.normalize(path.posix.join(path.posix.dirname(from),specifier));
  return [base,base.replace(/\.js$/,'.ts'),base.replace(/\.mjs$/,'.mts'),base.replace(/\.cjs$/,'.cts'),...['.js','.mjs','.cjs','.ts','.mts','.cts','/index.js','/index.ts'].map(extension=>base+extension)].find(file=>nodes.has(file));
 };
 const entrypoints=[],unsupported=new Set();
 for(const candidate of candidates){
  if(!nodes.has(candidate)){unsupported.add('синтаксис или формат файла запуска');continue;}
  const visited=new Set(),unresolved=new Set();let bun=false,resources=false,dynamic=false;
  const visit=file=>{if(visited.has(file))return;visited.add(file);const node=nodes.get(file);bun||=node.bun;resources||=node.relativeResources;dynamic||=node.dynamic;
   for(const dependency of node.imports){
    if(dependency.startsWith('.')){const next=resolve(file,dependency);if(next)visit(next);else unresolved.add(dependency);}
    else if(!isBuiltin(dependency)){
     const name=dependency.startsWith('@')?dependency.split('/').slice(0,2).join('/'):dependency.split('/')[0];
     if(!dependencies.length||!lock?.packages?.['node_modules/'+name]||lock.packages['node_modules/'+name].dev===true)unresolved.add(dependency);
    }
   }};visit(candidate);
  if(bun){unsupported.add('Bun/Deno runtime');continue;}
  if(dynamic){unsupported.add('динамический импорт с неизвестным путём');continue;}
  if(unresolved.size){unsupported.add('неразрешимый JS/TS import '+[...unresolved].slice(0,3).join(', '));continue;}
  const javascript=[...visited].every(file=>/\.[cm]?js$/.test(file));
  const modes=resources?javascript?['preserve']:[]:javascript?['bundle','preserve']:['bundle'];
  if(!modes.length)unsupported.add('сохранение module-relative ресурсов TypeScript');
  if(modes.length)entrypoints.push({path:candidate,runtime:'node24',modes,imports:[...new Set([...visited].flatMap(file=>nodes.get(file).imports))].sort().slice(0,64)});
 }
 if(!entrypoints.length)fail('Не поддерживается '+[...unsupported].join(', ')+'. Для этого исходника пока нет подходящего профиля изолированной проверки; запрос модели не отправлен.');
 const metadata=files.map(file=>({path:file.path,sha256:hash(file.content),bytes:Buffer.byteLength(file.content)})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
 const manifestSummary={type:['module','commonjs'].includes(manifest.type)?manifest.type:'auto',
  ...(typeof manifest.name==='string'&&/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(manifest.name)?{name:manifest.name.slice(0,128)}:{}),...(semver.valid(manifest.version)?{version:manifest.version.slice(0,64)}:{}),
  ...(typeof manifest.engines?.node==='string'?{node:manifest.engines.node.slice(0,256)}:{})};
 const inventory={schemaVersion:1,manifest:manifestSummary,manifestSha256:entries.has('package.json')?hash(entries.get('package.json').content):null,sourceSha256:hash(JSON.stringify(metadata)),targets:[...targets],lockSha256:lockFile?hash(lockFile.content):null,dependencies,entrypoints,
  resources:files.map(file=>file.path).filter(file=>!code(file)&&!['package.json','package-lock.json'].includes(file)&&!file.endsWith('.d.ts')).sort(),files:metadata};
 if(Buffer.byteLength(JSON.stringify(inventory))>10000)fail('Слишком много метаданных для ограниченного автоматического рецепта.');
 return inventory;
}

/** Read only regular source files admitted by the common project walker. */
export async function projectInventory(source,recipeDirectory,candidates,targets,projectFiles){
 const project=await projectFiles(source,recipeDirectory);
 const files=await Promise.all(project.files.map(async file=>({path:file.path,content:await fs.readFile(file.filename)})));
 return sourceInventory(files,candidates,targets);
}
