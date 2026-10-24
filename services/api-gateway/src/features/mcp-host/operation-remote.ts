import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

/** Exact catalogue endpoints preserve remote MCP without redirects, OAuth discovery or mutation retries. */
export function operationRemoteTransport(config:{url:string;headers:Record<string,string>}){
 const url=new URL(config.url),controller=new AbortController();let received=0,closing:Promise<void>|undefined;
 const transport=new StreamableHTTPClientTransport(url,{requestInit:{headers:config.headers,redirect:'error'},
  reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1,maxReconnectionDelay:1,reconnectionDelayGrowFactor:1},
  fetch:async(input,init)=>{
   if(new URL(input).href!==url.href)throw new Error('MCP изменил закреплённый адрес транспорта.');
   // Termination is best effort after local I/O closes; its own deadline cannot hold the caller's response open.
   const terminating=init?.method?.toUpperCase()==='DELETE';
   const signal=terminating?AbortSignal.timeout(750):AbortSignal.any([controller.signal,AbortSignal.timeout(30000),...(init?.signal?[init.signal]:[])]);
   const response=await fetch(input,{...init,redirect:'error',signal});
   const body=response.body?.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,target){
    received+=chunk.byteLength;if(received>8*1024*1024)throw new Error('MCP превысил предел транспорта.');target.enqueue(chunk);
   }}));
   return new Response(body??null,{status:response.status,statusText:response.statusText,headers:response.headers});
  }});
 const close=transport.close.bind(transport);
 transport.close=()=>{
  if(!closing)closing=Promise.resolve().then(async()=>{
   controller.abort();
   try{await close();}finally{try{await transport.terminateSession();}catch{/* Missing remote acknowledgement does not confirm remote cancellation. */}}
  });
  return closing;
 };
 return transport;
}
