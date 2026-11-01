import type { IBridgeInstallation } from '../McpBridge/api';
export type { IQuirksReceipt as QuirksReceipt } from '../../../../services/shared/project-learning-quirks.cjs';
export interface ILearningQuirksJobInput {
    kind: 'import-learning-quirks';
    deviceId: string;
    projectId: string;
    assetId: string;
    assetKind: 'mcp' | 'plugin';
    version: number;
    expectedManifest: string;
    expectedBindingId: string;
    expectedInstanceId: string;
    expectedConfigurationRevisions: Array<{ assetId: string; manifest: string; revision: string | null }>;
}
export type TLearningQuirksInstallation = IBridgeInstallation & { learningQuirks?: { supported: true } };
