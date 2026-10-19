import { BadRequestException } from '@nestjs/common';
import { filePath } from '../publication/publication-validation';
import { TARGETS } from '../../../shared/runtime-artifacts.cjs';
import { isSourceEntrypoint } from '../../../shared/source-entrypoint.cjs';

const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const namePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** Рассматривается только корневой export и условия Node; types и произвольные подпути не являются запуском. */
function exportedEntries(value:unknown,depth=0):string[] {
    if(typeof value==='string')return [value];
    if(!value||typeof value!=='object'||depth>=4)return [];
    if(Array.isArray(value))return value.slice(0,16).flatMap(item=>exportedEntries(item,depth+1));
    const entries=value as Record<string,unknown>;
    if(entries['.']!==undefined)return exportedEntries(entries['.'],depth+1);
    return ['node','import','default','require'].flatMap(key=>exportedEntries(entries[key],depth+1));
}

function npmSpecifier(value: string): string {
    if (!value.startsWith('https://')) {return value;}
    let url: URL;
    try {url = new URL(value);} catch {throw new BadRequestException('Некорректная ссылка npm.');}
    if (!['www.npmjs.com', 'npmjs.com'].includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash || !url.pathname.startsWith('/package/')) {
        throw new BadRequestException('Поддерживаются только ссылки https://www.npmjs.com/package/имя без параметров и учётных данных.');
    }
    let packagePath: string;
    try {packagePath = decodeURIComponent(url.pathname.slice('/package/'.length).replace(/\/$/, ''));} catch {throw new BadRequestException('Некорректная ссылка npm.');}
    const version = packagePath.lastIndexOf('/v/');
    return version < 0 ? packagePath : packagePath.slice(0, version) + '@' + packagePath.slice(version + 3);
}

/** Registry фиксирован; пользователь не может превратить просмотр npm в запрос к внутреннему URL. */
export async function resolveNpmSource(specifier: unknown, suppliedEntrypoint?: string) {
    if (typeof specifier !== 'string' || specifier.length > 256) { throw new BadRequestException('Укажите npm-пакет или пакет@версия.'); }
    specifier = npmSpecifier(specifier);
    const normalized = specifier as string;
    const at = normalized.lastIndexOf('@');
    const name = at > 0 ? normalized.slice(0, at) : normalized;
    const requestedVersion = at > 0 ? normalized.slice(at + 1) : 'latest';
    if (!namePattern.test(name) || requestedVersion !== 'latest' && !semver.test(requestedVersion)) { throw new BadRequestException('Нужен npm-пакет и точная версия, без URL, Git, диапазонов и shell-команд.'); }
    let response: Response;
    try { response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(requestedVersion)}`, {redirect: 'error', signal: AbortSignal.timeout(20_000)}); }
    catch { throw new BadRequestException('npm-реестр недоступен. Повторите проверку пакета.'); }
    if (!response.ok) { throw new BadRequestException(`npm-пакет или версия не найдены (HTTP ${response.status}).`); }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = response.body?.getReader();
    if (!reader) {throw new BadRequestException('npm вернул пустое описание пакета.');}
    try {
        while (true) {
            const part = await reader.read();
            if (part.done) {break;}
            bytes += part.value.length;
            if (bytes > 2 * 1024 * 1024) {await reader.cancel().catch(() => undefined); throw new BadRequestException('Описание npm-пакета превышает допустимый размер.');}
            chunks.push(part.value);
        }
    } catch (error) {
        if (error instanceof BadRequestException) {throw error;}
        throw new BadRequestException('npm-реестр недоступен. Повторите проверку пакета.');
    } finally {reader.releaseLock();}
    const raw = Buffer.concat(chunks).toString('utf8');
    let metadata: Record<string, unknown>;
    try { metadata = JSON.parse(raw) as Record<string, unknown>; } catch { throw new BadRequestException('npm вернул некорректное описание пакета.'); }
    if (!metadata || typeof metadata !== 'object' || metadata.name !== name || typeof metadata.version !== 'string' || !semver.test(metadata.version) || requestedVersion !== 'latest' && metadata.version !== requestedVersion) { throw new BadRequestException('npm вернул другую версию пакета.'); }
    const prepared = name === 'opencode-rag-plugin' ? {version: '2.4.4', recommendedKind: 'mcp' as const, supportedTargets: TARGETS.filter(target => target !== 'darwin-x64')}
        : name === 'opencode-snip' ? {version: '2.0.0', recommendedKind: 'plugin' as const, supportedTargets: [...TARGETS]} : undefined;
    if (prepared && metadata.version !== prepared.version) { throw new BadRequestException(`Для ${name} подготовлен совместимый адаптер версии ${prepared.version}. Укажите ${name}@${prepared.version}.`); }
    const bin = typeof metadata.bin === 'string' ? [metadata.bin] : metadata.bin && typeof metadata.bin === 'object' ? Object.values(metadata.bin) : [];
    const candidates: string[] = [];
    for (const value of [...bin, metadata.main, metadata.module, ...exportedEntries(metadata.exports)]) {
        if (typeof value !== 'string') { continue; }
        try { const entry = filePath(value.replace(/^\.\//, '')); if (isSourceEntrypoint(entry) && !candidates.includes(entry)) { candidates.push(entry); } } catch { /* Непереносимый entrypoint не предлагается. */ }
    }
    const entrypoint = suppliedEntrypoint ? filePath(suppliedEntrypoint) : candidates[0] ?? (prepared ? 'entrypoint.mjs' : undefined);
    if (!isSourceEntrypoint(entrypoint)) { throw new BadRequestException('В npm не найден JS/TS-файл запуска. Укажите entrypoint опубликованного пакета, без деклараций типов.'); }
    return {package: name, version: metadata.version, specifier: `${name}@${metadata.version}`, entrypoint, candidates,
        description: typeof metadata.description === 'string' ? metadata.description.slice(0, 2000) : '',
        ...(prepared ? {recommendedKind: prepared.recommendedKind, supportedTargets: prepared.supportedTargets} : {})};
}
