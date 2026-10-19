// Подготавливает платформенные пакеты на площадке: клиенту не нужен доступ к npm.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const version = process.env.OPENCODE_VERSION || '1.14.48';
const registry = (process.env.OPENCODE_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '');
const directory = fileURLToPath(new URL('../bridge-dist/opencode/', import.meta.url));
const variants = ['darwin-arm64','darwin-x64-baseline','linux-arm64','linux-arm64-musl','linux-x64-baseline','linux-x64-baseline-musl','windows-x64-baseline','windows-arm64'];
await mkdir(directory, { recursive:true });
for (const variant of variants) {
    const name = `opencode-${variant}`;
    const file = path.join(directory, `${name}-${version}.tgz`);
    try {
        const saved = await readFile(file);
        const hash = createHash('sha256').update(saved).digest('hex');
        const expected = (await readFile(`${file}.sha256`,'utf8')).trim();
        if (hash === expected) { console.log(`${name}: готов`); continue; }
    } catch {}
    const metadata = await fetch(`${registry}/${name}/${version}`, { signal:AbortSignal.timeout(30_000) });
    if (!metadata.ok) { throw new Error(`Пакет ${name}@${version} недоступен: HTTP ${metadata.status}`); }
    const { dist } = await metadata.json();
    const response = await fetch(dist.tarball, { signal:AbortSignal.timeout(120_000) });
    if (!response.ok) { throw new Error(`Ошибка скачивания ${name}: HTTP ${response.status}`); }
    const bytes = Buffer.from(await response.arrayBuffer());
    const [algorithm, expected] = dist.integrity.split('-');
    if (!['sha512','sha256'].includes(algorithm) || createHash(algorithm).update(bytes).digest('base64') !== expected) {
        throw new Error(`Не совпала контрольная сумма ${name}`);
    }
    await writeFile(`${file}.tmp`, bytes);
    await rename(`${file}.tmp`,file);
    await writeFile(`${file}.sha256`,createHash('sha256').update(bytes).digest('hex')+'\n');
    console.log(`${name}: ${(bytes.length/1024/1024).toFixed(1)} МБ`);
}
