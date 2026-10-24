import {apiHub,readState,type Credentials} from '../../bridge/state.js';

/** This private lane has bounded reads and cancellation independent of the ordinary device-job drain. */
export async function roleMcpApi<T>(route:'claim'|'authorize'|'context'|'next'|'dispatch'|'result'|'complete',body:unknown,signal?:AbortSignal):Promise<T>{
 const credentials=await readState<Credentials>('credentials');if(!credentials)throw new Error('Подключение MCP отсутствует.');
 const response=await fetch(apiHub()+'/api/device-channel/system-role-mcp/'+route,{method:'POST',redirect:'error',
  headers:{'content-type':'application/json',authorization:'Bearer '+credentials.token},body:JSON.stringify(body??{}),
  signal:AbortSignal.any([AbortSignal.timeout(10000),...(signal?[signal]:[])])});
 if(!response.ok){await response.body?.cancel();throw Object.assign(new Error('Канал MCP не подтвердил доступ.'),{status:response.status});}
 const reader=response.body?.getReader();if(!reader)throw new Error('Канал MCP вернул пустой ответ.');const parts:Uint8Array[]=[];let bytes=0;
 try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>8*1024*1024){await reader.cancel();throw new Error('Канал MCP превысил предел ответа.');}parts.push(part.value);}}
 finally{reader.releaseLock();}
 return JSON.parse(Buffer.concat(parts).toString('utf8'))as T;
}
