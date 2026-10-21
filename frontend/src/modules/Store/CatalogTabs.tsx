import { Tabs } from 'antd';
import type { ReactNode } from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import { ModelCatalog, type IModelCatalogProps } from '../../features/ModelCatalog/ModelCatalog';
import { CatalogRequests } from '../../features/CatalogRequests/CatalogRequests';
import type { IRequestProject } from '../../features/CatalogRequests/types';
import { AgentCatalog } from '../../features/AgentCatalog/AgentCatalog';
import type { useBridge } from '../../features/McpBridge/useBridge';
import { catalogSection, catalogSectionUrl, type TCatalogSection } from './catalogSection';

interface IProps extends IModelCatalogProps { tools: ReactNode; projects: IRequestProject[]; scope: string; bridge: ReturnType<typeof useBridge>; }

export function CatalogTabs({ tools, projects, scope, bridge, ...models }: IProps): JSX.Element {
    const location = useLocation();
    const history = useHistory();
    return <Tabs activeKey={catalogSection(location.search, models.embedded)} destroyInactiveTabPane
        onChange={key => history.replace(catalogSectionUrl(location.pathname, location.search, key as TCatalogSection, models.embedded, location.hash))}
        items={[
            { key: 'tools', label: 'Инструменты', children: tools },
            { key: 'models', label: 'Модели', children: <ModelCatalog key={JSON.stringify([scope, models.projectId])} {...models} /> },
            { key: 'agents', label: 'Агенты', children: <AgentCatalog key={JSON.stringify([scope, models.projectId])} {...models} bridge={bridge} /> },
            { key: 'requests', label: 'Заявки', children: <CatalogRequests key={JSON.stringify([scope, models.projectId])} scope={scope} projectId={models.projectId} projects={projects} /> },
        ]} />;
}
