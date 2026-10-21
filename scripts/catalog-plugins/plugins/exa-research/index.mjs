import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {fileURLToPath} from 'node:url';
import {realpathSync} from 'node:fs';

const names=['web_search_exa','web_fetch_exa'];
const upstream='https://mcp.exa.ai/mcp';

/** The bundled adapter exposes only Exa's read-only research tools through the managed Gateway host. */
export function exaResearchServer(client){
    const server=new Server({name:'neurocenter-exa-research',version:'1.0.0'},{capabilities:{tools:{listChanged:false}}});
    const list=async signal=>{
        const response=await client.listTools(undefined,{signal,timeout:15000});
        const tools=names.map(name=>response.tools.find(tool=>tool.name===name));
        if(tools.some(tool=>!tool||tool.annotations?.readOnlyHint!==true||tool.annotations?.destructiveHint!==false))throw Error('RESEARCH_TOOLS_UNAVAILABLE');
        return {tools};
    };
    server.setRequestHandler(ListToolsRequestSchema,(_request,extra)=>list(extra.signal));
    server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
        if(!names.includes(request.params.name))throw Error('RESEARCH_TOOL_NOT_ALLOWED');
        await list(extra.signal);
        const result=await client.callTool({name:request.params.name,arguments:request.params.arguments??{}},undefined,{signal:extra.signal,timeout:30000});
        if(Buffer.byteLength(JSON.stringify(result))>64*1024)throw Error('RESEARCH_OUTPUT_LIMIT');
        return result;
    });
    return server;
}

/** Streaming responses have a finite byte budget; redirects and upstream credentials are never accepted. */
export async function boundedExaFetch(url,options={}){
    const target=new URL(url);
    if(target.origin!=='https://mcp.exa.ai'||target.pathname!=='/mcp'||target.username||target.password)throw Error('RESEARCH_ENDPOINT_NOT_ALLOWED');
    const signal=AbortSignal.any([AbortSignal.timeout(35000),...(options.signal?[options.signal]:[])]);
    const response=await fetch(target,{...options,signal,redirect:'error'});
    if(!response.body)return response;
    let bytes=0;
    const body=response.body.pipeThrough(new TransformStream({transform(chunk,controller){bytes+=chunk.byteLength;if(bytes>512*1024)throw Error('RESEARCH_TRANSPORT_LIMIT');controller.enqueue(chunk);}}));
    return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
}

async function main(){
    const client=new Client({name:'neurocenter-exa-research',version:'1.0.0'},{capabilities:{}});
    const transport=new StreamableHTTPClientTransport(new URL(upstream),{fetch:boundedExaFetch});
    await client.connect(transport,{timeout:20000});
    const server=exaResearchServer(client);await server.connect(new StdioServerTransport());
    const stop=async()=>{await server.close().catch(()=>undefined);await client.close().catch(()=>undefined);};
    process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());process.stdin.once('end',()=>void stop());
}
if(process.argv[1]&&realpathSync(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Поисковый MCP недоступен. Проверьте соединение Gateway с Exa.');process.exitCode=1;});
