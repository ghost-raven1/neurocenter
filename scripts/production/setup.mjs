#!/usr/bin/env node
import {fileURLToPath} from 'node:url';
import {readFile,lstat} from 'node:fs/promises';
import path from 'node:path';
import {configureProduction,ensureMetricsToken} from './configuration.mjs';
import {composeClient,composeConfiguration,maintenanceLock} from './compose-client.mjs';
import {runCatalogSync} from './sync-catalog.mjs';
import {runModelBundleSync} from './sync-models.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const args=process.argv.slice(2);const mode=args[0]||'configure';
const dirIndex=args.indexOf('--directory');const directory=path.resolve(dirIndex<0?path.join(root,'deploy/production/local'):args[dirIndex+1]);
const projectIndex=args.indexOf('--project-name');const projectName=projectIndex<0?'neurocenter-production':args[projectIndex+1]||'';
const client=composeClient({directory,projectName});

/** Пароль читается без эха, секреты не принимаются через аргументы процесса. */
async function hidden(question) {
    process.stdout.write(question);if(!process.stdin.isTTY){throw new Error('Для автоматизации используйте --json-stdin');}
    return new Promise(resolve=>{let value='';process.stdin.setRawMode(true);process.stdin.resume();
        const onData=chunk=>{for(const char of chunk.toString()){
            if(char==='\u0003'){process.stdin.setRawMode(false);process.exit(130);}
            if(char==='\r'||char==='\n'){process.stdin.off('data',onData);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');resolve(value);return;}
            if(char==='\u007f'){value=value.slice(0,-1);}else if(char>=' '){value+=char;}
        }};process.stdin.on('data',onData);
    });
}

async function input() {
    if(args.includes('--json-stdin')){let data='';for await(const chunk of process.stdin){data+=chunk;if(data.length>65536){throw new Error('Слишком большой конфиг');}}return JSON.parse(data);}
    const {createInterface}=await import('node:readline/promises');
    const rl=createInterface({input:process.stdin,output:process.stdout});
    const result={};for(const [key,label] of [['panelUrl','Публичный URL (https://…)'],['ssoHost','Адрес Blitz (https://…)'],['ssoClientId','Client ID Blitz'],['adminEmail','Почта первого администратора'],['adminName','Имя администратора'],['release','Метка релиза'],['tlsCertFile','Файл сертификата TLS'],['tlsKeyFile','Файл ключа TLS']]){result[key]=await rl.question(label+': ');}
    rl.close();result.ssoClientSecret=await hidden('Client secret Blitz (ввод скрыт): ');return result;
}

async function compose(command) {
    await readFile(path.join(directory,'.env'),'utf8');
    return client.run(command,{inherit:true});
}

async function main() {
    if(mode==='configure'){await configureProduction(await input(),directory);console.log('Production-конфиг сохранён в приватном каталоге. Далее: setup.mjs check, build, seed, up с тем же --directory.');return;}
    if(!['check','build','seed','up','status'].includes(mode)){throw new Error('Команды: configure | check | build | seed | up | status; параметр --directory <каталог>');}
    if(mode==='check'){await compose(['config','--quiet']);console.log('Структура production-конфига корректна.');return;}
    if(mode==='build'){
        await readFile(path.join(directory,'.env'),'utf8');
        const {hydrateBridgeRuntimeRelease}=await import('../bridge-runtime-release.mjs');
        const bridge=await hydrateBridgeRuntimeRelease({directory:root});
        console.log(`Раздача моста ${bridge.version}: ${bridge.targets.join(', ')}; загружено пакетов: ${bridge.downloaded.length}.`);
        await compose(['build']);return;
    }
    if(mode==='status'){await compose(['ps']);return;}
    await ensureMetricsToken(directory);
    const config=await composeConfiguration(client);
    // Пути берутся из разобранного Compose: пробелы и апострофы не ломают проверку TLS.
    if(mode==='up'){
        for(const key of ['tls_cert','tls_key']){const filename=config.secrets[key]?.file;if(!filename||!(await lstat(filename)).isFile()){throw new Error('Не найден '+key);}}
    }
    await maintenanceLock(client,config.services['catalog-service'].image,mode,async()=>{
        await compose(['up','-d','--wait','postgres']);
        await compose(['--profile','setup','run','--rm','database-init']);
        if(mode==='seed'){await compose(['--profile','setup','run','--rm','bootstrap-admin']);}
        if(mode==='up'){
            await compose(['up','-d','--wait','capacity-collector']);
            await runCatalogSync(client);
            await runModelBundleSync(client);
            await compose(['up','-d','--wait']);
        }
    });
}
void main().catch(error=>{console.error(error instanceof Error?error.message:'Не удалось подготовить production');process.exitCode=1;});
