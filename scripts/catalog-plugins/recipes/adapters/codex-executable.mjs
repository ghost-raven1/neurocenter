import {readFileSync,lstatSync,realpathSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const triples={darwin:{arm64:'aarch64-apple-darwin',x64:'x86_64-apple-darwin'},linux:{arm64:'aarch64-unknown-linux-musl',x64:'x86_64-unknown-linux-musl'},win32:{arm64:'aarch64-pc-windows-msvc',x64:'x86_64-pc-windows-msvc'}};
/** Run the packaged native app-server; OpenCode's embedded Bun is never mistaken for Node. */
export function codexExecutable(){
    const triple=triples[process.platform]?.[process.arch];
    if(!triple)throw new Error('Эта платформа не поддерживается коннектором Codex.');
    const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const directory=path.join(root,'node_modules','@openai',`codex-${process.platform}-${process.arch}`);
    const metadata=JSON.parse(readFileSync(path.join(directory,'package.json'),'utf8'));
    if(metadata.version!==`0.159.3-${process.platform}-${process.arch}`)throw new Error('Версия локального Codex не совпадает с поставкой. Обновите коннектор.');
    const command=path.join(directory,'vendor',triple,'bin',process.platform==='win32'?'codex.exe':'codex');
    const stat=lstatSync(command),relative=path.relative(realpathSync(root),realpathSync(command));
    if(!stat.isFile()||stat.isSymbolicLink()||relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Исполняемый файл Codex отсутствует в проверенной поставке.');
    return {command,args:[]};
}
