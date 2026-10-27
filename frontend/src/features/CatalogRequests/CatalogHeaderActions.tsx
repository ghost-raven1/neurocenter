import { FeatureButton } from '../FeatureFlags/FeatureAvailability';
import {Button,Space} from 'antd';
import {CatalogRequestButton} from './CatalogRequestButton';
import type {IRequestAssetType,IRequestProject} from './types';
import './CatalogRequests.less';

interface IProps {section:string;projects:IRequestProject[];projectId?:string;assetType?:IRequestAssetType;isMain:boolean;onCreate:()=>void;onPackage:()=>void}
/** Opening retained builds is recovery; creation is gated inside the packaging form. */
export function CatalogHeaderActions({section,projects,projectId,assetType,isMain,onCreate,onPackage}:IProps):JSX.Element|null {
    if(section==='requests'||section==='agents')return null;
    const request=<CatalogRequestButton projects={projects} projectId={projectId} assetType={section==='models'?'model':assetType}/>;
    return isMain&&section==='tools'?<Space wrap><Button type="primary" onClick={onPackage}>Упаковать инструмент</Button>
        <details className="catalog-requests__more"><summary aria-label="Другие действия с каталогом инструментов">Другие действия</summary><Space direction="vertical" className="catalog-requests__more-content">
            <FeatureButton features={['tool_catalog']} onClick={onCreate}>Добавить вручную</FeatureButton>{request}
        </Space></details></Space>:request;
}
