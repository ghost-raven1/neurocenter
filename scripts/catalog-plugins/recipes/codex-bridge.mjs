import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {download,installDependencies,TARGETS} from './upstream.mjs';
import pin from '../../../services/shared/codex-connector-pin.json' with {type:'json'};

const require=createRequire(new URL('../../../services/catalog-service/package.json',import.meta.url));
export const CODEX_REVISION=`${pin.version}-auth.pack.1`;
export const CODEX_CONNECTOR=Object.freeze({schemaVersion:1,sourceCommit:pin.sourceCommit,version:pin.version,sdkVersion:pin.sdkVersion,authOnly:true});
export const CODEX_DEPENDENCIES=Object.freeze({'@openai/codex':pin.sdkVersion,zod:'3.25.76'});
const triples={darwin:{arm64:'aarch64-apple-darwin',x64:'x86_64-apple-darwin'},linux:{arm64:'aarch64-unknown-linux-musl',x64:'x86_64-unknown-linux-musl'},win32:{arm64:'aarch64-pc-windows-msvc',x64:'x86_64-pc-windows-msvc'}};
const replaceOnce=(source,before,after)=>{if(source.split(before).length!==2)throw new Error('Изменился закреплённый исходник Codex. Обновите адаптер.');return source.replace(before,after);};

/** Package only official authentication/model transport; delegation, voice and global installers are excluded. */
export async function prepareCodexBridge({target,directory},{downloadFile=download,install=installDependencies}={}){
    const platform=TARGETS[target];if(!platform)throw new Error('Неизвестная платформа: '+target);
    await fs.mkdir(path.join(directory,'upstream'),{recursive:true});
    const compiler=require('esbuild');
    for(const [name,sha256]of Object.entries(pin.files)){
        const filename=await downloadFile(`https://raw.githubusercontent.com/ghost-raven1/opencode_codex_bridge/${pin.sourceCommit}/packages/bridge/src/${name}`,sha256);
        let source=await fs.readFile(filename,'utf8');
        if(name==='executable.ts')continue;
        if(name==='auth-session.ts'){
            source=replaceOnce(source,'async function loadSession(refreshToken: boolean): Promise<CodexSession> {\n  const connection = new CodexConnection();','export async function loadSession(refreshToken: boolean, options?: { env?: NodeJS.ProcessEnv }): Promise<CodexSession> {\n  const connection = new CodexConnection(undefined, [], options?.env);');
            source=replaceOnce(source,'    do {','    const seen = new Set<string>(); let pages = 0;\n    do {\n      if (++pages > 20 || cursor && seen.has(cursor)) throw new Error("Codex model pagination did not finish");\n      if (cursor) seen.add(cursor);');
            source=source.replaceAll('Run npm run connect:codex -- --login; access credentials are never logged.','Open the provider settings in Neurocenter to sign in.').replaceAll('reconnect with npm run connect:codex','open the provider settings in Neurocenter');
        }
        if(name==='auth-provider.ts')source=replaceOnce(source,'const session = await readSession(attempt === 1);','const session = await readSession(attempt === 1, request.signal);');
        if(name==='connection.ts'){
            source=replaceOnce(source,'constructor(command?: string, args: string[] = []) {','constructor(command?: string, args: string[] = [], environment?: NodeJS.ProcessEnv) {');
            source=replaceOnce(source,'stdio: "pipe", windowsHide: true,','stdio: "pipe", windowsHide: true, ...(environment ? { env: environment } : {}),');
        }
        const compiled=await compiler.transform(source,{sourcefile:name,loader:'ts',target:'es2022',format:'esm',legalComments:'eof'});
        await fs.writeFile(path.join(directory,'upstream',name.replace(/\.ts$/,'.js')),compiled.code);
    }
    await fs.copyFile(fileURLToPath(new URL('../locks/codex-bridge.json',import.meta.url)),path.join(directory,'package-lock.json'));
    await install(directory,CODEX_DEPENDENCIES,target);
    for(const name of ['codex-plugin.mjs','codex-setup.mjs'])await fs.copyFile(fileURLToPath(new URL('./adapters/'+name,import.meta.url)),path.join(directory,name));
    await fs.copyFile(fileURLToPath(new URL('./adapters/codex-executable.mjs',import.meta.url)),path.join(directory,'upstream/executable.js'));
    const executable=`node_modules/@openai/codex-${platform.os}-${platform.cpu}/vendor/${triples[platform.os][platform.cpu]}/bin/${platform.os==='win32'?'codex.exe':'codex'}`;
    const metadata=JSON.parse(await fs.readFile(path.join(directory,`node_modules/@openai/codex-${platform.os}-${platform.cpu}/package.json`),'utf8'));
    if(metadata.version!==`${pin.sdkVersion}-${platform.os}-${platform.cpu}`||(await fs.lstat(path.join(directory,executable))).size===0)throw new Error('Не найден закреплённый Codex для выбранной платформы.');
    await fs.chmod(path.join(directory,executable),0o755);
    return {entrypoint:'codex-plugin.mjs',kind:'plugin',mode:'plugin',executables:[executable],config:{entrypoint:'codex-plugin.mjs',extra:{codexConnector:CODEX_CONNECTOR}},
        upstream:{repository:pin.repository,commit:pin.sourceCommit,version:pin.version,files:pin.files,sdk:{package:'@openai/codex',version:pin.sdkVersion},compatibilityPatches:[{id:'neurocenter-auth-only',version:1}]},
        limitations:['Настройте провайдера выбранного проекта через интерфейс Нейроцентра.','Учётные данные хранятся только в локальном Codex; вход ChatGPT и API-ключи моделей настраиваются отдельно.']};
}
