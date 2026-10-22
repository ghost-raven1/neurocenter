import type {useBridge} from '../McpBridge/useBridge';
import {useModelCatalog} from '../ModelCatalog/useModelCatalog';
import {ProviderSetupModal} from './ProviderSetupModal';

/** Lazy project entry preserves the agent editor's separate, revision-checked apply action. */
export function ProjectProviderSetup({projectId, projectName, bridge, canManage, canPrepareConnector, onClose}: {
    projectId: string; projectName?: string; bridge: ReturnType<typeof useBridge>; canManage: boolean; canPrepareConnector?: boolean; onClose(): void;
}): JSX.Element {
    const {catalog, loading, error, refresh} = useModelCatalog(projectId);
    return <ProviderSetupModal projectId={projectId} projectName={projectName} bridge={bridge} canManage={canManage} canPrepareConnector={canPrepareConnector}
        models={catalog?.items.filter(model => catalog.assignedModelIds.includes(model.id)) ?? []} catalogReady={!!catalog && !loading && !error}
        catalogError={error} onReloadModels={() => {void refresh();}} onClose={onClose} onConfigured={onClose} />;
}
