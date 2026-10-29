import http from 'node:http';
import {once} from 'node:events';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {GatewayComputerSetupSupplyApproval} from '../src/devices/gateway-computer-setup-supply-approval';

const source={buildId:'a'.repeat(64),target:'darwin-arm64' as const,version:'1.14.48' as const,sha256:'b'.repeat(64)};
describe.sequential('canonical OpenCode supply approval over own loopback HTTP',()=>{
    let server:http.Server,base:string,calls:Array<{url:string;token:string|undefined}>,reply:unknown,status:number;
    beforeEach(async()=>{
        calls=[];reply=source;status=200;
        server=http.createServer((req,res)=>{calls.push({url:req.url!,token:req.headers['x-neurocenter-internal'] as string|undefined});
            res.writeHead(status,{'content-type':'application/json',...(status===302?{location:base+'/foreign'}:{})});res.end(typeof reply==='string'?reply:JSON.stringify(reply));});
        server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+(server.address() as {port:number}).port;
        vi.stubEnv('API_GATEWAY_URL',base);vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','own-fixture-internal');
    });
    afterEach(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));vi.unstubAllEnvs();});
    it('approves exact canonical bytes and sends no report URL or user input',async()=>{
        await expect(new GatewayComputerSetupSupplyApproval().requireOpenCode(source)).resolves.toBeUndefined();
        expect(calls).toEqual([{url:'/internal/bridge/opencode-cli-supply/darwin-arm64',token:'own-fixture-internal'}]);
    });
    it.each(['buildId','target','version','sha256','extra'])('rejects changed or extended canonical %s',async field=>{
        reply={...source,...(field==='extra'?{extra:true}:{[field]:field==='target'?'darwin-x64':field==='version'?'1.14.49':'c'.repeat(64)})};
        await expect(new GatewayComputerSetupSupplyApproval().requireOpenCode(source)).rejects.toMatchObject({status:409});expect(calls).toHaveLength(1);
    });
    it('does not follow redirects or disclose their address',async()=>{status=302;reply={};
        await expect(new GatewayComputerSetupSupplyApproval().requireOpenCode(source)).rejects.toMatchObject({status:409});expect(calls).toHaveLength(1);
    });
    it('bounds a streamed body without Content-Length',async()=>{reply='x'.repeat(4097);
        await expect(new GatewayComputerSetupSupplyApproval().requireOpenCode(source)).rejects.toMatchObject({status:409});
    });
    it('missing server token and aborted authority cannot send a request',async()=>{
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','');await expect(new GatewayComputerSetupSupplyApproval().requireOpenCode(source)).rejects.toMatchObject({status:409});
        vi.stubEnv('NEUROCENTER_INTERNAL_TOKEN','own-fixture-internal');const abort=new AbortController();abort.abort();
        await expect(new GatewayComputerSetupSupplyApproval().requireOpenCode(source,abort.signal)).rejects.toMatchObject({status:409});expect(calls).toEqual([]);
    });
});
