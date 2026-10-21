'use strict';
const {portablePath}=require('./runtime-artifacts.cjs');
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).every(key=>keys.includes(key));
const dotted=/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/;
function relative(value,label){
 if(typeof value!=='string'||value!=='.'&&(!portablePath(value)||value.split('/').some(part=>part.toLowerCase()==='.git')))throw new Error(label+': нужен переносимый относительный путь.');
 return value;
}
/** Dependencies are data only: no pip options, paths, URLs, VCS references or line continuations. */
function validatePythonRequirements(value){
 if(!Array.isArray(value)||value.length>1024)throw new Error('Зависимости Python должны быть статическим списком PEP 508.');
 return value.map(item=>{
  if(typeof item!=='string'||item.length>4096||/[\x00-\x1f\x7f\\/@:]/.test(item)||!/^\s*[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\s*\[\s*[A-Za-z0-9._-]+(?:\s*,\s*[A-Za-z0-9._-]+)*\s*\])?(?:\s*(?:[<>=!~(]|;)[A-Za-z0-9_.+*<>=!~(),;\[\] '"-]*)?\s*$/.test(item))throw new Error('Зависимости Python: разрешены только имена PyPI, версии, extras и маркеры PEP 508; URL, VCS, локальные пути и параметры pip запрещены.');
  return item.trim();
 });
}
/** Stable internal plan is persisted before a build is queued; it never contains executable setup commands. */
function validatePythonPlan(value){
 if(!exact(value,['schemaVersion','projectDirectory','entry','searchPaths','requirements','requiresPython','distribution'])||value.schemaVersion!==1||!exact(value.entry,['type','value']))throw new Error('План Python требует schemaVersion: 1 и статическую точку входа.');
 const projectDirectory=relative(value.projectDirectory,'Папка Python'),entry=value.entry;
 if(!['script','module','callable'].includes(entry.type)||typeof entry.value!=='string'||entry.value.length>1024)throw new Error('Неизвестный тип точки входа Python.');
 if(entry.type==='script'){relative(entry.value,'Скрипт Python');if(entry.value==='.'||!entry.value.endsWith('.py'))throw new Error('Скрипт Python должен быть файлом .py.');}
 else if(entry.type==='module'?!dotted.test(entry.value):entry.value.split(':').length!==2||!entry.value.split(':').every(part=>dotted.test(part)))throw new Error('Точка входа Python должна быть module или module:callable, без выражений и аргументов.');
 if(!Array.isArray(value.searchPaths)||!value.searchPaths.length||value.searchPaths.length>16||new Set(value.searchPaths).size!==value.searchPaths.length)throw new Error('Пути импорта Python должны быть уникальными относительными каталогами.');
 const searchPaths=value.searchPaths.map(item=>relative(item,'Путь импорта Python')),requirements=validatePythonRequirements(value.requirements);
 if(value.requiresPython!==undefined&&(typeof value.requiresPython!=='string'||!value.requiresPython.trim()||value.requiresPython.length>512||!/^[\dA-Za-z.*+!<>=~, -]+$/.test(value.requiresPython)))throw new Error('requires-python должен содержать статическое ограничение PEP 440.');
 if(value.distribution!==undefined&&(!exact(value.distribution,['name','version'])||typeof value.distribution.name!=='string'||value.distribution.name.length>200||!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value.distribution.name)||typeof value.distribution.version!=='string'||!/^[A-Za-z0-9][A-Za-z0-9.!+_-]{0,127}$/.test(value.distribution.version)))throw new Error('Метаданные Python требуют статические name и version без управляющих символов.');
 return {schemaVersion:1,projectDirectory,entry:{type:entry.type,value:entry.value},searchPaths,requirements,...(value.requiresPython!==undefined?{requiresPython:value.requiresPython.trim()}:{}),...(value.distribution?{distribution:{name:value.distribution.name,version:value.distribution.version}}:{})};
}
module.exports={validatePythonPlan,validatePythonRequirements};
