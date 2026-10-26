import {Alert,Button,Space,Typography} from 'antd';
import {FeatureButton} from '../FeatureFlags/FeatureAvailability';
import {sourceAssetReady} from './archiveUpload';
import type {ISourceAsset} from './types';

/** Archive acceptance, common catalogue publication and project updates are separate steps. */
export function AssetArchiveStatus({assets,blocked,onCompleteSupply}:{assets:ISourceAsset[];blocked:boolean;onCompleteSupply:()=>void}) {
    const ready=assets.filter(sourceAssetReady).length;
    const incomplete=assets.length-ready;
    return <Alert type={incomplete?'warning':'success'} showIcon message="Опись архива проверена" description={
        <Space direction="vertical" className="asset-sources__content">
            <Typography.Text type="secondary">Из архива / без сетевой дозагрузки</Typography.Text>
            <Typography.Text>{`Файлы готовы: ${ready} из ${assets.length}.`}{incomplete>0&&` Не хватает файлов для ${incomplete} карточек.`}</Typography.Text>
            <Typography.Text>Загрузка архива не меняет версии общего каталога и проектов. Выберите готовые карточки ниже и добавьте или обновите их в общем каталоге.</Typography.Text>
            {incomplete>0&&<Typography.Text>Дополнительный архив должен содержать полную опись и описания ассетов, а также недостающие файлы всех заявленных платформ и зависимостей. Уже загруженные бинарные файлы повторять не нужно.</Typography.Text>}
            <Typography.Text type="secondary">Затем в каталоге выберите проект: «Закрепить новую версию» для инструментов или «Обновить шаблон» для агентов. Установка на компьютер — отдельный шаг.</Typography.Text>
            <Space wrap>
                {incomplete>0&&<FeatureButton features={['asset_sources']} disabled={blocked} onClick={onCompleteSupply}>Дополнить поставку архивом</FeatureButton>}
                <Button href="/store">Перейти в каталог</Button>
            </Space>
        </Space>
    }/>;
}
