import { createHash } from 'node:crypto';
import { BadGatewayException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { normalizeDependencyPins, type IDependencyPin } from '../../../shared/dependency-pins.cjs';
import { parseSkillFile } from './frontmatter';

export interface ISkillDependencyReservation {
    key: string;
    path: string;
    dependencies: IDependencyPin[];
    purpose?: 'publish' | 'preserve';
}
export type TReserveSkillDependencies = (entries: ISkillDependencyReservation[]) => Promise<void>;

/** Ключ относится ко всему неизменяемому тексту, включая тело и ресурсы скилла. */
export function dependencyReservation(
    skillPath: string,
    raw: string,
    purpose: 'publish' | 'preserve' = 'publish',
): ISkillDependencyReservation | undefined {
    const { meta } = parseSkillFile(raw);
    if (!meta) {
        throw new Error('Не удалось проверить зависимости: повреждён frontmatter скилла.');
    }
    const dependencies = normalizeDependencyPins(meta.dependencies);
    return dependencies.length
        ? {
              key: createHash('sha256').update(raw).digest('hex'),
              path: skillPath,
              dependencies,
              ...(purpose === 'preserve' ? { purpose } : {}),
          }
        : undefined;
}

/** Весь набор проверяется до первого запроса; все части фиксируются до первой записи на диск. */
export async function reserveSkillDependencies(entries: ISkillDependencyReservation[]): Promise<void> {
    if (!entries.length) {
        return;
    }
    const normalized = entries.map((entry) => {
        if (
            !entry ||
            !/^[a-f0-9]{64}$/.test(entry.key) ||
            typeof entry.path !== 'string' ||
            !entry.path.split('/').every((part) => /^[a-z0-9][a-z0-9_-]*$/.test(part)) ||
            (entry.purpose !== undefined && !['publish', 'preserve'].includes(entry.purpose))
        ) {
            throw new Error('Повреждён пакет резервирования зависимостей скиллов.');
        }
        return {
            key: entry.key,
            path: entry.path,
            dependencies: normalizeDependencyPins(entry.dependencies),
            ...(entry.purpose !== undefined ? { purpose: entry.purpose } : {}),
        };
    });
    const token = process.env.NEUROCENTER_INTERNAL_TOKEN;
    if (!token) {
        throw new ServiceUnavailableException(
            'Проверка зависимостей недоступна: не настроен внутренний доступ к каталогу.',
        );
    }
    let endpoint: URL;
    try {
        const base = new URL(process.env.CATALOG_SERVICE_URL || 'http://127.0.0.1:4100');
        if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
            throw new Error('Некорректный адрес.');
        }
        endpoint = new URL('/internal/skill-dependencies/reserve', base);
    } catch {
        throw new ServiceUnavailableException('Некорректно настроен внутренний адрес каталога.');
    }
    for (let offset = 0; offset < normalized.length; offset += 200) {
        const chunk = normalized.slice(offset, offset + 200);
        await reserveChunk(endpoint, token, chunk);
    }
}

async function reserveChunk(endpoint: URL, token: string, entries: ISkillDependencyReservation[]): Promise<void> {
    let response: Response;
    try {
        response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-neurocenter-internal': token },
            body: JSON.stringify({ entries }),
            signal: AbortSignal.timeout(5000),
            redirect: 'error',
        });
    } catch {
        throw new ServiceUnavailableException(
            'Каталог недоступен. Зависимости скилла не проверены; публикация остановлена.',
        );
    }
    let result: unknown;
    try {
        result = await response.json();
    } catch {
        if (response.status === 409) {
            throw new ConflictException('Зависимость скилла недоступна или её версия изменилась.');
        }
        throw new BadGatewayException('Каталог вернул некорректный ответ проверки зависимостей.');
    }
    const record = result && typeof result === 'object' ? (result as Record<string, unknown>) : {};
    if (response.status === 409) {
        throw new ConflictException(
            typeof record.message === 'string'
                ? record.message
                : 'Зависимость скилла недоступна или её версия изменилась.',
        );
    }
    if (!response.ok) {
        throw new ServiceUnavailableException('Каталог отклонил проверку зависимостей; публикация остановлена.');
    }
    if (record.ok !== true || record.reserved !== entries.length) {
        throw new BadGatewayException('Каталог не подтвердил резервирование зависимостей.');
    }
}
