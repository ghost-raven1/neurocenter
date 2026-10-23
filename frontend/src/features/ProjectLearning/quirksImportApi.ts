import api from '../../core/api/base';
import type {IBridgeJob} from '../McpBridge/api';
import type {LearningQuirksJobInput} from './quirksImportTypes';

/** Stable request identity allows recovering an accepted enqueue after a lost response. */
export const quirksImportApi={
    create:(input:LearningQuirksJobInput,requestKey:string):Promise<IBridgeJob>=>api.post<IBridgeJob>('/api/device-jobs',{...input,requestKey},{timeout:10000}).then(value=>value.data),
};
