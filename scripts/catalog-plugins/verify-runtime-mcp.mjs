import {RuntimeVerificationError} from './verify-runtime-process.mjs';
const object=value=>!!value&&typeof value==='object'&&!Array.isArray(value);
const supportedVersions=new Set(['2025-11-25','2025-06-18','2025-03-26','2024-11-05']);

/** A bounded JSON-RPC stdio reader owns exactly one request at a time and never invokes package tools. */
class VerificationSession {
    constructor(scope,profile,command,args) {
        this.scope=scope;this.child=scope.start(command,args,profile);this.pending=null;this.buffer=Buffer.alloc(0);this.sequence=0;
        this.child.stdout.on('data',chunk=>{
            try {
                this.buffer=Buffer.concat([this.buffer,chunk]);
                if(this.buffer.length>scope.maxOutputBytes)throw new RuntimeVerificationError('output-limit');
                let index;
                while((index=this.buffer.indexOf(10))!==-1) {
                    const line=this.buffer.subarray(0,index);this.buffer=this.buffer.subarray(index+1);
                    if(!line.toString('utf8').trim())continue;
                    const message=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line));
                    if(!object(message)||message.jsonrpc!=='2.0')throw new RuntimeVerificationError('mcp-invalid-protocol');
                    if(message.id===undefined){if(typeof message.method!=='string'||message.result!==undefined||message.error!==undefined)throw new RuntimeVerificationError('mcp-invalid-protocol');continue;}
                    if(message.method==='ping'&&(typeof message.id==='string'||Number.isSafeInteger(message.id))&&message.result===undefined&&message.error===undefined){void this.write({jsonrpc:'2.0',id:message.id,result:{}}).catch(error=>this.fail(error));continue;}
                    if(!this.pending||message.id!==this.pending.id||typeof message.method==='string'||Object.hasOwn(message,'result')===Object.hasOwn(message,'error'))throw new RuntimeVerificationError('mcp-invalid-protocol');
                    const pending=this.pending;this.pending=null;
                    if(message.error!==undefined)pending.reject(new RuntimeVerificationError(pending.method==='initialize'?'mcp-initialize-failed':'mcp-list-failed'));
                    else pending.resolve(message.result);
                }
            } catch(error) {this.fail(error instanceof RuntimeVerificationError?error:new RuntimeVerificationError('mcp-invalid-protocol'));}
        });
        this.child.once('close',()=>this.fail(this.child.failure??new RuntimeVerificationError('runtime-crashed')));
        this.child.once('error',()=>this.fail(this.child.failure??new RuntimeVerificationError('runtime-unavailable')));
    }
    fail(error){this.failure??=error;if(this.pending){this.pending.reject(this.failure);this.pending=null;}this.scope.stop(this.child);}
    async write(message){
        this.scope.remaining();if(this.failure)throw this.failure;
        if(!this.child.stdin.writable)throw new RuntimeVerificationError('runtime-crashed');
        await new Promise((resolve,reject)=>this.child.stdin.write(JSON.stringify(message)+'\n',error=>error?reject(new RuntimeVerificationError('runtime-crashed')):resolve()));
    }
    async request(method,params) {
        if(this.failure)throw this.failure;
        const id=++this.sequence;
        const response=new Promise((resolve,reject)=>{this.pending={id,method,resolve,reject};});
        // Install the rejection handler before writing, including a synchronous process failure.
        const received=this.scope.wait(response);
        try{await this.write({jsonrpc:'2.0',id,method,...(params?{params}:{})});return await received;}
        catch(error){this.fail(error);await received.catch(()=>{});throw error;}
    }
}
function initializeResponse(result) {
    if(!object(result)||!supportedVersions.has(result.protocolVersion)||!object(result.serverInfo)||typeof result.serverInfo.name!=='string'||!result.serverInfo.name.trim()
        ||typeof result.serverInfo.version!=='string'||!object(result.capabilities))throw new RuntimeVerificationError('mcp-invalid-protocol');
    if(!object(result.capabilities.tools))throw new RuntimeVerificationError('mcp-tools-unavailable');
}
function toolPage(result) {
    if(!object(result)||!Array.isArray(result.tools)||result.nextCursor!==undefined&&(typeof result.nextCursor!=='string'||!result.nextCursor||result.nextCursor.length>4096))throw new RuntimeVerificationError('mcp-list-failed');
    for(const tool of result.tools)if(!object(tool)||typeof tool.name!=='string'||!tool.name.trim()||tool.name.length>128||!object(tool.inputSchema)||tool.inputSchema.type!=='object'
        ||tool.description!==undefined&&typeof tool.description!=='string'||tool.outputSchema!==undefined&&(!object(tool.outputSchema)||tool.outputSchema.type!=='object'))throw new RuntimeVerificationError('mcp-list-failed');
    return result;
}

/** Only initialize, notifications/initialized, and tools/list are sent; no arbitrary MCP method is available. */
export async function verifyMcpRuntime(scope,profile,command,args,checks) {
    const session=new VerificationSession(scope,profile,command,args);
    try {
        initializeResponse(await session.request('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'neurocenter-package-verification',version:'1'}}));
        checks.initialize=true;await session.write({jsonrpc:'2.0',method:'notifications/initialized'});
        let cursor,tools=0;const cursors=new Set(),names=new Set();
        for(let page=0;;page++) {
            if(page>=10)throw new RuntimeVerificationError('mcp-list-limit');
            const response=toolPage(await session.request('tools/list',cursor?{cursor}:undefined));
            for(const tool of response.tools){if(names.has(tool.name))throw new RuntimeVerificationError('mcp-list-failed');names.add(tool.name);}
            tools+=response.tools.length;if(tools>1000)throw new RuntimeVerificationError('mcp-list-limit');
            cursor=response.nextCursor;if(!cursor)break;
            if(cursors.has(cursor))throw new RuntimeVerificationError('mcp-list-limit');cursors.add(cursor);
        }
        if(!tools)throw new RuntimeVerificationError('mcp-no-tools');
        await scope.wait(new Promise(resolve=>setTimeout(resolve,40)));
        if(session.child.verificationClosed||session.failure)throw session.child.failure??session.failure??new RuntimeVerificationError('runtime-crashed');
        checks.toolsList=true;return tools;
    } catch(error) {throw session.child.failure??session.failure??(error instanceof RuntimeVerificationError?error:new RuntimeVerificationError(checks.initialize?'mcp-list-failed':'mcp-initialize-failed'));}
    finally {scope.stop(session.child);}
}
