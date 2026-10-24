import {vi} from 'vitest';

interface ControlRequest {
    origin:string;
    path:string;
    method:string;
    authenticated:boolean;
    emptyClaim:boolean;
    redirectsRejected:boolean;
}

/** Keep the independent MCP poller real; only its idle claim is allowed, never model/provider traffic. */
export function idleSystemRoleMcpLane(apiOrigin:string,deviceToken:string){
    const origin=new URL(apiOrigin).origin,path='/api/device-channel/system-role-mcp/claim';
    const claims:ControlRequest[]=[],unexpected:ControlRequest[]=[];
    const network=vi.fn(async(input:Parameters<typeof fetch>[0],options?:RequestInit)=>{
        const address=input instanceof Request?input.url:String(input),url=URL.canParse(address)?new URL(address):undefined;
        const headers=new Headers(options?.headers??(input instanceof Request?input.headers:undefined));
        const request:ControlRequest={origin:url?.origin??'invalid-url',path:url?.pathname??'',method:options?.method??'GET',
            authenticated:headers.get('authorization')==='Bearer '+deviceToken,emptyClaim:options?.body==='{}',
            redirectsRejected:options?.redirect==='error'};
        if(!url||url.origin!==origin||url.pathname!==path||url.search||url.hash||request.method!=='POST'
            ||!request.authenticated||!request.emptyClaim||!request.redirectsRejected){
            unexpected.push(request);
            throw new Error('Request crossed the worker fixture control-lane boundary.');
        }
        claims.push(request);return Response.json(null);
    });
    return {network,claims,unexpected};
}
