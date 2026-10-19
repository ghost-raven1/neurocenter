import { Tabs } from 'antd';
import type { ReactNode } from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import { ModelCatalog, type IModelCatalogProps } from '../../features/ModelCatalog/ModelCatalog';
import { catalogSection, catalogSectionUrl, type TCatalogSection } from './catalogSection';

interface IProps extends IModelCatalogProps { tools: ReactNode; scope: string; }

export function CatalogTabs({ tools, scope, ...models }: IProps): JSX.Element {
    const location = useLocation();
    const history = useHistory();
    return <Tabs activeKey={catalogSection(location.search, models.embedded)} destroyInactiveTabPane
        onChange={key => history.replace(catalogSectionUrl(location.pathname, location.search, key as TCatalogSection, models.embedded, location.hash))}
        items={[
            { key: 'tools', label: 'Инструменты', children: tools },
            { key: 'models', label: 'Модели', children: <ModelCatalog key={JSON.stringify([scope, models.projectId])} {...models} /> },
        ]} />;
}
