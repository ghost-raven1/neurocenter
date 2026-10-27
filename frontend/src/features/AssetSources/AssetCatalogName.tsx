import {Typography} from 'antd';

/** Explain a changed source title without implying a rename of the installed connection. */
export function AssetCatalogName({sourceName,catalogName}:{sourceName:string;catalogName?:string}) {
    if(!catalogName||catalogName===sourceName)return null;
    return <div><Typography.Text type="secondary">В каталоге: «{catalogName}». Название сохраняется при обновлении.</Typography.Text></div>;
}
