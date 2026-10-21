import {Button,Space} from 'antd';
import {CatalogRequestButton} from './CatalogRequestButton';
import type {IRequestAssetType,IRequestProject} from './types';

interface IProps {section:string;projects:IRequestProject[];projectId?:string;assetType?:IRequestAssetType;isMain:boolean;onCreate:()=>void;onPackage:()=>void}
export function CatalogHeaderActions({section,projects,projectId,assetType,isMain,onCreate,onPackage}:IProps):JSX.Element|null {
    if(section==='requests'||section==='agents')return null;
    return <Space wrap>{isMain&&section==='tools'&&<><Button onClick={onCreate}>Добавить вручную</Button><Button type="primary" onClick={onPackage}>Упаковать инструмент</Button></>}<CatalogRequestButton projects={projects} projectId={projectId} assetType={section==='models'?'model':assetType}/></Space>;
}
