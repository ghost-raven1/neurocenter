import {createRequire} from 'node:module';
const require=createRequire(new URL('../../services/catalog-service/package.json',import.meta.url));
const semver=require('semver');
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const fail=(code,message)=>{throw Object.assign(new Error(message),{code});};
const legacy=/^[~^]?\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/;

/** Wider npm ranges are resolved exclusively through an existing exact integrity lock. */
export function validateSourceDependencies(manifest,lock){
    const groups=['dependencies','optionalDependencies'];
    for(const group of groups){
        const dependencies=manifest[group]??{};
        if(!object(dependencies)||Object.entries(dependencies).some(([name,version])=>
            !/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(name)||typeof version!=='string'||version.length>256||!semver.validRange(version)))
            fail('SOURCE_DEPENDENCY_INVALID','Зависимости исходников должны задавать имена npm-пакетов и semver версии; Git, file, URL и теги не поддерживаются.');
    }
    if(!groups.some(group=>Object.values(manifest[group]??{}).some(version=>!legacy.test(version))))return;
    if(!object(lock)||![2,3].includes(lock.lockfileVersion)||!object(lock.packages)||!object(lock.packages['']))
        fail('SOURCE_DEPENDENCY_LOCK_REQUIRED','Для диапазона зависимостей нужен package-lock.json v2/v3 с точными версиями и integrity.');
    for(const group of groups)for(const [name,range] of Object.entries(manifest[group]??{})){
        const entry=lock.packages['node_modules/'+name];
        if(lock.packages[''][group]?.[name]!==range||!entry||!semver.valid(entry.version)||!semver.satisfies(entry.version,range))
            fail('SOURCE_DEPENDENCY_INVALID','Точная версия зависимости в lock-файле не соответствует package.json.');
    }
    for(const [name,entry] of Object.entries(lock.packages)){
        if(!name||entry.dev===true)continue;
        let url;try{url=new URL(entry.resolved);}catch{fail('SOURCE_DEPENDENCY_INVALID','Runtime-зависимость lock-файла требует официальный npm URL.');}
        if(!semver.valid(entry.version)||entry.link||!/^sha512-[A-Za-z0-9+/]{86}==$/.test(entry.integrity??'')
            ||url.protocol!=='https:'||url.hostname!=='registry.npmjs.org'||url.username||url.password)
            fail('SOURCE_DEPENDENCY_INVALID','Lock-файл должен закреплять runtime-зависимости точной версией, SHA-512 integrity и официальным npm registry.');
    }
}
