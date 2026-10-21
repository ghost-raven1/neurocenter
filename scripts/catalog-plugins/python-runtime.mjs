import fs from 'node:fs/promises';
import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import pins from '../../services/shared/python-runtime-pins.cjs';
import {extractPinnedPythonArchive} from './python-trusted-archive.mjs';
import {installPythonDependencies} from './python-dependencies.mjs';

const failure=(code,message)=>Object.assign(new Error(message),{code});
const knownFailure=error=>['PYTHON_DEPENDENCIES_UNAVAILABLE','PYTHON_RUNTIME_UNAVAILABLE','PYTHON_SOURCE_INVALID'].includes(error.code);

/** Preserve executable resources from reviewed interpreters and wheel installers through canonical TAR normalization. */
export async function pythonExecutables(directory,prefixes=['runtime','python-deps']){
 const result=[];
 async function walk(relative){
  const filename=path.join(directory,relative),info=await fs.lstat(filename);
  if(info.isDirectory()){for(const name of await fs.readdir(filename))await walk(relative+'/'+name);}
  else if(info.isFile()&&info.nlink===1){if(info.mode&0o111)result.push(relative);}
  else throw failure('PYTHON_RUNTIME_UNAVAILABLE','В Python runtime или wheel запрещены ссылки и специальные файлы.');
 }
 for(const prefix of prefixes)await walk(prefix);
 return result.sort();
}

function hostTarget(){
 if(process.platform==='darwin'&&process.arch==='arm64')return 'darwin-arm64';
 if(process.platform==='linux'&&process.arch==='x64'&&process.report?.getReport().header.glibcVersionRuntime)return 'linux-x64-glibc';
 throw failure('PYTHON_RUNTIME_UNAVAILABLE','Сборка Python требует macOS ARM64 или Linux x64 glibc на сервере.');
}

async function assertProjectSource(plan,directory){
 const project=path.join(directory,'app',plan.projectDirectory);
 for(const relative of ['.',...plan.searchPaths]){
  const info=await fs.lstat(path.join(project,relative));if(!info.isDirectory()||info.isSymbolicLink())throw failure('PYTHON_SOURCE_INVALID','Путь импорта Python отсутствует или не является папкой.');
 }
 const candidates=plan.entry.type==='script'?[path.join(project,plan.entry.value)]:plan.searchPaths.flatMap(relative=>{
  const module=plan.entry.value.split(':')[0].replaceAll('.','/');
  return [path.join(project,relative,module+'.py'),path.join(project,relative,module,plan.entry.type==='module'?'__main__.py':'__init__.py')];
 });
 for(const filename of candidates){const info=await fs.lstat(filename).catch(error=>{if(error.code==='ENOENT'||error.code==='ENOTDIR')return undefined;throw error;});if(info?.isFile()&&info.nlink===1&&!info.isSymbolicLink()&&info.size)return;}
 throw failure('PYTHON_SOURCE_INVALID','Точка входа Python отсутствует в исходниках проекта.');
}

function bootstrap(plan){
 return `import importlib,os,runpy,site,sys
BASE=os.path.dirname(os.path.abspath(__file__))
site.addsitedir(os.path.join(BASE,'python-deps'))
PROJECT=os.path.join(BASE,'app',${JSON.stringify(plan.projectDirectory)})
for relative in reversed(${JSON.stringify(plan.searchPaths)}):sys.path.insert(0,os.path.join(PROJECT,relative))
ENTRY=${JSON.stringify(plan.entry.value)}
KIND=${JSON.stringify(plan.entry.type)}
if KIND=='script':
 sys.argv[0]=os.path.join(PROJECT,ENTRY)
 sys.path.insert(0,os.path.dirname(sys.argv[0]))
 runpy.run_path(sys.argv[0],run_name='__main__')
elif KIND=='module':
 runpy.run_module(ENTRY,run_name='__main__',alter_sys=True)
else:
 module,name=ENTRY.split(':',1)
 target=importlib.import_module(module)
 for part in name.split('.'):target=getattr(target,part)
 sys.exit(target())
`;
}

async function distributionMetadata(plan,destination){
 if(!plan.distribution)return;
 const {name,version}=plan.distribution;
 const directory=path.join(destination,name.replace(/[-.]+/g,'_')+'-'+version.replace(/-/g,'_')+'.dist-info');
 await fs.mkdir(directory,{recursive:false});
 await fs.writeFile(path.join(directory,'METADATA'),`Metadata-Version: 2.3\nName: ${name}\nVersion: ${version}\n${plan.requiresPython?'Requires-Python: '+plan.requiresPython+'\n':''}${plan.requirements.map(value=>'Requires-Dist: '+value+'\n').join('')}\n`,{flag:'wx'});
 await fs.writeFile(path.join(directory,'INSTALLER'),'neurocenter\n',{flag:'wx'});
 await fs.writeFile(path.join(directory,'RECORD'),'');
}

/** Source-only Python receives a pinned portable interpreter and hashed wheels without executing source build hooks. */
export async function preparePythonRuntimeSource(source,context,{prepareApp,downloadAsset,installDependencies=installPythonDependencies}={}){
 const {target,directory}=context,bundle=source.assets[target],plan=source.python;
 const expected=pins.pythonRuntimeAssets()[target];
 if(!expected||!isDeepStrictEqual(bundle.runtime,expected))throw failure('PYTHON_SOURCE_INVALID','Автоматический Python runtime должен совпадать с закреплённой поставкой.');
 const cacheDirectory=path.join(context.cacheDirectory??path.join(path.dirname(directory),'.source-cache'),'python');
 const host=hostTarget(),hostPins=pins.pythonBuildPins(host),targetPins=pins.pythonBuildPins(target);
 const producer=path.join(context.cacheDirectory??path.join(path.dirname(directory),'.source-cache'),'python-producer');
 await fs.mkdir(producer,{recursive:true,mode:0o700});
 if((await fs.lstat(producer)).isSymbolicLink())throw new Error('Python producer cache должен быть обычной папкой.');
 const work=await fs.mkdtemp(path.join(producer,'work-'));
 try{
  let app;
  try{app=await prepareApp(bundle.app);await assertProjectSource(plan,directory);}
  catch(error){error.code='PYTHON_SOURCE_INVALID';throw error;}
  // This namespace belongs to the producer; a source archive cannot replace generated bootstrap metadata.
  try{await fs.lstat(path.join(directory,'app','__neurocenter_python__'));throw failure('PYTHON_SOURCE_INVALID','Папка __neurocenter_python__ зарезервирована упаковщиком.');}catch(error){if(error.code!=='ENOENT')throw error;}
  const get=async pin=>{
   const {bytes,...asset}=pin;
   const result=await downloadAsset(asset,{...context,cacheDirectory});
   if(!result?.filename)throw new Error('Загрузчик Python не вернул закреплённый архив.');
   return result.filename;
  };
  const hostPythonArchive=await get(hostPins.python),uvArchive=await get(hostPins.uv);
  await extractPinnedPythonArchive(hostPythonArchive,hostPins.python,path.join(work,'host-runtime'),{headlessPython:true});
  await extractPinnedPythonArchive(uvArchive,hostPins.uv,path.join(work,'uv'));
  const runtimeArchive=host===target?hostPythonArchive:await get(targetPins.python);
  const normalization=await extractPinnedPythonArchive(runtimeArchive,targetPins.python,path.join(directory,'runtime'),{headlessPython:true});
  let dependencies;
  try{dependencies=await installDependencies({plan,target,uv:path.join(work,'uv',hostPins.uv.entrypoint),python:path.join(work,'host-runtime',hostPins.python.entrypoint),directory:work,destination:path.join(directory,'python-deps')});}
  catch(error){if(!knownFailure(error))error.code='PYTHON_DEPENDENCIES_UNAVAILABLE';throw error;}
  await distributionMetadata(plan,path.join(directory,'python-deps'));
  await fs.writeFile(path.join(directory,'python-entry.py'),bootstrap(plan),{flag:'wx'});
  await fs.writeFile(path.join(directory,'python-lock.toml'),dependencies.content,{flag:'wx'});
  const provenance={schemaVersion:1,python:pins.PYTHON_VERSION,pythonRelease:pins.PBS_RELEASE,uv:pins.UV_VERSION,target,platform:targetPins.platform,runtime:targetPins.python,normalization,producer:{runtime:hostPins.python,uv:hostPins.uv},packages:dependencies.packages};
  await fs.writeFile(path.join(directory,'python-build.json'),JSON.stringify(provenance,null,2)+'\n',{flag:'wx'});
  return {appEntry:'python-entry.py',runtimeEntry:'runtime/'+targetPins.python.entrypoint,executables:await pythonExecutables(directory),locks:['python-lock.toml','python-build.json'],upstream:{adapter:'python',app,python:provenance}};
 }catch(error){if(!knownFailure(error))error.code='PYTHON_RUNTIME_UNAVAILABLE';throw error;}
 finally{await fs.rm(work,{recursive:true,force:true});}
}
