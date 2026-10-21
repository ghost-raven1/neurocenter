import { Alert, Space, Tag, Typography } from 'antd';
import { defaultPackagingTitle } from './packagingTitle';
import { packagingPlatformLabels } from './platformLabels';
import type { RepositoryAdapter, RepositoryMetadata } from './types';
import { entrypointLabel } from './entrypointLabel';

const adapterLabels: Record<RepositoryAdapter, string> = {
    python: 'Python · автономный комплект', java: 'Java · встроенный runtime', dotnet: '.NET · встроенный runtime',
    go: 'Go · готовый бинарник', rust: 'Rust · готовый бинарник', native: 'Native · готовый бинарник',
};

/** Показывает только платформы проверенного рецепта, не обещая сборку для остальных ОС. */
export function RepositoryMetadataDetails({ metadata, entrypoint }: { metadata: RepositoryMetadata; entrypoint: string }) {
    const command = metadata.adapter === 'python' && entrypointLabel(metadata.entrypoint) !== metadata.entrypoint;
    return <div className="tool-packaging__source">
        <Typography.Text strong>{defaultPackagingTitle(metadata.name)}</Typography.Text>
        <Typography.Text type="secondary" title={metadata.commit}>Commit: {metadata.commit.slice(0, 12)}</Typography.Text>
        {metadata.release && <Typography.Text>Релиз {metadata.release.tag}{metadata.release.asset ? ` · ${metadata.release.asset}` : ''}</Typography.Text>}
        {metadata.preparedAdapter && <Typography.Text>Совместимая сборка OpenCodeRAG {metadata.preparedVersion} · плагин OpenCode</Typography.Text>}
        {metadata.adapter ? <>
            <Typography.Text>{adapterLabels[metadata.adapter]}</Typography.Text>
            <Typography.Text type="secondary">{command ? 'Команда запуска' : metadata.release ? 'Файл запуска' : 'Рецепт поставки'}: {command ? entrypointLabel(metadata.entrypoint) : metadata.entrypoint}</Typography.Text>
        </> : <Typography.Text type="secondary">{metadata.recommendedKind === 'skill' ? 'Инструкция скилла' : 'Файл запуска'}: {entrypoint || 'выберите ниже'}</Typography.Text>}
        {!!metadata.supportedTargets?.length && <>
            <Typography.Text type="secondary">Поддерживаемые платформы</Typography.Text>
            <Space wrap>{metadata.supportedTargets.map(target => <Tag key={target}>{packagingPlatformLabels[target] || target}</Tag>)}</Space>
        </>}
        {metadata.warnings?.map(warning => <Alert key={warning} type="warning" showIcon message={warning} />)}
    </div>;
}
