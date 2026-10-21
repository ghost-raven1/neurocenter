import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
import pins from '../../services/shared/python-runtime-pins.cjs';

const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const {parse}=require('smol-toml');

/** Producer tools receive neither user config nor credentials, system Python, or executable search paths. */
export async function runPythonBuildTool(command,args,{directory,input,timeout=300_000}={}){
 const home=path.join(directory,'home'),empty=path.join(directory,'empty-bin'),temporary=path.join(directory,'tmp');
 await fs.mkdir(home,{recursive:true});await fs.mkdir(empty,{recursive:true});await fs.mkdir(temporary,{recursive:true});
 return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd:directory,env:{HOME:home,PATH:empty,TMPDIR:temporary,TMP:temporary,TEMP:temporary,LANG:'C.UTF-8',UV_PYTHON_DOWNLOADS:'never',MACOSX_DEPLOYMENT_TARGET:'13.0'},shell:false,stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='',bytes=0,timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeout);timer.unref();
  for(const [name,stream] of [['stdout',child.stdout],['stderr',child.stderr]])stream.on('data',chunk=>{
   bytes+=chunk.length;if(bytes>1024*1024){child.kill('SIGKILL');return;}
   if(name==='stdout')stdout+=chunk;else stderr+=chunk;
  });
  child.once('error',error=>{clearTimeout(timer);reject(error);});
  child.once('close',code=>{clearTimeout(timer);if(code!==0||timedOut||bytes>1024*1024)reject(new Error(timedOut?'Истекло время подготовки Python.':bytes>1024*1024?'Python producer превысил лимит вывода.':'Не удалось подготовить Python: '+stderr.slice(-8192)));else resolve({stdout,stderr});});
  child.stdin.on('error',()=>{});child.stdin.end(input??'');
 });
}

/** A lock may contain only hashed public PyPI wheels; source builds and arbitrary registries are forbidden. */
export function validatePythonLock(content){
 if(Buffer.byteLength(content)>4*1024*1024)throw new Error('Python lock превышает 4 МиБ.');
 const lock=parse(content);
 if(lock['lock-version']!=='1.0'||!Array.isArray(lock.packages)||lock.packages.length>1000)throw new Error('Некорректный Python lock.');
 let bytes=0;
 for(const item of lock.packages){
  if(typeof item.name!=='string'||typeof item.version!=='string'||item.directory||item.vcs||item.archive||!Array.isArray(item.wheels)||!item.wheels.length||item.sdist)throw new Error('Python требует готовые wheels без source build.');
  for(const wheel of item.wheels){
   let url;try{url=new URL(wheel.url);}catch{throw new Error('Некорректный URL Python wheel.');}
   if(Object.keys(wheel).some(key=>!['url','upload-time','size','hashes'].includes(key))||url.protocol!=='https:'||url.hostname!=='files.pythonhosted.org'||url.port||url.username||url.password||url.hash||!url.pathname.endsWith('.whl')||!/^[a-f0-9]{64}$/.test(wheel.hashes?.sha256)||!Number.isSafeInteger(wheel.size)||wheel.size<=0||wheel.size>256*1024**2)throw new Error('Python lock требует SHA-256, размер и официальный PyPI wheel.');
   bytes+=wheel.size;
  }
 }
 if(bytes>1024**3)throw new Error('Python wheels превышают 1 ГиБ.');
 return lock;
}

const validateCode=`import json,sys,sysconfig
sys.path.insert(0,sysconfig.get_path('purelib'))
from pip._vendor.packaging.requirements import Requirement
from pip._vendor.packaging.specifiers import SpecifierSet
value=json.load(sys.stdin)
if value.get('requiresPython') and not SpecifierSet(value['requiresPython']).contains('${pins.PYTHON_VERSION}',prereleases=False): raise ValueError('Проект несовместим с Python ${pins.PYTHON_VERSION}')
for raw in value['requirements']:
 r=Requirement(raw)
 if r.url is not None: raise ValueError('Допускаются только зависимости PyPI без URL')
print('ok')
`;

/** Cross-platform resolution uses target markers and a clean pinned host interpreter, never app dependencies. */
export async function installPythonDependencies({plan,target,uv,python,directory,destination,run=runPythonBuildTool}){
 await run(python,['-I','-S','-c',validateCode],{directory,input:JSON.stringify(plan)});
 const requirements=path.join(directory,'requirements.in'),lock=path.join(directory,'pylock.toml');
 await fs.writeFile(requirements,plan.requirements.join('\n')+'\n',{flag:'wx',mode:0o600});
 const common=['--python',python,'--no-python-downloads','--no-build','--no-sources','--python-version',pins.PYTHON_VERSION,'--python-platform',pins.pythonBuildPins(target).platform,'--no-cache','--keyring-provider','disabled','--no-progress'];
 if(plan.requirements.length){
  await run(uv,['--no-config','pip','compile',requirements,...common,'--format','pylock.toml','-o',lock,'--default-index','https://pypi.org/simple','--no-header'],{directory});
 }else await fs.writeFile(lock,'lock-version = "1.0"\ncreated-by = "neurocenter"\npackages = []\n',{flag:'wx'});
 const content=(await fs.readFile(lock,'utf8')).split('\n').filter(line=>!line.startsWith('#')).join('\n').trim()+'\n';
 const parsed=validatePythonLock(content);await fs.writeFile(lock,content);
 await fs.mkdir(destination,{recursive:true});
 if(parsed.packages.length)await run(uv,['--no-config','pip','sync',lock,...common,'--target',destination,'--require-hashes','--no-index','--link-mode','copy','--no-compile-bytecode','--output-format','json'],{directory});
 // UV's generated console shebangs contain producer paths. MCP starts through our relocatable Python launcher.
 await fs.rm(path.join(destination,'bin'),{recursive:true,force:true});await fs.rm(path.join(destination,'.lock'),{force:true});
 return {content,packages:parsed.packages.map(item=>({name:item.name,version:item.version}))};
}
