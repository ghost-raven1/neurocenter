import { Alert, Collapse, List, Space, Tag, Typography } from 'antd';
import type { IInstallPlanPackage } from '../../../features/McpBridge/installPlanTypes';
import { invalidArtifactMetadata, packageRuntimeArtifacts, type IRuntimeArtifact } from '../../../features/McpBridge/runtimeArtifacts';
import { hasLocalConfiguration } from '../../../features/McpBridge/runtimeConfiguration';

const platformLabels: Record<IRuntimeArtifact['target'], string> = {
    'darwin-arm64': 'macOS · Apple Silicon',
    'darwin-x64': 'macOS · Intel',
    'linux-arm64-glibc': 'Linux · ARM64 · glibc',
    'linux-x64-glibc': 'Linux · x64 · glibc',
    'linux-arm64-musl': 'Linux · ARM64 · musl',
    'linux-x64-musl': 'Linux · x64 · musl',
    'win32-arm64': 'Windows · ARM64',
    'win32-x64': 'Windows · x64',
};

/** Администратор видит закреплённые платформенные файлы, входящие в одобрение комплекта. */
export function RuntimeArtifactsDetails({config, compact = false}: Pick<IInstallPlanPackage,'config'> & { compact?: boolean }) {
    const artifacts = packageRuntimeArtifacts({config});
    const files = <List size="small" dataSource={artifacts} rowKey={value => value.target} renderItem={value => <List.Item>
        <Space direction="vertical" size={2} className="install-plan__content">
            <Typography.Text strong>{platformLabels[value.target]}</Typography.Text>
            <Typography.Text type="secondary">{value.target} · архив: {value.compressedBytes.toLocaleString('ru-RU')} байт · после распаковки: {value.unpackedBytes.toLocaleString('ru-RU')} байт · файлов: {value.filesCount}</Typography.Text>
            <Typography.Text code className="install-plan__hash">SHA: {value.sha256}</Typography.Text>
            <Typography.Text type="secondary" className="install-plan__hash">Точка входа: {value.entrypoint}</Typography.Text>
        </Space>
    </List.Item>} />;
    return <>
        {invalidArtifactMetadata({config}) && <Alert type="warning" showIcon message="Некорректное описание готовых зависимостей. Попросите администратора обновить пакет." />}
        {artifacts.length > 0 && <div><Typography.Title level={5}>{compact ? 'Готовый комплект через мост' : 'Готовые зависимости'}</Typography.Title>
            <Typography.Paragraph type="secondary">Мост скачает совместимый комплект с площадки и проверит SHA. Установка зависимостей через npm или pip на компьютере не требуется.</Typography.Paragraph>
            {compact ? <>
                <Typography.Paragraph><Typography.Text strong>Поддерживаемые платформы</Typography.Text></Typography.Paragraph>
                <Space wrap>{artifacts.map(value => <Tag key={value.target}>{platformLabels[value.target]}</Tag>)}</Space>
                <Collapse ghost><Collapse.Panel key="files" header="Платформенные файлы и контрольные суммы">{files}</Collapse.Panel></Collapse>
            </> : files}
        </div>}
        {hasLocalConfiguration(config) && <Typography.Paragraph type="secondary">Для этого MCP предусмотрен локальный мастер настройки. Пользователь вводит персональные параметры на своём компьютере после установки.</Typography.Paragraph>}
    </>;
}
