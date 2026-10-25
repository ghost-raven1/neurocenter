import {vi} from 'vitest';

interface ControlRequest {
    origin:string;
    path:string;
    method:string;
    authenticated:boolean;
    validClaim:boolean;
    redirectsRejected:boolean;
}

/** Accept only the v2 idle claim; a tool payload must never pass this network boundary. */
function validIdleClaim(body:RequestInit['body']):boolean{
    if(typeof body!=='string')return false;
    try{
        const value=JSON.parse(body);
        return !!value&&typeof value==='object'&&!Array.isArray(value)
            &&Object.keys(value).sort().join(',')==='recoveryOnly,requestId'
            &&typeof value.requestId==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.requestId)
            &&typeof value.recoveryOnly==='boolean';
    }catch{return false;}
}

/** Keep the independent MCP poller real; only its idle claim is allowed, never model/provider traffic. */
export function idleSystemRoleMcpLane(apiOrigin:string,deviceToken:string){
    const origin=new URL(apiOrigin).origin,path='/api/device-channel/system-role-mcp/claim';
    const claims:ControlRequest[]=[],unexpected:ControlRequest[]=[];
    const network=vi.fn(async(input:Parameters<typeof fetch>[0],options?:RequestInit)=>{
        const address=input instanceof Request?input.url:String(input),url=URL.canParse(address)?new URL(address):undefined;
        const headers=new Headers(options?.headers??(input instanceof Request?input.headers:undefined));
        const request:ControlRequest={origin:url?.origin??'invalid-url',path:url?.pathname??'',method:options?.method??'GET',
            authenticated:headers.get('authorization')==='Bearer '+deviceToken,validClaim:validIdleClaim(options?.body),
            redirectsRejected:options?.redirect==='error'};
        if(!url||url.origin!==origin||url.pathname!==path||url.search||url.hash||request.method!=='POST'
            ||!request.authenticated||!request.validClaim||!request.redirectsRejected){
            unexpected.push(request);
            throw new Error('Request crossed the worker fixture control-lane boundary.');
        }
        claims.push(request);return Response.json(null);
    });
    return {network,claims,unexpected};
}
