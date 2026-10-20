import { Alert, Space, Tag, Typography } from 'antd';
import { packagingPlatformLabels } from './platformLabels';
import type { NpmPackageMetadata } from './types';

/** Показывает совместимость готового npm-адаптера до отправки сборки. */
export function NpmMetadataDetails({ metadata }: { metadata: NpmPackageMetadata }) {
    const targets = metadata.supportedTargets ?? [];
    return <div className="tool-packaging__source">
        <Typography.Text strong>{metadata.specifier}</Typography.Text>
        {targets.length ? <>
            <Typography.Text>Готовый совместимый адаптер</Typography.Text>
            <Typography.Text type="secondary">Поддерживаемые платформы</Typography.Text>
            <Space wrap>{targets.map(target => <Tag key={target}>{packagingPlatformLabels[target] || target}</Tag>)}</Space>
            {targets.includes('darwin-arm64') && !targets.includes('darwin-x64') && <Typography.Text type="secondary">Mac с Intel не поддерживается этим комплектом.</Typography.Text>}
        </> : <Typography.Text type="secondary">Файл запуска: {metadata.entrypoint || 'выберите команду ниже'}</Typography.Text>}
        {metadata.warnings?.map(warning => <Alert key={warning} type="warning" showIcon message={warning} />)}
    </div>;
}
