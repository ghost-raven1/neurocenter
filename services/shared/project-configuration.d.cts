export const PROJECT_CONFIGURATION_JOB: 'open-project-configuration';
export const PROJECT_CONFIGURATION_CAPABILITY: 'project-configuration-v1';
export interface IProjectConfigurationRagRef {
    kind: 'mcp' | 'plugin';
    id: string;
    version: number;
    manifest: string;
}
export interface IProjectConfigurationSession {
    schemaVersion: 1;
    deviceId: string;
    projectId: string;
    bindingId: string;
    instanceId: string;
    sessionId: string;
    expiresAt: string;
    ragInstallations: IProjectConfigurationRagRef[];
}
export interface IProjectConfigurationOpened extends IProjectConfigurationSession {
    opened: true;
}
export function normalizeProjectConfigurationSession(value: unknown): IProjectConfigurationSession;
export function normalizeProjectConfigurationReport(
    value: unknown,
    session: unknown,
    failed?: boolean,
): IProjectConfigurationOpened | Record<string, never>;
