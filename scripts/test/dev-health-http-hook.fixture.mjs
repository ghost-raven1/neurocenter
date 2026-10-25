/** Adapt the existing isolated fetch fixtures to direct HTTP probes, without opening real sockets. */
export const healthHttpHook=`{
    const {EventEmitter}=await import('node:events');
    const cp=(await import('node:child_process')).default,originalSpawn=cp.spawn;
    cp.spawn=function(binary,...args){
        if(binary==='/usr/sbin/lsof'||binary==='lsof'){
            const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>true;
            queueMicrotask(()=>child.emit('close',1));return child;
        }
        return originalSpawn.call(this,binary,...args);
    };
    http.request=(options,receive)=>{
        const request=new EventEmitter(),controller=new AbortController();
        request.destroy=()=>{controller.abort();return request;};
        request.end=()=>{
            void fetch('http://'+options.hostname+':'+options.port+options.path,{signal:controller.signal,headers:options.headers}).then(async source=>{
                if(controller.signal.aborted)return;
                const response=new EventEmitter();response.statusCode=source.status;response.headers=Object.fromEntries(source.headers);
                let destroyed=false;response.destroy=()=>{destroyed=true;return response;};receive(response);
                const body=Buffer.from(await source.arrayBuffer());
                if(!destroyed)response.emit('data',body);
                if(!destroyed)response.emit('end');
            }).catch(error=>request.emit('error',error));
            return request;
        };
        return request;
    };
    syncBuiltinESMExports();
}`;
