import api from '../../core/api/base';
import type {LearningContext} from '../../../../services/shared/project-learning.cjs';
import type {IBridgeJob} from '../McpBridge/api';
export interface LearningMemoryRequest {kind:'sync-learning-memory';deviceId:string;projectId:string;requestKey:string;assetId:string;assetKind:'mcp';version:number;expectedManifest:string;expectedBindingId:string;expectedInstanceId:string;expectedLearningRevision:number;expectedLearningDigest:string;memoryMode:'sync'|'cleanup'}
/** Retry keeps an unacknowledged request intact; a known partial result is continued through a fresh explicit job. */
export const learningMemorySyncApi={
 context:(projectId:string,signal:AbortSignal)=>api.get<LearningContext>('/api/projects/'+encodeURIComponent(projectId)+'/learning/context',{signal}).then(value=>value.data),
 create:(input:LearningMemoryRequest)=>api.post<IBridgeJob>('/api/device-jobs',input,{timeout:10000}).then(value=>value.data),
};
