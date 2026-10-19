'use strict';
const {timingSafeEqual}=require('node:crypto');
const {renderCapacityMetrics}=require('./capacity.cjs');
const {renderMaintenanceMetrics}=require('./maintenance-metrics.cjs');

const buckets=[0.01,0.05,0.1,0.25,0.5,1,2.5,5,10,30];
const methods=new Set(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']);
const services=new Set(['oauth2-bridge','api-gateway','catalog-service','skills-service','rag-sync-service','feature-flags-service']);

/** Фиксированные группы исключают почту, ID проектов, коды OAuth и произвольные URL из меток. */
function group(url){
    const pathname=String(url||'').split('?')[0];
    if(pathname==='/health'||pathname==='/ready'){return pathname.slice(1);}
    if(pathname==='/api'||pathname.startsWith('/api/')){return 'api';}
    if(pathname==='/auth'||pathname.startsWith('/auth/')){return 'auth';}
    return 'other';
}

function authorized(headers,token){
    if(!token){return false;}
    const input=typeof headers.authorization==='string'&&headers.authorization.startsWith('Bearer ')
        ?headers.authorization.slice(7):headers['x-neurocenter-metrics'];
    if(typeof input!=='string'){return false;}
    const candidate=Buffer.from(input);const expected=Buffer.from(token);
    return candidate.length===expected.length&&timingSafeEqual(candidate,expected);
}

/** Один экземпляр на процесс: метрики не хранят тела, заголовки и значения пользовательских маршрутов. */
function createObservability({service,token=()=>process.env.NEUROCENTER_METRICS_TOKEN,now=()=>process.hrtime.bigint()}={}){
    if(!services.has(service)){throw new Error('Неизвестный сервис метрик.');}
    const requests=new Map();const durations=new Map();let active=0;
    const middleware=(req,res,next)=>{
        if(String(req.url||'').split('?')[0]==='/metrics'){
            res.setHeader('Cache-Control','no-store');
            if(!authorized(req.headers,token())){res.statusCode=403;res.end();return;}
            if(req.method!=='GET'){res.statusCode=405;res.setHeader('Allow','GET');res.end();return;}
            res.setHeader('Content-Type','text/plain; version=0.0.4; charset=utf-8');res.end(render());return;
        }
        const method=methods.has(req.method)?req.method:'OTHER';const route=group(req.url);
        const started=now();active++;let completed=false;
        const complete=aborted=>{
            if(completed){return;}completed=true;active--;
            const status=aborted?499:Math.min(599,Math.max(100,Number(res.statusCode)||500));
            const labels=`method="${method}",group="${route}"`;
            const countKey=`${labels},status="${status}"`;requests.set(countKey,(requests.get(countKey)||0)+1);
            const duration=Math.max(0,Number(now()-started)/1e9);
            const histogram=durations.get(labels)||{count:0,sum:0,buckets:buckets.map(()=>0)};
            histogram.count++;histogram.sum+=duration;
            buckets.forEach((upper,index)=>{if(duration<=upper){histogram.buckets[index]++;}});
            durations.set(labels,histogram);
        };
        res.once('finish',()=>complete(false));res.once('close',()=>complete(!res.writableFinished));next();
    };
    function render(){
        const common=`service="${service}"`;const memory=process.memoryUsage();const cpu=process.cpuUsage();
        const lines=[
            '# HELP neurocenter_http_requests_total Завершённые HTTP-запросы.',
            '# TYPE neurocenter_http_requests_total counter',
            ...[...requests].map(([labels,value])=>`neurocenter_http_requests_total{${common},${labels}} ${value}`),
            '# HELP neurocenter_http_request_duration_seconds Длительность HTTP-запросов.',
            '# TYPE neurocenter_http_request_duration_seconds histogram',
        ];
        for(const [labels,histogram] of durations){
            buckets.forEach((upper,index)=>lines.push(`neurocenter_http_request_duration_seconds_bucket{${common},${labels},le="${upper}"} ${histogram.buckets[index]}`));
            lines.push(`neurocenter_http_request_duration_seconds_bucket{${common},${labels},le="+Inf"} ${histogram.count}`);
            lines.push(`neurocenter_http_request_duration_seconds_count{${common},${labels}} ${histogram.count}`);
            lines.push(`neurocenter_http_request_duration_seconds_sum{${common},${labels}} ${histogram.sum}`);
        }
        for(const [name,type,value] of [
            ['neurocenter_http_in_flight','gauge',active],
            ['neurocenter_process_uptime_seconds','gauge',process.uptime()],
            ['neurocenter_process_resident_memory_bytes','gauge',memory.rss],
            ['neurocenter_process_heap_used_bytes','gauge',memory.heapUsed],
            ['neurocenter_process_cpu_seconds_total','counter',(cpu.user+cpu.system)/1e6],
        ]){lines.push(`# HELP ${name} Метрика процесса сервиса.`,`# TYPE ${name} ${type}`,`${name}{${common}} ${value}`);}
        lines.push(renderCapacityMetrics());
        if(service==='catalog-service'){lines.push(renderMaintenanceMetrics());}
        return lines.join('\n')+'\n';
    }
    return {middleware,render};
}

module.exports={createObservability};
