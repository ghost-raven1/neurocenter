import { Space, Tag, Typography } from 'antd';
import type { IBridgeInstallation } from './api';
import { matchingRuntime, runtimeFileBlocker } from './operationHelpers';
import type { IRuntimeProbe } from './operationTypes';

const codeLabels: Record<IRuntimeProbe['code'], string> = {
    verified: 'Ограниченная проверка выполнена.', 'not-approved':'Точная версия больше не одобрена.', 'invalid-package':'Пакет не прошёл проверку.',
    'installation-not-current':'Установка изменилась; повторите сверку файлов.', 'inspection-busy':'Дождитесь завершения другой локальной операции.',
    'authorization-denied':'Доступ отозван. Обновите подключение и права.', 'runtime-unavailable':'Проверочный движок OpenCode недоступен.',
    'runtime-mismatch':'Проверочный движок не соответствует ожидаемой версии.', 'unsupported-platform':'Диагностика недоступна на этой платформе.',
    'managed-configuration':'Подключение OpenCode требует проверки.', 'dependency-required':'Для запуска не хватает зависимостей.',
    'configuration-required':'Нужно настроить переменные окружения или доступ к сервису.', 'invalid-skill':'Структура скилла не прошла проверку.',
    'entrypoint-unsupported':'Этот способ запуска пока не поддерживается.', 'external-command-unsupported':'Внешняя команда не поддерживается ограниченной диагностикой.',
    'unsafe-environment':'Окружение запуска не прошло проверку.', 'mcp-connect-failed':'Не удалось подключиться к MCP.',
    'mcp-list-failed':'MCP подключён, но список возможностей получить не удалось.', 'plugin-initialization-failed':'Плагин не удалось инициализировать.',
    timeout:'Время диагностики истекло.', 'output-limit':'Диагностика превысила лимит вывода.', 'probe-failed':'Диагностика не завершена. Повторите проверку.',
    'configuration-changed':'Локальные параметры изменились. Проверьте готовность настройки и подтвердите новую диагностику.',
};
/** Успех относится к ограниченной диагностике точного набора, а не к вызову всех инструментов. */
export function RuntimeProbeStatus({item}: {item:IBridgeInstallation}) {
    const result = matchingRuntime(item);
    if (!result) { return <Typography.Text type="secondary">Запуск в OpenCode не проверен</Typography.Text>; }
    const stale = result.status === 'stale' || !!runtimeFileBlocker(item);
    const labels: Record<IRuntimeProbe['status'],string> = {not_checked:'Запуск ещё не проверен',passed:'Диагностика OpenCode пройдена',needs_configuration:'Нужна настройка запуска',
        failed:'Диагностика запуска не пройдена',unsupported:'Диагностика не поддерживается',stale:'Диагностика запуска устарела',busy:'Диагностика отложена'};
    const status = stale ? 'stale' : result.status;
    return <Space direction="vertical" size={2}>
        <Tag color={status === 'passed' ? 'green' : status === 'failed' ? 'red' : 'gold'}>{labels[status]}</Tag>
        <Typography.Text type="secondary">Запуск: {new Date(result.checkedAt).toLocaleString('ru-RU')}</Typography.Text>
        <Typography.Text type="secondary">{stale ? 'Файлы или установка изменились. Выполните сверку и новую диагностику.' : codeLabels[result.code]}</Typography.Text>
        {status === 'passed' && <Typography.Text type="secondary">Скиллы: {result.counts.skills} · MCP: {result.counts.mcp} · инструменты: {result.counts.tools} · ресурсы: {result.counts.resources} · промпты: {result.counts.prompts} · плагины: {result.counts.pluginsInitialized}. Вызовы инструментов и ответы модели не проверялись.</Typography.Text>}
    </Space>;
}
