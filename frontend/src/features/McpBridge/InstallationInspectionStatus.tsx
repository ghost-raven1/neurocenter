import { Space, Tag, Typography } from 'antd';
import type { IBridgeInstallation, IInstallationInspection, TInspectionIssue } from './api';

const issueLabels: Record<TInspectionIssue, string> = {
    'inspection-busy': 'Проверку отложили: выполняется другое изменение.',
    'binding-changed': 'Привязка папки изменилась. Выберите исходную папку заново.',
    'receipt-missing': 'Локальная квитанция установки отсутствует.',
    'receipt-invalid': 'Локальная квитанция повреждена.',
    'receipt-mismatch': 'Квитанция не соответствует выбранной версии.',
    'ledger-missing': 'Локальный реестр установок отсутствует.',
    'ledger-invalid': 'Локальный реестр установок повреждён.',
    'ledger-mismatch': 'Реестр и квитанция установки расходятся.',
    'file-missing': 'Часть файлов отсутствует.',
    'file-modified': 'Файлы изменены после установки.',
    'file-unsafe': 'Файл нельзя безопасно прочитать.',
    'config-missing': 'Подключение OpenCode отсутствует.',
    'config-invalid': 'Конфигурация OpenCode повреждена.',
    'config-modified': 'Подключение OpenCode изменено вручную.',
    'config-ambiguous': 'Найдено несколько конфигураций с неоднозначным подключением.',
    'limit-exceeded': 'Проверка превышает допустимый объём. Нужна ручная проверка.',
    'read-failed': 'Файлы не удалось прочитать. Проверьте доступ к папке.',
    'snapshot-changed': 'Файлы менялись во время проверки. Повторите её после завершения изменений.',
    'inspection-failed': 'Проверка не завершена. Повторите её или проверьте файлы вручную.',
    'runtime-path-unverified': 'Путь к программе запуска не подтверждён.',
};

/** Старый отчёт другой версии или папки не становится подтверждением текущей установки. */
export function matchingInspection(item: IBridgeInstallation): IInstallationInspection | undefined {
    const result = item.inspection;
    if (!result || result.schemaVersion !== 1 || result.readiness !== 'unverified' || !['checked', 'busy'].includes(result.state)
        || !['synced', 'modified', 'missing', 'unknown'].includes(result.status) || !Array.isArray(result.issues)
        || result.issues.length > 20 || result.issues.some(code => !Object.prototype.hasOwnProperty.call(issueLabels, code))
        || result.projectId !== item.projectId || result.bindingId !== item.bindingId || result.assetId !== item.assetId
        || result.assetKind !== item.assetKind || result.version !== item.version || result.manifest !== item.manifest
        || !Number.isFinite(Date.parse(result.checkedAt))) { return undefined; }
    return result;
}

/** Сверка файлов не сообщает об успешном запуске MCP, плагина или OpenCode. */
export function InstallationInspectionStatus({item,showRuntimeHint = true}: {item: IBridgeInstallation;showRuntimeHint?:boolean}) {
    const result = matchingInspection(item);
    const label = !result ? 'Файлы ещё не сверены' : result.state === 'busy' ? 'Проверка отложена'
        : result.status === 'synced' ? 'Файлы сверены' : result.status === 'modified' ? 'Есть изменения в установке'
        : result.status === 'missing' ? 'Часть установки отсутствует' : 'Проверка не дала полного результата';
    const color = !result ? undefined : result.state === 'busy' ? 'gold' : result.status === 'synced' ? 'blue'
        : result.status === 'modified' ? 'orange' : result.status === 'missing' ? 'red' : undefined;
    return <Space direction="vertical" size={2}>
        <Tag color={color}>{label}</Tag>
        {result && <Typography.Text type="secondary">Проверка: {new Date(result.checkedAt).toLocaleString('ru-RU')}</Typography.Text>}
        {result && [...new Set(result.issues)].map(code => <Typography.Text key={code} type="secondary">{issueLabels[code]}</Typography.Text>)}
        {showRuntimeHint && <Typography.Text type="secondary">Запуск в OpenCode не проверен</Typography.Text>}
    </Space>;
}
