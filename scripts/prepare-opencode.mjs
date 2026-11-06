// Подготавливает платформенные пакеты на площадке: клиенту не нужен доступ к npm.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { opencodeVersion, opencodeVariants } from './opencode-platforms.mjs';

// This executable only prepares build inputs; installed services keep their own TLS policy.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const version = process.env.OPENCODE_VERSION || opencodeVersion;
const registry = (process.env.OPENCODE_REGISTRY || 'https://artifactory.dev.ppod.cbr.ru/artifactory/api/npm/ppod-npm-trusted/').replace(/\/$/, '');
const directory = fileURLToPath(new URL('../bridge-dist/opencode/', import.meta.url));
const variants = process.env.OPENCODE_TARGETS
    ? [
          ...new Set(
              process.env.OPENCODE_TARGETS.split(',')
                  .map((value) => value.trim())
                  .filter(Boolean),
          ),
      ]
    : opencodeVariants;
if (!variants.length || variants.some((variant) => !opencodeVariants.includes(variant))) {
    throw new Error('OPENCODE_TARGETS содержит неподдерживаемую платформу OpenCode.');
}
await mkdir(directory, { recursive: true });
for (const variant of variants) {
    const name = `opencode-${variant}`;
    const file = path.join(directory, `${name}-${version}.tgz`);
    try {
        const saved = await readFile(file);
        const hash = createHash('sha256').update(saved).digest('hex');
        const expected = (await readFile(`${file}.sha256`, 'utf8')).trim();
        if (hash === expected) {
            console.log(`${name}: готов`);
            continue;
        }
    } catch {}
    const metadata = await fetch(`${registry}/${name}/${version}`, { signal: AbortSignal.timeout(30_000) });
    if (!metadata.ok) {
        throw new Error(`Пакет ${name}@${version} недоступен: HTTP ${metadata.status}`);
    }
    const { dist } = await metadata.json();
    const response = await fetch(dist.tarball, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
        throw new Error(`Ошибка скачивания ${name}: HTTP ${response.status}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    // The trusted registry omits dist.integrity; its dist.shasum is a sha1 hex digest.
    const integrity =
        dist.integrity ??
        (typeof dist.shasum === 'string' && /^[a-f0-9]{40}$/i.test(dist.shasum)
            ? 'sha1-' + Buffer.from(dist.shasum, 'hex').toString('base64')
            : undefined);
    if (!integrity) {
        throw new Error(`Пакет ${name} не вернул контрольную сумму`);
    }
    const [algorithm, expected] = integrity.split('-');
    if (
        !['sha512', 'sha256', 'sha1'].includes(algorithm) ||
        createHash(algorithm).update(bytes).digest('base64') !== expected
    ) {
        throw new Error(`Не совпала контрольная сумма ${name}`);
    }
    await writeFile(`${file}.tmp`, bytes);
    await rename(`${file}.tmp`, file);
    await writeFile(`${file}.sha256`, createHash('sha256').update(bytes).digest('hex') + '\n');
    console.log(`${name}: ${(bytes.length / 1024 / 1024).toFixed(1)} МБ`);
}
console.log(`OpenCode ${version}: готовы ${variants.length} платформенных пакетов.`);
