/** Публичная часть локальной настройки: значений и секретов здесь нет. */
export interface IMcpConfigurationTuple {
    schemaVersion: 1; projectId: string; bindingId: string; instanceId: string;
    assetId: string; assetKind: 'mcp'; version: number; manifest: string; schemaDigest: string;
}
export interface IMcpConfigurationPreparation extends IMcpConfigurationTuple {
    preparationId: string; expiresAt: string;
}
export interface IMcpConfigurationOpened extends IMcpConfigurationPreparation { opened: true; }
export interface IMcpConfigurationStatus extends IMcpConfigurationTuple {
    ready: boolean; missingFieldIds: string[]; revision: string | null; checkedAt: string;
}
export interface IMcpConfigurationRevision { assetId: string; manifest: string; revision: string | null; }
