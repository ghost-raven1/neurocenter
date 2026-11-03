import { CatalogSupplies } from './CatalogSupplies';
import { useCatalogSuppliesAccess } from '../../features/AssetSources/hooks/useCatalogSuppliesAccess';
import { Tabs } from 'antd';
import type { ReactNode } from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import { ModelCatalog, type IModelCatalogProps } from '../../features/ModelCatalog/ModelCatalog';
import { CatalogRequests } from '../../features/CatalogRequests/CatalogRequests';
import type { IRequestProject } from '../../features/CatalogRequests/interfaces';
import { AgentCatalog } from '../../features/AgentCatalog/AgentCatalog/AgentCatalog';
import type { useBridge } from '../../features/McpBridge/hooks/useBridge';
import { catalogSection, catalogSectionUrl, type TCatalogSection } from './catalogSection';

interface IProps extends IModelCatalogProps {
    tools: ReactNode;
    /** Вкладка «Обновления проектов»: передаётся только в общем каталоге при включённом флаге. */
    updates?: ReactNode;
    projects: IRequestProject[];
    scope: string;
    bridge: ReturnType<typeof useBridge>;
}

export function CatalogTabs({ tools, updates, projects, scope, bridge, ...models }: IProps): JSX.Element {
    const location = useLocation();
    const history = useHistory();
    const { integrated } = useCatalogSuppliesAccess();
    const section = catalogSection(location.search, models.embedded);
    return (
        <Tabs
            activeKey={section}
            destroyInactiveTabPane
            onChange={(key) =>
                history.replace(
                    catalogSectionUrl(
                        location.pathname,
                        location.search,
                        key as TCatalogSection,
                        models.embedded,
                        location.hash,
                    ),
                )
            }
            items={[
                { key: 'tools', label: 'Инструменты', children: tools },
                ...(updates && !models.embedded ? [{ key: 'updates', label: 'Обновления проектов', children: updates }] : []),
                ...(integrated || section === 'supplies'
                    ? [{ key: 'supplies', label: 'Поставки', children: <CatalogSupplies /> }]
                    : []),
                {
                    key: 'models',
                    label: 'Модели',
                    children: <ModelCatalog key={JSON.stringify([scope, models.projectId])} {...models} />,
                },
                {
                    key: 'agents',
                    label: 'Агенты',
                    children: (
                        <AgentCatalog key={JSON.stringify([scope, models.projectId])} {...models} bridge={bridge} />
                    ),
                },
                {
                    key: 'requests',
                    label: 'Заявки',
                    children: (
                        <CatalogRequests
                            key={JSON.stringify([scope, models.projectId])}
                            scope={scope}
                            projectId={models.projectId}
                            projects={projects}
                        />
                    ),
                },
            ]}
        />
    );
}
