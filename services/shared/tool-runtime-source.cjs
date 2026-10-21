'use strict';
const {isIP,BlockList}=require('node:net');
const {portablePath,TARGETS}=require('./runtime-artifacts.cjs');
const {validatePythonPlan}=require('./python-source-plan.cjs');
const adapters=Object.freeze({python:'Python',java:'Java',dotnet:'.NET',go:'Go',rust:'Rust',native:'Нативная программа'});
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).every(key=>keys.includes(key));
const blocked=new BlockList();
for(const [address,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]])blocked.addSubnet(address,prefix,'ipv4');
for(const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]])blocked.addSubnet(address,prefix,'ipv6');
const globalV6=new BlockList();globalV6.addSubnet('2000::',3,'ipv6');

/** DNS-проверка применяется повторно к каждому адресу фактического HTTPS-соединения. */
function isPublicRuntimeAddress(value){const family=isIP(value);return family===4?!blocked.check(value,'ipv4'):family===6&&globalV6.check(value,'ipv6')&&!blocked.check(value,'ipv6');}
function assetUrl(value){
 if(typeof value!=='string'||value.length>4096||/[\x00-\x20\x7f\\]/.test(value))throw new Error('Asset требует публичный HTTPS URL.');
 let url;try{url=new URL(value);}catch{throw new Error('Некорректный URL asset.');}
 const hostname=url.hostname.toLowerCase(),address=hostname.replace(/^\[|\]$/g,'');
 if(url.protocol!=='https:'||url.port||url.username||url.password||url.hash||!hostname.includes('.')||hostname.endsWith('.')||/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(hostname)||isIP(address)&&!isPublicRuntimeAddress(address))throw new Error('Asset требует публичный HTTPS URL без пароля, локального адреса и нестандартного порта.');
 return url.href;
}
function relative(value,label){if(typeof value!=='string'||!portablePath(value)||value.split('/').some(part=>part.toLowerCase()==='.git'))throw new Error(label+': нужен переносимый относительный путь.');return value;}
function asset(value,{local=false}={}){
 const directory=object(value)&&Object.hasOwn(value,'directory');
 if(!exact(value,directory&&local?['directory','entrypoint','executables']:['url','sha256','format','entrypoint','executables'])||directory&&!local)throw new Error('Asset содержит неподдерживаемые поля.');
 const entrypoint=relative(value.entrypoint,'Точка входа asset');
 if(/\.(?:sh|bash|zsh|bat|cmd|ps1)$/i.test(entrypoint))throw new Error('Shell-скрипт не является автономной точкой входа.');
 const executables=value.executables;
 if(executables!==undefined&&(!Array.isArray(executables)||executables.length>20000||new Set(executables).size!==executables.length))throw new Error('executables должен содержать уникальные пути.');
 const result={...(directory?{directory:value.directory==='.'?'.':relative(value.directory,'Папка app')}:{url:assetUrl(value.url),sha256:value.sha256,format:value.format}),entrypoint,...(executables?{executables:executables.map(item=>relative(item,'Исполняемый файл'))}:{})};
 if(!directory&&(!/^[a-f0-9]{64}$/.test(value.sha256??'')||!['tar.gz','zip','file'].includes(value.format)))throw new Error('Remote asset требует SHA-256 и формат tar.gz, zip или file.');
 return result;
}
/** Декларация готового приложения и runtime не содержит команд установки или компиляции. */
function validateRuntimeSource(value){
 if(!exact(value,['type','adapter','assets','python'])||value.type!=='runtime'||!Object.hasOwn(adapters,value.adapter)||!exact(value.assets,TARGETS)||!Object.keys(value.assets).length)throw new Error('runtime требует известный adapter и платформенные assets.');
 if(value.python!==undefined&&value.adapter!=='python')throw new Error('План Python разрешён только для adapter python.');
 const python=value.python===undefined?undefined:validatePythonPlan(value.python);
 const managed=['python','java','dotnet'].includes(value.adapter),assets={};
 for(const [target,bundle] of Object.entries(value.assets)){
  if(!exact(bundle,['app','runtime'])||managed&&!bundle.runtime||!managed&&bundle.runtime!==undefined)throw new Error('Python, Java и .NET требуют runtime; Go, Rust и native содержат готовую программу без runtime.');
  const app=asset(bundle.app,{local:true}),runtime=bundle.runtime?asset(bundle.runtime,{local:true}):undefined;
  if(python&&!runtime?.url)throw new Error('Автоматическая поставка Python требует закреплённый удалённый runtime.');
  const extension={python:/\.py$/i,java:/\.jar$/i,dotnet:/\.dll$/i}[value.adapter];
  if(extension&&!extension.test(app.entrypoint))throw new Error('Точка входа приложения не соответствует adapter '+value.adapter+'.');
  assets[target]={app,...(runtime?{runtime}:{})};
 }
 return {type:'runtime',adapter:value.adapter,assets,...(python?{python}:{})};
}
const runtimeSourceTargets=source=>Object.keys(validateRuntimeSource(source).assets);
function runtimeAdapterLabel(adapter){if(!Object.hasOwn(adapters,adapter))throw new Error('Неизвестный runtime adapter.');return adapters[adapter];}
module.exports={validateRuntimeSource,runtimeSourceTargets,runtimeAdapterLabel,isPublicRuntimeAddress};
