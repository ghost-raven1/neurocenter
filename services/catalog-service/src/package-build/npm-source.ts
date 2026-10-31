import { BadRequestException } from '@nestjs/common';
import { filePath } from '../publication/publication-validation';
import { TARGETS } from '../../../shared/runtime-artifacts.cjs';
import { isSourceEntrypoint } from '../../../shared/source-entrypoint.cjs';
import { packageEntrypoints } from '../../../shared/source-candidates.cjs';
import { RAG_PLUGIN_SOURCE } from '../../../shared/opencode-rag-source.cjs';
import { fetchNpmMetadata } from './npm-source-transport';

const semver = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const namePattern = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

function npmSpecifier(value: string): string {
    if (!value.startsWith('https://')) {
        return value;
    }
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new BadRequestException('Некорректная ссылка npm.');
    }
    if (
        !['www.npmjs.com', 'npmjs.com'].includes(url.hostname) ||
        url.port ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !url.pathname.startsWith('/package/')
    ) {
        throw new BadRequestException(
            'Поддерживаются только ссылки https://www.npmjs.com/package/имя без параметров и учётных данных.',
        );
    }
    let packagePath: string;
    try {
        packagePath = decodeURIComponent(url.pathname.slice('/package/'.length).replace(/\/$/, ''));
    } catch {
        throw new BadRequestException('Некорректная ссылка npm.');
    }
    const version = packagePath.lastIndexOf('/v/');
    return version < 0 ? packagePath : packagePath.slice(0, version) + '@' + packagePath.slice(version + 3);
}

/** Registry фиксирован; пользователь не может превратить просмотр npm в запрос к внутреннему URL. */
export async function resolveNpmSource(specifier: unknown, suppliedEntrypoint?: string) {
    if (typeof specifier !== 'string' || specifier.length > 256) {
        throw new BadRequestException('Укажите npm-пакет или пакет@версия.');
    }
    specifier = npmSpecifier(specifier);
    const normalized = specifier as string;
    const at = normalized.lastIndexOf('@');
    const name = at > 0 ? normalized.slice(0, at) : normalized;
    const requestedVersion = at > 0 ? normalized.slice(at + 1) : 'latest';
    if (!namePattern.test(name) || (requestedVersion !== 'latest' && !semver.test(requestedVersion))) {
        throw new BadRequestException('Нужен npm-пакет и точная версия, без URL, Git, диапазонов и shell-команд.');
    }
    let response: Response;
    try {
        response = await fetchNpmMetadata(
            `https://registry.npmjs.org/${encodeURIComponent(name)}/${encodeURIComponent(requestedVersion)}`,
            { redirect: 'error', signal: AbortSignal.timeout(20_000) },
        );
    } catch {
        throw new BadRequestException('npm-реестр недоступен. Повторите проверку пакета.');
    }
    if (!response.ok) {
        throw new BadRequestException(`npm-пакет или версия не найдены (HTTP ${response.status}).`);
    }
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = response.body?.getReader();
    if (!reader) {
        throw new BadRequestException('npm вернул пустое описание пакета.');
    }
    try {
        while (true) {
            const part = await reader.read();
            if (part.done) {
                break;
            }
            bytes += part.value.length;
            if (bytes > 2 * 1024 * 1024) {
                await reader.cancel().catch(() => undefined);
                throw new BadRequestException('Описание npm-пакета превышает допустимый размер.');
            }
            chunks.push(part.value);
        }
    } catch (error) {
        if (error instanceof BadRequestException) {
            throw error;
        }
        throw new BadRequestException('npm-реестр недоступен. Повторите проверку пакета.');
    } finally {
        reader.releaseLock();
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    let metadata: Record<string, unknown>;
    try {
        metadata = JSON.parse(raw) as Record<string, unknown>;
    } catch {
        throw new BadRequestException('npm вернул некорректное описание пакета.');
    }
    if (
        !metadata ||
        typeof metadata !== 'object' ||
        metadata.name !== name ||
        typeof metadata.version !== 'string' ||
        !semver.test(metadata.version) ||
        (requestedVersion !== 'latest' && metadata.version !== requestedVersion)
    ) {
        throw new BadRequestException('npm вернул другую версию пакета.');
    }
    const prepared =
        name === 'opencode-rag-plugin'
            ? {
                  version: RAG_PLUGIN_SOURCE.version,
                  recommendedKind: 'mcp' as const,
                  supportedTargets: [...RAG_PLUGIN_SOURCE.supportedTargets],
              }
            : name === 'opencode-snip'
              ? { version: '2.0.0', recommendedKind: 'plugin' as const, supportedTargets: [...TARGETS] }
              : undefined;
    if (prepared && metadata.version !== prepared.version) {
        throw new BadRequestException(
            `Для ${name} подготовлен совместимый адаптер версии ${prepared.version}. Укажите ${name}@${prepared.version}.`,
        );
    }
    const detected = packageEntrypoints(metadata);
    const candidates = prepared ? ['entrypoint.mjs'] : detected.candidates;
    if (
        suppliedEntrypoint &&
        (!isSourceEntrypoint(suppliedEntrypoint) || !candidates.includes(filePath(suppliedEntrypoint)))
    ) {
        throw new BadRequestException(
            'Выберите опубликованный исполняемый файл из списка пакета, без деклараций типов.',
        );
    }
    const entrypoint = suppliedEntrypoint
        ? filePath(suppliedEntrypoint)
        : candidates.length === 1
          ? candidates[0]
          : prepared
            ? 'entrypoint.mjs'
            : '';
    if (!candidates.length && !prepared)
        throw new BadRequestException('В npm не найден исполняемый файл запуска. Выберите пакет инструмента.');
    const runnableKinds = prepared ? [prepared.recommendedKind] : detected.runnableKinds;
    return {
        package: name,
        version: metadata.version,
        specifier: `${name}@${metadata.version}`,
        entrypoint,
        candidates,
        runnableKinds,
        requiresEntrypointChoice: candidates.length > 1 && !suppliedEntrypoint,
        warnings: runnableKinds.length
            ? []
            : [
                  'Пакет выглядит как библиотека: в нём нет команды запуска MCP или объявления плагина OpenCode. Выберите пакет инструмента.',
              ],
        description: typeof metadata.description === 'string' ? metadata.description.slice(0, 2000) : '',
        ...(prepared
            ? { recommendedKind: prepared.recommendedKind, supportedTargets: prepared.supportedTargets }
            : detected.recommendedKind
              ? { recommendedKind: detected.recommendedKind }
              : {}),
    };
}
