import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {privateSnapshotFile} from '../snapshots/control.mjs';

const names = ['ENDPOINT', 'REGION', 'ACCESS_KEY', 'SECRET_KEY', 'PROJECT_BUCKET', 'PERSONAL_BUCKET'];

/** Probe configuration and private buckets before the running application is stopped. */
async function preflight(root, supplied, environment, dependencies) {
    const read = async name => supplied[name] || (await privateSnapshotFile(supplied[name + '_FILE'], 65536)).toString('utf8').trim();
    const config = {endpoint: supplied.CHAT_S3_ENDPOINT, region: supplied.CHAT_S3_REGION || 'us-east-1',
        projectBucket: supplied.CHAT_S3_PROJECT_BUCKET, personalBucket: supplied.CHAT_S3_PERSONAL_BUCKET,
        accessKey: await read('CHAT_S3_ACCESS_KEY'), secretKey: await read('CHAT_S3_SECRET_KEY')};
    if (dependencies.probe) {await dependencies.probe(config); return;}
    const {ChatObjectStorage} = createRequire(path.join(root, 'services/catalog-service/package.json'))('./dist/model-chat/chat-object-storage.js');
    await new ChatObjectStorage(config, {environment}).initialize();
}

/** A new Ceph identity is published as one private directory, never over an existing volume. */
async function cephCredentials(root,directory,project,environment,run) {
    const state=path.dirname(directory),stateInfo=await fs.lstat(state).catch(error=>{if(error.code!=='ENOENT')throw error;});
    if(stateInfo&&(!stateInfo.isDirectory()||stateInfo.isSymbolicLink()))throw Error('UNSAFE_CEPH_DIRECTORY');
    await fs.mkdir(directory,{recursive:true,mode:0o700});
    const expected=path.join(await fs.realpath(root),'.run/ceph-chat-storage');
    const info=await fs.lstat(directory);
    if(!info.isDirectory()||info.isSymbolicLink()||info.mode&0o077||await fs.realpath(directory)!==expected)throw Error('UNSAFE_CEPH_DIRECTORY');
    const keys=path.join(directory,'credentials');
    const existing=await fs.lstat(keys).catch(error=>{if(error.code!=='ENOENT')throw error;});
    if(!existing){
        const name=project+'_ceph-chat-data';
        const volume=run('docker',['volume','ls','--filter','name='+name,'--format','{{.Name}}'],{cwd:root,env:environment,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:15000,maxBuffer:65536});
        if(volume.error||volume.signal||volume.status!==0||typeof volume.stdout!=='string')throw Error('UNVERIFIED_CEPH_VOLUME');
        const names=volume.stdout.split(/\r?\n/).map(value=>value.trim()).filter(Boolean);
        if(names.some(value=>!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value))||names.includes(name))throw Error('CEPH_KEYS_REQUIRE_RECOVERY');
        const candidate=await fs.mkdtemp(path.join(directory,'.credentials-'));
        try{
            for(const [name,value]of [['access-key',randomBytes(10).toString('hex')],['secret-key',randomBytes(32).toString('hex')]]){
                const file=await fs.open(path.join(candidate,name),'wx',0o600);
                try{await file.writeFile(value+'\n');await file.sync();}finally{await file.close();}
            }
            try{await fs.rename(candidate,keys);}catch(error){if(!['EEXIST','ENOTEMPTY'].includes(error.code))throw error;}
        }finally{await fs.rm(candidate,{recursive:true,force:true});}
    }
    const keyInfo=await fs.lstat(keys);
    if(!keyInfo.isDirectory()||keyInfo.isSymbolicLink()||keyInfo.mode&0o077)throw Error('UNSAFE_CEPH_KEYS');
    for(const name of ['access-key','secret-key']){
        const bytes=await privateSnapshotFile(path.join(keys,name),1024);
        if(!/^[A-Za-z0-9-]{16,128}\n?$/.test(bytes.toString('utf8')))throw Error('INVALID_CEPH_KEYS');
    }
    for(const directory of [keys,path.dirname(keys)]){const file=await fs.open(directory,'r');try{await file.sync();}finally{await file.close();}}
    return{access:path.join(keys,'access-key'),secret:path.join(keys,'secret-key')};
}

/** The local single-node Ceph is optional; outages never turn into a different storage identity. */
async function prepareLocalCeph(root,environment,dependencies) {
    const enabled=environment.CHAT_DEV_CEPH??'true';
    if(!['true','false'].includes(enabled))throw Error('CHAT_DEV_CEPH: используйте true или false.');
    if(enabled==='false'){
        dependencies.output?.warning('Локальный Ceph RGW отключён: приложение продолжит запуск без оригиналов вложений. Данные и ключи сохранены.');
        dependencies.output?.info('Файлы чата','Для внешнего Ceph настройте CHAT_S3_ENDPOINT, оба бакета и приватные файлы ключей.');
        return{};
    }
    const port=Number(environment.CHAT_DEV_S3_PORT||19011);
    if(!Number.isInteger(port)||port<1024||port>65535)throw Error('CHAT_DEV_S3_PORT: нужен порт от 1024 до 65535.');
    if(environment.CHAT_DEV_CEPH_IMAGE&&!/^[a-zA-Z0-9._:/-]+@sha256:[a-f0-9]{64}$/.test(environment.CHAT_DEV_CEPH_IMAGE))throw Error('CHAT_DEV_CEPH_IMAGE: нужен образ с закреплённым @sha256.');
    const run=dependencies.run||spawnSync,project='neurocenter-ceph-chat-'+createHash('sha256').update(path.resolve(root)).digest('hex').slice(0,10);
    const directory=path.join(root,'.run/ceph-chat-storage');
    let phase='ключи и исходное хранилище';
    try{
        const {access,secret}=await cephCredentials(root,directory,project,environment,run);
        phase='загрузка образа и запуск';
        const started=run('docker',['compose','--project-name',project,'-f',path.join(root,'compose.chat-storage.ceph.dev.yml'),'up','-d','--wait','--wait-timeout','90'],{
            cwd:root,env:{...environment,CHAT_DEV_S3_PORT:String(port),CHAT_DEV_S3_ACCESS_KEY_FILE:access,CHAT_DEV_S3_SECRET_KEY_FILE:secret},stdio:'inherit',timeout:120000});
        if(started.error||started.signal||started.status!==0)throw Error('CEPH_START_UNAVAILABLE');
        phase='доступ и приватность бакетов';
        const supplied={CHAT_S3_ENDPOINT:`http://127.0.0.1:${port}`,CHAT_S3_REGION:'us-east-1',CHAT_S3_ACCESS_KEY_FILE:access,CHAT_S3_SECRET_KEY_FILE:secret,
            CHAT_S3_PROJECT_BUCKET:'neurocenter-ceph-chat-projects',CHAT_S3_PERSONAL_BUCKET:'neurocenter-ceph-chat-personal'};
        await preflight(root,supplied,environment,dependencies);
        dependencies.output?.info('Ceph RGW','Локальное хранилище и закрытые бакеты готовы.');
        return supplied;
    }catch{
        dependencies.output?.warning(`Ceph RGW недоступен (${phase}): приложение продолжит запуск без оригиналов вложений. Данные и ключи сохранены.`);
        if(phase==='ключи и исходное хранилище')dependencies.output?.info('Ceph RGW','Проверьте приватные файлы ключей; потерянную пару существующего тома нужно восстановить из исходной копии.');
        dependencies.output?.info('Ceph RGW','После восстановления хранилища повторите scripts/dev.sh up; либо настройте внешний CHAT_S3_ENDPOINT, оба бакета и приватные файлы ключей.');
        return{};
    }
}

/** Keep S3 credentials in Catalog only; an external configuration never starts a local store. */
export async function prepareDevChatStorage(root, environment = process.env, dependencies = {}) {
    const supplied = Object.fromEntries(Object.entries(environment).filter(([name]) => name.startsWith('CHAT_S3_') && environment[name]));
    if (Object.keys(supplied).length) {
        for (const name of names.filter(name => name !== 'REGION')) {
            const key = 'CHAT_S3_' + name;
            if (!supplied[key] && !(['ACCESS_KEY', 'SECRET_KEY'].includes(name) && supplied[key + '_FILE'])) throw new Error('Заполните ' + key + ' для внешнего хранилища чата.');
            if (supplied[key] && supplied[key + '_FILE']) throw new Error('Задайте только ' + key + '_FILE, без ' + key);
        }
        for (const name of ['CHAT_S3_ACCESS_KEY_FILE', 'CHAT_S3_SECRET_KEY_FILE']) if (supplied[name]) supplied[name] = path.resolve(root, supplied[name]);
        await preflight(root, supplied, environment, dependencies);
        return supplied;
    }
    return prepareLocalCeph(root,environment,dependencies);
}
