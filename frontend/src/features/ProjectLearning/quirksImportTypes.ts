import type {IBridgeInstallation} from '../McpBridge/api';
export type {QuirksReceipt} from '../../../../services/shared/project-learning-quirks.cjs';
export interface LearningQuirksJobInput {kind:'import-learning-quirks';deviceId:string;projectId:string;assetId:string;assetKind:'mcp'|'plugin';version:number;expectedManifest:string;
    expectedBindingId:string;expectedInstanceId:string;expectedConfigurationRevisions:Array<{assetId:string;manifest:string;revision:string|null}>}
export type LearningQuirksInstallation=IBridgeInstallation&{learningQuirks?:{supported:true}};
