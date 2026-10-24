import {useRef} from 'react';
import {createBridgeRequestKey} from '../McpBridge/bridgeRequestKey';
import {quirksImportApi} from './quirksImportApi';
import {useLearningBridgeIntent} from './useLearningBridgeIntent';
import type {LearningQuirksJobInput} from './quirksImportTypes';

/** Recovery reads the original request even when collection is disabled or the target has changed. */
export function useLearningQuirksImport(projectId:string,reload:()=>Promise<unknown>,canManage=true,enabled=true){
 const permission=useRef({canManage,enabled});permission.current={canManage,enabled};
 const action=useLearningBridgeIntent({projectId,kind:'import-learning-quirks',reload,
  canSend:()=>permission.current.canManage&&permission.current.enabled,
  create:input=>{if(input.kind!=='import-learning-quirks')throw new Error('Неверный исходный запрос.');const {requestKey,...body}=input;return quirksImportApi.create(body,requestKey);}});
 return {...action,submit:(input:LearningQuirksJobInput)=>action.send({...input,requestKey:createBridgeRequestKey()}),cancel:(id:string)=>action.cancel(id,permission.current.canManage)};
}
