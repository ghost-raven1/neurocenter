import { PROVIDER_ISSUE_EXPLANATIONS } from './constants';
import type { IGlobalProvider, TGlobalProvidersIssue } from '@neurocenter/opencode-local-providers';

/** Presence labels describe observed files and never claim a successful provider response. */
export function providerAuthenticationLabel(
    authentication: IGlobalProvider['authentication'],
    legacy: boolean,
): string {
    if (authentication === 'oauth') return legacy ? 'OAuth в прежнем файле' : 'OAuth сохранён';
    if (authentication === 'api') return legacy ? 'API-ключ в прежнем файле' : 'API-ключ настроен';
    if (authentication === 'none') return 'Без сохранённого ключа';
    if (authentication === 'reference') return 'Ключ из локальной ссылки';
    return 'Авторизация требует проверки';
}

/** A future or malformed issue cannot turn server text into a public error message. */
export function providerIssueExplanation(issue: TGlobalProvidersIssue): string {
    return Object.prototype.hasOwnProperty.call(PROVIDER_ISSUE_EXPLANATIONS, issue)
        ? PROVIDER_ISSUE_EXPLANATIONS[issue]
        : PROVIDER_ISSUE_EXPLANATIONS.unknown;
}

/** Version observation does not prove effective credentials in a different storage format. */
export function unsupportedProviderVersionExplanation(version: string): string {
    return /^2\./.test(version)
        ? 'OpenCode 2 хранит текущие ключи и OAuth в базе своего сервера. Здесь показаны только прежние глобальные файлы; они не подтверждают текущую авторизацию. Настройте провайдеров в OpenCode.'
        : 'Для этой версии доступно только чтение глобальных файлов прежнего формата. Текущая авторизация не подтверждена; настройте провайдеров в OpenCode.';
}
