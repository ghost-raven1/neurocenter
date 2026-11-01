import { Space, Typography } from 'antd';
import { PageHeading } from '../../../common/components/PageHeading';
import type { IAssetSourcesHeadingProps } from './interfaces';
/** Source publication remains global even when the catalog is opened from a project. */
export function AssetSourcesHeading({ embedded, actions }: IAssetSourcesHeadingProps): JSX.Element {
    const description = 'Поставки публикуются в общий каталог. Добавление и установка в проект выполняются отдельно.';
    return embedded ? (
        <Space direction="vertical" className="asset-sources__heading">
            <Typography.Paragraph>{description}</Typography.Paragraph>
            <Space wrap>{actions}</Space>
        </Space>
    ) : (
        <PageHeading title="Поставка" description={description} actions={actions} />
    );
}
