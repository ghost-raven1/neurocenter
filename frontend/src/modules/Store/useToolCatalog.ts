import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import bffApi from '../../core/api/bff';
import { fromPlugin, fromSkill } from '../../features/Catalog/catalogCards';
import { useAuthRequestOwner } from '../../features/UserBlock/useAuthRequestOwner';
import { loadCompletePluginCatalog } from './loadCompletePluginCatalog';
import { createToolCatalogController, initialToolCatalogState } from './toolCatalogController';

/** Недоступный сервис скиллов не удерживает готовый каталог MCP и плагинов. */
export function useToolCatalog() {
    const { scope, captureOwner } = useAuthRequestOwner();
    const [snapshot, setSnapshot] = useState({ scope: '', state: initialToolCatalogState() });
    const controller = useMemo(() => createToolCatalogController({
        captureOwner,
        read: async (source, current) => {
            if (source === 'skills') return (await bffApi.listSkills({})).map(fromSkill);
            const plugins = await loadCompletePluginCatalog(bffApi.listAiPlugins, current);
            return plugins === null ? null : plugins.map(fromPlugin);
        },
        onChange: state => setSnapshot({ scope, state }),
    }), [scope, captureOwner]);
    useLayoutEffect(() => { controller.activate(); return () => controller.dispose(); }, [controller]);
    useEffect(() => { void controller.refresh(); }, [controller]);
    const sources = snapshot.scope === scope ? snapshot.state : initialToolCatalogState();
    const apps = useMemo(() => [...sources.plugins.apps, ...sources.skills.apps], [sources]);
    return { sources, apps, refresh: controller.refresh };
}
