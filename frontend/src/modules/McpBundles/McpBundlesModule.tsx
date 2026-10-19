import type { ReactNode } from 'react';

import ProtectedRoute from '../../common/components/ProtectedRoute';
import { baseRoutes } from '../../core/baseRoutes';
import { ModuleBase } from '../../core/modules/base';
import { MCP_BUNDLES_ROUTE } from '../../features/UserBlock/permissions';

import McpBundles from './McpBundles';

/**
 * Функциональный модуль «Bандлы MCP/плагинов»: просмотр/редактирование файлов,
 * версии и откат. Доступ — по routePermissions (admin).
 */
export default class McpBundlesModule extends ModuleBase {
    public constructor() {
        super('mcp-bundles', 'MCP-бандлы', baseRoutes.mcpBundles);
    }

    /**
     * Роуты модуля.
     *
     * @returns список элементов роутов.
     */
    public getRoute(): ReactNode[] {
        return [
            <ProtectedRoute key="mcp-bundles" name={MCP_BUNDLES_ROUTE} path={baseRoutes.mcpBundles} render={() => <McpBundles />} />,
        ];
    }
}
