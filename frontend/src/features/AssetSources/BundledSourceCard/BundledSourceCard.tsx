import { Button, Card, Space, Tag, Typography } from 'antd';
import { FeatureButton } from '../../FeatureFlags/FeatureAvailability';
import { sourcePlanPreparation } from '../sourcePlanPreparation';
import type { IBundledSourceCardProps } from './interfaces';
/** Source and published edition are shown separately; neither claims a project or computer installation. */
export function BundledSourceCard({
    plan: value,
    blocked,
    locked,
    onPrepare,
    onImportArchive,
}: IBundledSourceCardProps): JSX.Element {
    const preparation = sourcePlanPreparation(value);
    return (
        <Card size="small" title={value.name} className="asset-sources__card">
            <div className="asset-sources__card-content">
                <Space wrap>
                    <Tag>
                        {value.kind === 'mcp'
                            ? 'MCP'
                            : value.kind === 'plugin'
                              ? 'Плагин'
                              : value.kind === 'model'
                                ? 'Модель'
                                : 'Мост компьютера'}
                    </Tag>
                    <Typography.Text type="secondary" title={value.sourceRevision}>
                        {value.sourceRevision === 'application'
                            ? 'Из исходников приложения'
                            : 'Исходники ' + value.sourceRevision.replace(/^(git-[a-f0-9]{8})[a-f0-9]{32}$/, '$1')}
                    </Typography.Text>
                </Space>
                <Typography.Paragraph>{value.description}</Typography.Paragraph>
                {value.imported && (
                    <Typography.Text type="secondary">
                        В каталоге: редакция {value.imported.version} · {value.imported.originVersion}
                    </Typography.Text>
                )}
            </div>
            <div className="asset-sources__bundled-action">
                {value.catalogReady && value.imported ? (
                    <>
                        <Typography.Text>Пакет этой версии опубликован в каталоге</Typography.Text>
                        <Button href={'/store?' + new URLSearchParams({ q: value.imported.name || value.name })}>
                            Открыть в каталоге
                        </Button>
                    </>
                ) : preparation ? (
                    <FeatureButton
                        features={['asset_sources', 'tool_builds', 'tool_catalog', 'tool_build_validation']}
                        disabled={blocked || locked || !preparation.available}
                        onClick={() => onPrepare(value)}
                    >
                        {preparation.label}
                    </FeatureButton>
                ) : value.kind === 'model' ? (
                    <>
                        <Typography.Text type="secondary">
                            Веса добавляются выбранным GGUF или локальным архивом.
                        </Typography.Text>
                        <Button href="/store?tab=models">Открыть модели</Button>
                    </>
                ) : value.kind === 'bridge' ? (
                    <Typography.Text type="secondary">
                        Архив моста создаётся из текущей версии приложения.
                    </Typography.Text>
                ) : (
                    <>
                        <Typography.Text type="secondary">
                            Для этой версии нужен выбранный локальный архив.
                        </Typography.Text>
                        <FeatureButton
                            features={['asset_sources']}
                            disabled={blocked}
                            onClick={() => {
                                onImportArchive();
                            }}
                        >
                            Импортировать архив
                        </FeatureButton>
                    </>
                )}
            </div>
        </Card>
    );
}
