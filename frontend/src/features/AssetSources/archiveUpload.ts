import type {ISourceAsset} from './types';

// Browser feedback follows the shared server default; a configured server limit remains authoritative.
export const ASSET_ARCHIVE_MAX_BYTES=8*1024**3;
export const ASSET_ARCHIVE_ACCEPT='.zip,.tar,.tar.gz,.tgz';

/** The browser never unpacks an archive or buffers it as JSON/base64. */
export function assetArchiveError(file:File):string {
    if(!/\.(zip|tar|tar\.gz|tgz)$/i.test(file.name))return 'Выберите архив ZIP, TAR, TAR.GZ или TGZ.';
    if(!Number.isSafeInteger(file.size)||file.size<1)return 'Архив пуст. Выберите файл с описаниями компонентов поставки.';
    if(file.size>ASSET_ARCHIVE_MAX_BYTES)return 'Архив превышает 8 ГиБ. Разделите поставку или выберите меньший архив.';
    return '';
}

/** Missing exact dependencies also make the selected card unavailable for import. */
export const sourceAssetReady=(asset:ISourceAsset):boolean=>asset.supply?.ready!==false;

/** Сохраняет выбранные карточки, только пока их файлы и доступ остаются пригодны для импорта. */
export const availableSourceAssetIds=(assets:ISourceAsset[],ids:string[]):string[]=>ids.filter(id=>assets.some(asset=>asset.id===id&&sourceAssetReady(asset)&&!asset.imported?.archived&&!asset.imported?.unavailable));
