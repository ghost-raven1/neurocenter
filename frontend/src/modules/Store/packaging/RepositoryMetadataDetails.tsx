import { Space, Tag, Typography } from 'antd';
import { defaultPackagingTitle } from './packagingTitle';
import { packagingPlatformLabels } from './platformLabels';
import type { RepositoryAdapter, RepositoryMetadata } from './types';

const adapterLabels: Record<RepositoryAdapter, string> = {
    python: 'Python · автономный комплект', java: 'Java · встроенный runtime', dotnet: '.NET · встроенный runtime',
    go: 'Go · готовый бинарник', rust: 'Rust · готовый бинарник', native: 'Native · готовый бинарник',
};

/** Показывает только платформы проверенного рецепта, не обещая сборку для остальных ОС. */
export function RepositoryMetadataDetails({ metadata, entrypoint }: { metadata: RepositoryMetadata; entrypoint: string }) {
    return <div className="tool-packaging__source">
        <Typography.Text strong>{defaultPackagingTitle(metadata.name)}</Typography.Text>
        <Typography.Text type="secondary" title={metadata.commit}>Commit: {metadata.commit.slice(0, 12)}</Typography.Text>
        {metadata.adapter ? <>
            <Typography.Text>{adapterLabels[metadata.adapter]}</Typography.Text>
            <Typography.Text type="secondary">Рецепт поставки: {metadata.entrypoint}</Typography.Text>
            {!!metadata.supportedTargets?.length && <>
                <Typography.Text type="secondary">Поддерживаемые платформы</Typography.Text>
                <Space wrap>{metadata.supportedTargets.map(target => <Tag key={target}>{packagingPlatformLabels[target] || target}</Tag>)}</Space>
            </>}
        </> : <Typography.Text type="secondary">Файл запуска: {entrypoint || 'выберите ниже'}</Typography.Text>}
    </div>;
}
