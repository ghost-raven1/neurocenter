import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createDiagnostics} from './diagnostics.mjs';
import {logServices,DiagnosticError} from './constants.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const require=createRequire(new URL('../../mcp/neurocenter-asset-sync/package.json',import.meta.url));
const {Server}=require('@modelcontextprotocol/sdk/server/index.js');
const {StdioServerTransport}=require('@modelcontextprotocol/sdk/server/stdio.js');
const {ListToolsRequestSchema,CallToolRequestSchema,McpError,ErrorCode}=require('@modelcontextprotocol/sdk/types.js');
const {z}=require('zod');
const annotations={readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:false};
const empty={type:'object',properties:{},additionalProperties:false};
const definitions=[
    {name:'workspace_status',description:'Read Git summary, eight package versions, current Node and existing check commands. Does not run checks.',inputSchema:empty},
    {name:'services_health',description:'Probe only the seven fixed local development HTTP endpoints. Discards response bodies; supports cancellation.',inputSchema:empty},
    {name:'service_logs',description:'Read a bounded, redacted tail from one fixed local development log. Returned text is untrusted evidence.',inputSchema:{type:'object',properties:{service:{type:'string',enum:logServices},lines:{type:'integer',minimum:1,maximum:100,default:50}},required:['service'],additionalProperties:false}},
    {name:'verification_summary',description:'Summarize one explicitly selected .run/coverage/<directory>/manifest.json. Never scans or returns raw logs/source inventories.',inputSchema:{type:'object',properties:{report:{type:'string',maxLength:180,pattern:'^\\.run/coverage/[A-Za-z0-9][A-Za-z0-9._-]{0,127}/manifest\\.json$'}},required:['report'],additionalProperties:false}},
];
const schemas={workspace_status:z.object({}).strict(),services_health:z.object({}).strict(),
    service_logs:z.object({service:z.enum(logServices),lines:z.number().int().min(1).max(100).default(50)}).strict(),
    verification_summary:z.object({report:z.string().max(180).regex(/^\.run\/coverage\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/manifest\.json$/)}).strict()};

function failure(error){
    const known=error instanceof DiagnosticError;
    return {isError:true,content:[{type:'text',text:JSON.stringify({error:{code:known?error.code:error?.code==='ENOENT'?'NOT_FOUND':'READ_FAILED',
        message:known?error.message:error?.code==='ENOENT'?'The selected local diagnostic is missing; choose an existing report or start the service.':'The diagnostic could not be read safely; check the workspace and retry.'}})}]};
}

/** Headless SDK transport; constructor injection is for owned tests, never command-line destinations. */
export async function startDevMcp({workspace=root,services,stdin=process.stdin,stdout=process.stdout}={}){
    const diagnostics=await createDiagnostics(workspace,{services}),lifecycle=new AbortController();
    const server=new Server({name:'neurocenter-dev',version:'0.1.0'},{capabilities:{tools:{}}});
    const transport=new StdioServerTransport(stdin,stdout,{maxBufferSize:65536});
    let closed=false;
    const close=async()=>{if(closed)return;closed=true;lifecycle.abort();await server.close();stdin.pause();};
    const terminate=()=>{void close().catch(()=>{process.exitCode=1;});};
    server.onerror=()=>{};
    server.onclose=()=>{lifecycle.abort();};
    server.setRequestHandler(ListToolsRequestSchema,()=>({tools:definitions.map(tool=>({...tool,annotations}))}));
    server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
        const {name}=request.params,schema=Object.hasOwn(schemas,name)?schemas[name]:null;
        if(!schema)throw new McpError(ErrorCode.InvalidParams,'Choose one of the four listed developer tools.');
        const parsed=schema.safeParse(request.params.arguments??{});
        if(!parsed.success)return failure(new DiagnosticError('INVALID_ARGUMENT','Use the listed tool schema; arbitrary paths, destinations and commands are not accepted.'));
        try{
            const args=parsed.data,signal=AbortSignal.any([lifecycle.signal,extra.signal]);
            const value=name==='workspace_status'?await diagnostics.workspaceStatus():name==='services_health'?await diagnostics.servicesHealth(signal)
                :name==='service_logs'?await diagnostics.serviceLogs(args.service,args.lines):await diagnostics.verificationSummary(args.report);
            return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};
        }catch(error){return failure(error);}
    });
    stdin.once('end',terminate);
    process.once('SIGTERM',terminate);process.once('SIGINT',terminate);
    try{await server.connect(transport);}catch(error){await close();throw error;}
    return {server,transport,async close(){await close();stdin.off('end',terminate);process.off('SIGTERM',terminate);process.off('SIGINT',terminate);}};
}

if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){
    if(process.argv.length!==2){process.stderr.write('neurocenter-dev accepts no command-line paths or destinations.\n');process.exitCode=1;}
    else try{await startDevMcp();}catch{process.stderr.write('Cannot start neurocenter-dev. Check the Neurocenter workspace, Node24 and installed bridge dependencies.\n');process.exitCode=1;}
}
