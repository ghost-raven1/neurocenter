import fs from 'node:fs/promises';
import path from 'node:path';
import { hash } from '../src/bridge/state.js';
import type { Package } from '../src/bridge/package.js';
import { packageRef } from '../src/bridge/install-set.js';
import { projectBindingId } from '../src/bridge/workspace.js';
import { install } from '../src/bridge/installer.js';
import type { RuntimeProbeInput } from '../src/features/runtime-probe/model.js';
import { rehashPackage, setPackage } from './install-set-fixture.js';

export const noop = async () => {};
export function probePackage(kind = 'skill', content = '---\nname: runtime-check\ndescription: Проверка скилла\n---\nТекст скилла.'): Package {
    const pkg = setPackage('runtime-check', kind);
    pkg.files[0] = { ...pkg.files[0]!, content, size: Buffer.byteLength(content), sha256: hash(content) };
    return rehashPackage(pkg);
}
export async function fakeEngine(temporary: string): Promise<RuntimeProbeInput['openCode']> {
    const file = path.join(temporary, 'fake-engine');
    const content = `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('1.14.48');else process.exit(2);\n`;
    await fs.writeFile(file, content, { mode: 0o700 });
    return { path: file, sha256: hash(content), version: '1.14.48' };
}
export async function probeInput(pkg: Package, engine: RuntimeProbeInput['openCode']): Promise<RuntimeProbeInput> {
    await install('test-project', pkg, noop, noop);
    return { projectId: 'test-project', bindingId: await projectBindingId('test-project'), target: packageRef(pkg),
        frozenSet: { schemaVersion: 1, root: packageRef(pkg), packages: [pkg], manifest: pkg.manifest.sha256 },
        consentManifest: pkg.manifest.sha256, openCode: engine, authorize: noop };
}
export async function snapshot(root: string): Promise<Record<string, { hash: string; mtime: number }>> {
    const result: Record<string, { hash: string; mtime: number }> = {};
    const walk = async (directory: string): Promise<void> => {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) { await walk(file); }
            else if (entry.isFile()) { result[path.relative(root, file)] = { hash: hash(await fs.readFile(file)), mtime: (await fs.stat(file)).mtimeMs }; }
        }
    };
    await walk(root); return result;
}

/** Настоящий stdio MCP с контролем разрешённых методов и без внешних библиотек. */
export function mcpSource(log: string, extra = ''): string {
    return `import fs from 'node:fs'; import readline from 'node:readline';
${extra}
const lines=readline.createInterface({input:process.stdin});
lines.on('line',raw=>{
const request=JSON.parse(raw);fs.appendFileSync(${JSON.stringify(log)},request.method+'\\n');
if(request.id===undefined)return;
let result;
if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,serverInfo:{name:'Тестовый MCP',version:'1'},capabilities:{tools:{},resources:{},prompts:{}}};
else if(request.method==='tools/list')result={tools:[{name:'Секретное имя инструмента',description:'СЕКРЕТ_ИНСТРУМЕНТА',inputSchema:{type:'object'}}]};
else if(request.method==='resources/list')result={resources:[{name:'Секретный ресурс',uri:'test://secret'}]};
else if(request.method==='prompts/list')result={prompts:[{name:'Секретный промпт'}]};
else{process.exit(10);return;}
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');});`;
}
