import { CATCH_ALL_PATH, CATCH_ALL_ROW, matchPolicy } from './route-policy';

/**
 * AD-19 (entry 10): shadowing-диагностика. Таблица entry 8 (route-policy.ts) читается
 * только для диагностики, не модифицируется.
 *
 * Явный роут из таблицы (kind 'route', не default-строка catch-all) не обязан доходить
 * до catch-all-прокси `api/{*path}`: если запрос на него туда попал — routing-инцидент
 * (AD-14). Server-лог — actionable (route + pattern + expected controller), клиенту —
 * фиксированный body без internal-деталей (AD-19).
 */
const EXPECTED_CONTROLLERS: Record<string, string> = {
    '/ready': 'AppController.ready',
    '/ready/dependencies': 'AppController.dependencies',
    '/health': 'AppController.health',
    '/bridge/config': 'BridgeController.configuration',
    '/bridge/install.sh': 'BridgeController.installScript',
    '/bridge/connect.sh': 'BridgeController.connectScript',
    '/bridge/connect.ps1': 'BridgeController.connectWindowsScript',
    '/bridge/install_opencode.sh': 'BridgeController.installOpenCodeScript',
    '/bridge/install.ps1': 'BridgeController.installWindowsBridge',
    '/bridge/install_opencode.ps1': 'BridgeController.installOpenCodeWindows',
    '/bridge/install_workspace.sh': 'BridgeController.installWorkspace',
    '/bridge/install_workspace.ps1': 'BridgeController.installWorkspaceWindows',
    '/bridge/opencode/:file': 'BridgeController.openCodeArtifact',
    '/bridge/runtime/:file': 'BridgeController.runtime',
    '/internal/bridge/opencode-cli-supply/:target': 'OpenCodeCliSupplyController.current',
    '/mcp-host/connect': 'McpHostController.connect',
    '/mcp-host/m/:ticket': 'McpHostController.channel',
    '/internal/research-mcp/list': 'ResearchMcpController.list',
    '/internal/research-mcp/call': 'ResearchMcpController.call',
    '/internal/system-role-mcp/execute': 'SystemRoleMcpGatewayController.execute',
    '/internal/system-role-mcp/close': 'SystemRoleMcpGatewayController.close',
    '/internal/events': 'LiveController.publish',
    // postCreate: регистрируются после bootstrap, до catch-all не доходят (middleware/Swagger).
    '/docs': 'SwaggerModule (postCreate)',
    '/socket.io': 'socket.io (postCreate)',
};

/**
 * Проверяет, что запрос, дошедший до catch-all, по таблице entry 8 является явным роутом.
 *
 * @returns expected controller (и пишет actionable log) либо undefined — инцидента нет.
 */
export function shadowingIncident(method: string, path: string): string | undefined {
    const row = matchPolicy(method, path);
    if (row.kind !== 'route' || row === CATCH_ALL_ROW) return undefined;
    const expected = EXPECTED_CONTROLLERS[row.path] ?? `нет записи для ${row.path}`;
    console.error(
        `[api-gateway] shadowing: route=${String(method || 'GET').toUpperCase()} ${path} pattern=${CATCH_ALL_PATH} expected=${expected}`,
    );
    return expected;
}
