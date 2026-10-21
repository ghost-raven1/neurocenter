import { FeatureButton } from '../FeatureFlags/FeatureAvailability';
import {Space} from 'antd';
import {CatalogRequestButton} from './CatalogRequestButton';
import type {IRequestAssetType,IRequestProject} from './types';

interface IProps {section:string;projects:IRequestProject[];projectId?:string;assetType?:IRequestAssetType;isMain:boolean;onCreate:()=>void;onPackage:()=>void}
export function CatalogHeaderActions({section,projects,projectId,assetType,isMain,onCreate,onPackage}:IProps):JSX.Element|null {
    if(section==='requests'||section==='agents')return null;
    return <Space wrap>{isMain&&section==='tools'&&<><FeatureButton features={['tool_catalog']} onClick={onCreate}>Добавить вручную</FeatureButton><FeatureButton features={['tool_builds']} type="primary" onClick={onPackage}>Упаковать инструмент</FeatureButton></>}<CatalogRequestButton projects={projects} projectId={projectId} assetType={section==='models'?'model':assetType}/></Space>;
}
