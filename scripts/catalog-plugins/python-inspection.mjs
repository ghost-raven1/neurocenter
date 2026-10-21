import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import pythonSource from '../../services/shared/python-source-plan.cjs';
import {pythonRuntimeAssets,PYTHON_VERSION} from '../../services/shared/python-runtime-pins.cjs';
import runtime from '../../services/shared/runtime-artifacts.cjs';

const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const {parse}=require('smol-toml');
const pep440=await import(pathToFileURL(require.resolve('@renovatebot/pep440')).href);
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const within=(file,directory)=>directory==='.'?file:file.startsWith(directory+'/')?file.slice(directory.length+1):undefined;
const join=(directory,file)=>directory==='.'?file:directory+'/'+file;

async function text(file,label,limit=65536){
 if(file.size>limit)throw new Error(label+' превышает '+(limit===65536?'64 КиБ.':'1 МиБ.'));
 const bytes=await fs.readFile(file.filename),value=bytes.toString('utf8');
 if(bytes.includes(0)||!Buffer.from(value).equals(bytes))throw new Error(label+' должен содержать UTF-8 без NUL.');
 return value;
}
async function requirements(file){
 if(!file)return [];
 const lines=(await text(file,'requirements.txt')).split(/\r?\n/),result=[];
 for(const raw of lines){
  const line=raw.trim();if(!line||line.startsWith('#'))continue;
  // Only whitespace-delimited comments outside quoted markers are comments.
  let quote='',end=line.length;
  for(let index=0;index<line.length;index++){const char=line[index];if(quote){if(char===quote)quote='';}else if(char==='"'||char==="'")quote=char;else if(char==='#'&&index>0&&/\s/.test(line[index-1])){end=index;break;}}
  result.push(line.slice(0,end).trim());
 }
 return pythonSource.validatePythonRequirements(result);
}
function searchPaths(files,directory){return ['.',...(files.some(file=>within(file.path,directory)?.startsWith('src/'))?['src']:[])];}
function sourceDirectory(files){
 let directory='.';
 while(true){
  const relative=files.map(file=>within(file.path,directory)),first=relative[0]?.split('/')[0];
  if(!first||!relative.every(file=>file?.startsWith(first+'/')))return directory;
  const next=join(directory,first);
  // A Python package is executable as a module; stripping its package name breaks relative imports.
  if(files.some(file=>file.path===next+'/__main__.py'||file.path===next+'/__init__.py'))return directory;
  directory=next;
 }
}
function moduleExists(files,directory,search,module){
 const relative=module.replaceAll('.','/');
 return search.some(prefix=>[relative+'.py',relative+'/__init__.py'].some(file=>files.some(item=>item.path===join(directory,prefix==='.'?file:prefix+'/'+file))));
}
/** A GitHub blob can name the source module while the actual command uses a generated callable launcher. */
export function pythonEntrypointFiles(plan){
 if(plan.entry.type==='script')return [join(plan.projectDirectory,plan.entry.value)];
 const module=plan.entry.value.split(':')[0].replaceAll('.','/');
 return plan.searchPaths.flatMap(prefix=>[module+'.py',module+'/'+(plan.entry.type==='module'?'__main__.py':'__init__.py')].map(file=>join(plan.projectDirectory,prefix==='.'?file:prefix+'/'+file)));
}
function checkPythonVersion(value){
 if(typeof value!=='string'||!value.trim()||!pep440.validRange(value))throw new Error('requires-python должен содержать статическое ограничение PEP 440.');
 if(!pep440.satisfies(PYTHON_VERSION,value))throw new Error('Проект требует Python '+value+'; встроенная версия '+PYTHON_VERSION+' не подходит.');
 return value.trim();
}
function commandName(value){if(typeof value!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)||!runtime.portablePath(value+'.py')||value==='.'||value==='..')throw new Error('Имя команды Python должно быть переносимым именем без путей.');return value;}

/** Inspect only static PEP 621 metadata and source bytes; setup.py and build hooks never run. */
export async function inspectPythonSource(directory,files){
 const pythonFiles=files.filter(file=>file.path.endsWith('.py'));
 if(!pythonFiles.length)return [];
 if(files.some(file=>file.path.split('/')[0].toLowerCase()==='__neurocenter_python__'))throw new Error('Папка __neurocenter_python__ зарезервирована упаковщиком.');
 const manifests=files.filter(file=>path.posix.basename(file.path)==='pyproject.toml');
 const manifest=manifests.find(file=>file.path==='pyproject.toml')??(manifests.length===1?manifests[0]:undefined);
 if(!manifest&&manifests.length>1)throw new Error('В архиве несколько Python-проектов. Выберите папку нужного проекта в GitHub или отдельный архив.');
 let projectDirectory=manifest?path.posix.dirname(manifest.path):'.',project,requirementFile;
 if(manifest){
  let metadata;try{metadata=parse(await text(manifest,'pyproject.toml'));}catch(error){if(/64 КиБ|UTF-8/.test(error.message))throw error;throw new Error('pyproject.toml содержит некорректный TOML.');}
  project=metadata.project;
  if(!object(project))throw new Error('Для Python нужен статический раздел [project] в pyproject.toml; setup.py и build hooks не выполняются.');
  if(project.dynamic!==undefined&&(!Array.isArray(project.dynamic)||project.dynamic.some(value=>typeof value!=='string')))throw new Error('project.dynamic должен быть списком полей.');
  if(project.dynamic?.some(value=>['dependencies','scripts','entry-points','version','requires-python'].includes(value)))throw new Error('Динамические зависимости, версия, ограничение Python или команды требуют выполнения build hooks. Укажите их статически в pyproject.toml.');
  if(typeof project.name!=='string'||typeof project.version!=='string'||!pep440.valid(project.version))throw new Error('В [project] нужны статические name и version PEP 440; build hooks не выполняются.');
 }else{
  const roots=files.filter(file=>path.posix.basename(file.path)==='requirements.txt');
  if(roots.length>1)throw new Error('В архиве несколько requirements.txt. Выберите отдельную папку проекта Python.');
  requirementFile=roots[0];projectDirectory=sourceDirectory(files);
  if(files.some(file=>['setup.py','setup.cfg'].includes(path.posix.basename(file.path))))throw new Error('setup.py/setup.cfg требуют сборки. Используйте статический pyproject.toml или requirements.txt и готовый .py-файл.');
 }
 const search=searchPaths(files,projectDirectory);
 // PEP 621 owns the dependency list; requirements.txt is the source-only fallback without [project].
 const dependencies=project?pythonSource.validatePythonRequirements(project.dependencies??[]):await requirements(requirementFile);
 const base={schemaVersion:1,projectDirectory,searchPaths:search,requirements:dependencies,
  ...(project?.['requires-python']!==undefined?{requiresPython:checkPythonVersion(project['requires-python'])}:{}),
  ...(project?{distribution:{name:project.name,version:project.version}}:{})};
 const entries=[];
 if(project?.scripts!==undefined){
  if(!object(project.scripts))throw new Error('project.scripts должен содержать имена команд и module:callable.');
  for(const[name,value]of Object.entries(project.scripts))entries.push({entrypoint:'__neurocenter_python__/'+commandName(name)+'.py',entry:{type:'callable',value}});
 }
 if(!entries.length){
  for(const file of pythonFiles){
   const relative=within(file.path,projectDirectory);if(relative===undefined||/(?:^|\/)(?:tests?|examples?|\.venv|venv|__pycache__)(?:\/|$)/.test(relative))continue;
   const source=await text(file,'Скрипт Python',1048576);
   if(!/(?:if\s+__name__\s*==\s*["']__main__["']|(?:^|\/)__main__\.py$)/m.test(source+'\n'+relative)&&!(pythonFiles.length===1&&!relative.endsWith('__init__.py')))continue;
   const importPath=relative.startsWith('src/')&&search.includes('src')?relative.slice(4):relative;
   const parent=path.posix.dirname(importPath),packaged=parent!=='.'&&parent.split('/').some((_part,index,parts)=>files.some(item=>item.path===join(projectDirectory,(relative.startsWith('src/')?'src/':'')+parts.slice(0,index+1).join('/')+'/__init__.py')));
   if(importPath.endsWith('/__main__.py')||packaged){
    const module=(importPath.endsWith('/__main__.py')?importPath.slice(0,-'/__main__.py'.length):importPath.slice(0,-3)).replaceAll('/','.');
    entries.push({entrypoint:'__neurocenter_python__/'+commandName(module.replaceAll('.','-'))+'.py',entry:{type:'module',value:module}});
   }else entries.push({entrypoint:file.path,entry:{type:'script',value:relative}});
  }
 }
 return entries.map(({entrypoint,entry})=>{
  const python=pythonSource.validatePythonPlan({...base,entry});
  if(entry.type==='callable'&&!moduleExists(files,projectDirectory,search,entry.value.split(':')[0]))throw new Error('Модуль команды '+entry.value+' не найден в проекте Python.');
  const runtimeAssets=pythonRuntimeAssets();
  return {entrypoint,adapter:'python',targets:Object.keys(runtimeAssets),python,runtimeAssets};
 });
}
