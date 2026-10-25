import api from '../../core/api/base';
import type { RoleMcpTarget, RoleMcpTool } from '../SystemRoles/types';

export interface RoleMcpSources {
    assignments: Array<{ assetId: string; assetKind?: 'mcp' | 'plugin'; name: string; version: number; manifest: string; server: { available: boolean; reason?: string };
        devices: Array<{ deviceId: string; name: string; available: boolean; reason?: string; bindingId: string; instanceId: string; configurationRevisions: Array<{ assetId: string; manifest: string; revision: string | null }> }> }>;
    limits: { targets: number; selectedTools: number; calls: number }; enabled: boolean;
}
export interface RoleMcpDiscovery { id: string; state: 'pending' | 'ready' | 'failed'; target: RoleMcpTarget; tools: RoleMcpTool[]; message: string; }
const base = '/api/system-role-mcp';
/** Discovery lists actual server/device tools; the caller never supplies a manual schema. */
export const roleMcpApi = {
    sources: (projectId?: string): Promise<RoleMcpSources> => api.get<RoleMcpSources>(base, { params: { projectId } }).then(value => value.data),
    discover: (projectId: string | undefined, target: RoleMcpTarget, requestId: string): Promise<RoleMcpDiscovery> => api.post<RoleMcpDiscovery>(base + '/discover', { projectId: projectId ?? null, target, requestId }).then(value => value.data),
    read: (id: string): Promise<RoleMcpDiscovery> => api.get<RoleMcpDiscovery>(base + '/discoveries/' + encodeURIComponent(id)).then(value => value.data),
};

/** Scope keys include runtime/configuration pins, independently from display names. */
export function mcpTargetKey(target: RoleMcpTarget): string {
    return JSON.stringify([target.runtime, target.assetId, target.assetKind ?? 'mcp', target.version, target.manifest, ...(target.runtime === 'device' ? [target.deviceId, target.bindingId, target.instanceId,
        target.configurationRevisions.map(item => [item.assetId, item.manifest, item.revision]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))] : [])]);
}
