import {snapshotContentRoute,snapshotDownloadRoute,snapshotPublicationRoute} from '../../../shared/snapshot-content-route.cjs';
import {forwardSnapshotChunk} from './snapshot-stream';
import {sourceUploadContentRoute} from '../../../shared/source-upload-route.cjs';
import {forwardSourceUpload} from './source-upload-stream';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import type { Request, Response } from 'express';
import {createHash} from 'node:crypto';

import { filterResponse, IResourceClaims } from './access-response';
import { AuthGuardService, IAuthPayload } from '../auth/auth-guard.service';
import {LiveService} from '../live/live.service';
import { forwardRuntimeArtifact } from './runtime-artifact-stream';
import { forwardBackupDownload } from './backup-download-stream';
import {forwardToolAssetDocument,forwardToolSupply} from './tool-supply-stream';
import {featureFlagFailure,requiredFeatureFlag} from '../features/feature-flag-gate';
import {awaitEmbedding} from './embedding-deadline';
import {canonicalAccessRoute} from '../../../shared/access-route.cjs';

type THttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

const STRIP_HEADERS = new Set(['x-neurocenter-internal', 'host', 'content-length', 'accept-encoding', 'connection', 'transfer-encoding']);

/**
 * Прокси-логика gateway: auth-guard, затем маршрутизация подпотоков
 * `/api/skills/**` → skills-service, остальное → catalog-service.
 * Инжект identity: x-bridge-user-id / x-bridge-roles / x-bridge-policies.
 */
@Injectable()
export class ProxyService {
    private readonly catalogUrl: string;
    private readonly skillsUrl: string;
    private readonly ragUrl: string;
    private readonly featureFlagsUrl:string;
    private readonly http: AxiosInstance;
    private readonly pairLimits=new Map<string,{count:number;until:number}>();

    constructor(configService: ConfigService, private readonly authGuard: AuthGuardService,private readonly live:LiveService) {
        this.catalogUrl = (configService.get<string>('CATALOG_SERVICE_URL') || 'http://localhost:4100').replace(/\/+$/, '');
        this.skillsUrl = (configService.get<string>('SKILLS_SERVICE_URL') || 'http://localhost:4200').replace(/\/+$/, '');
        this.ragUrl = (configService.get<string>('RAG_SERVICE_URL') || 'http://localhost:4300').replace(/\/+$/, '');
        this.featureFlagsUrl=(configService.get<string>('FEATURE_FLAGS_SERVICE_URL')||'http://localhost:4400').replace(/\/+$/,'');
        this.http = axios.create({ timeout: 30000, validateStatus: () => true });
    }

    /**
     * Проверяет сессию, выбирает upstream (skills/catalog), пересылает запрос и копирует ответ.
     *
     * @param {Request} req - входящий
     * @param {Response} res - исходящий
     * @returns {Promise<void>}
     */
    public async forward(req: Request, res: Response): Promise<void> {
        if(req.path.startsWith('/api/device-channel/')){await this.deviceChannel(req,res);return;}
        const auth = await this.authGuard.authenticate(req);

        if (!auth) {
            res.status(401).json({ error: 'unauthorized' });
            return;
        }

        const path = req.path;
        const method = (req.method || 'GET').toUpperCase() as THttpMethod;
        const coordinatedRagSync = method === 'POST' && canonicalAccessRoute(path) === '/api/rag/sync';
        const upstreamBase = /^\/api\/feature-flags(?:\/|$)/.test(path)
            ? this.featureFlagsUrl
            : coordinatedRagSync
            ? this.catalogUrl
            : path.startsWith('/api/rag')
            ? this.ragUrl
            : path.startsWith('/api/skills')
              ? this.skillsUrl
              : this.catalogUrl;
        const snapshotPublication=snapshotPublicationRoute(method,path);
        if(auth.deviceId && !((!!snapshotPublication&&!!req.headers['x-neurocenter-job-id']&&!!req.headers['x-neurocenter-job-lease'])||(['GET','HEAD'].includes(method)&&/^\/api\/(projects|ai-plugins|skills|rag)(\/|$)/.test(path)) || (method==='POST'&&['/api/skills/sync','/api/rag/sync'].includes(path)))){
            res.status(403).json({message:'Подключение MCP не даёт прав управления пользователями, каталогом или настройками сервера.'});return;
        }

        try {
            const payload = req.body as Record<string,unknown> | undefined;
            if(auth.deviceId&&(req.headers['x-neurocenter-job-id']||req.headers['x-neurocenter-job-lease'])){
                const jobId=String(req.headers['x-neurocenter-job-id']||'');const lease=String(req.headers['x-neurocenter-job-lease']||'');
                if(!/^[a-f0-9-]{36}$/.test(jobId)||!/^[a-f0-9-]{36}$/.test(lease)){res.status(403).json({message:'Некорректная аренда задания.'});return;}
                const job=await this.http.post(`${this.catalogUrl}/internal/device-channel/jobs/${jobId}/authorize`,{lease},{headers:{authorization:req.headers.authorization,'x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN||''}});
                if(job.status<200||job.status>=300||!(snapshotPublication?job.data.projectId===snapshotPublication.projectId&&job.data.snapshotId===snapshotPublication.snapshotId&&job.data.snapshotProtocol==='project-snapshots-v1':path.startsWith('/api/rag/')&&job.data.projectId===String(payload?.projectKey||req.query.projectKey||''))){
                    res.status(403).json({message:'Доступ задания к проекту отозван или его аренда истекла.'});return;
                }
                auth.activeRole=String(job.data.role);
            }
            const decision = await this.http.post<{allowed:boolean;claims:IResourceClaims}>(`${this.catalogUrl}/internal/access/authorize`, {
                email:auth.email, activeRole:auth.activeRole, method, path, query:req.query,
                body:payload ? {projectKey:payload.projectKey,projectName:payload.projectName,path:payload.path,role:payload.role} : {},
            },{headers:{'x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN || ''}});
            if (decision.status !== 201 && decision.status !== 200) {
                res.status(decision.status === 403 ? 403 : 503).json({message:'Не удалось проверить доступ к ресурсу.'}); return;
            }
            if (!decision.data.allowed) { res.status(403).json({message:'Активная роль не разрешает это действие в данном проекте.'}); return; }
            const flag=requiredFeatureFlag(method,path,req.body);
            if(flag) {
                const failure=await featureFlagFailure(this.http,this.featureFlagsUrl,flag);
                if(failure){res.setHeader('Cache-Control','no-store');res.status(failure.status).json(failure);return;}
            }
            if(/^\/api\/feature-flags(?:\/|$)/.test(path))res.setHeader('Cache-Control','no-store');
            const uploadRoute=sourceUploadContentRoute(method,path)||snapshotContentRoute(method,path);
            if(uploadRoute){await forwardSourceUpload(this.http,`${this.catalogUrl}${uploadRoute}`,this.buildHeaders(req.headers,auth),req,res,snapshotContentRoute(method,path)?64*1024**2:undefined);return;}
            const snapshotDownload=snapshotDownloadRoute(method,path);
            if(snapshotDownload){await forwardSnapshotChunk(this.http,`${this.catalogUrl}${snapshotDownload}`,this.buildHeaders(req.headers,auth),req,res);return;}
            const supplyPath=canonicalAccessRoute(path);
            if(['GET','HEAD'].includes(method)&&/^\/api\/tool-builds\/[a-fA-F0-9-]{36}\/supply$/.test(supplyPath||'')){
                await forwardToolSupply(this.http,`${this.catalogUrl}${supplyPath}`,this.buildHeaders(req.headers,auth),req,res);return;
            }
            if(method==='GET'&&/^\/api\/tool-builds\/[a-fA-F0-9-]{36}\/asset$/.test(supplyPath||'')){
                await forwardToolAssetDocument(this.http,`${this.catalogUrl}${supplyPath}`,this.buildHeaders(req.headers,auth),req,res);return;
            }
            if(['GET','HEAD'].includes(method)&&/\/backups\/[^/]+\/download\/*$/.test(path)){
                await forwardBackupDownload(this.http,`${upstreamBase}${path}`,this.buildHeaders(req.headers,auth),req,res);return;
            }
            const upstream = await this.http.request({
                method,
                // Source inspection chains external reads; leave time to return before the client's 90 s deadline.
                ...(method === 'GET' && /^\/api\/tool-builds\/(?:repository|npm)$/.test(supplyPath || '') ? {timeout: 85000} : {}),
                ...(/^\/api\/models\/[^/]+\/ollama\//.test(path) ? {timeout: 610000, maxContentLength: 8 * 1024 * 1024} : {}),
                responseType: 'json',
                url: `${upstreamBase}${coordinatedRagSync ? '/api/rag/sync' : path}`,
                headers: this.buildHeaders(req.headers, auth),
                params: req.query,
                data: req.body,
            });

            res.status(upstream.status);
            if (typeof upstream.headers['content-disposition']==='string') { res.setHeader('content-disposition',upstream.headers['content-disposition']); }
            const contentType = upstream.headers['content-type'];

            if (typeof contentType === 'string') {
                res.setHeader('Content-Type', contentType);
            }

            const body=filterResponse(upstream.data,decision.data.claims,auth.activeRole,path);
            // Express send(null) means no body; an explicit JSON null is a valid empty selection.
            if(body===null&&typeof contentType==='string'&&/^application\/(?:[a-z0-9.+_-]+\+)?json(?:\s*;|$)/i.test(contentType))res.json(null);
            else res.send(body);
            if(upstream.status>=200&&upstream.status<300&&!['GET','HEAD','OPTIONS'].includes(method)&&!/^\/api\/models\/[^/]+\/ollama\//.test(path)){this.live.mutation(path,auth.email,upstream.data as Record<string,unknown>,method);}
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error('[api-gateway] proxy error:', error instanceof Error ? error.message : 'upstream-unavailable');
            res.status(502).json({ error: 'upstream-unavailable' });
        }
    }

    /** Устройство имеет узкий канал; произвольные internal-маршруты не проксируются. */
    private async deviceChannel(req:Request,res:Response):Promise<void>{
        const suffix=req.path.slice('/api/device-channel/'.length);
        if(req.method==='GET'&&/^jobs\/[a-f0-9-]{36}\/runtime\/[a-f0-9]{64}$/.test(suffix)){
            const identity=await this.authGuard.authenticate({headers:{authorization:req.headers.authorization}} as Request);
            if(!identity?.deviceId){res.status(401).json({message:'MCP не подключён или доступ отозван.'});return;}
            await forwardRuntimeArtifact(this.http,this.catalogUrl,suffix,req,res);return;
        }
        const publicPair=/^pair\/(start|poll)$/.test(suffix);
        if(req.method!=='POST'||(!publicPair&&!/^(identity|heartbeat|configuration-authorize|embedding(?:\/context)?|worker\/(pause|resume)|jobs\/claim|jobs\/[a-f0-9-]{36}\/(authorize|progress|complete))$/.test(suffix))){res.status(404).json({message:'Маршрут MCP не найден.'});return;}
        if(publicPair){
            const now=Date.now();for(const [key,value] of this.pairLimits){if(value.until<now){this.pairLimits.delete(key);}}
            const address=String(req.socket.remoteAddress);
            const budgets:Array<[string,number]>=suffix.endsWith('start')?[[address+':start',15]]:[[address+':poll',6000]];
            if(suffix.endsWith('poll')){
                const code=(req.body as {deviceCode?:unknown}|null)?.deviceCode;
                if(typeof code!=='string'||!/^[a-f0-9]{64}$/.test(code)){res.status(401).json({message:'Некорректный код подключения.'});return;}
                // Устройства за одним прокси не расходуют чужое окно ожидания; общий предел сохраняется.
                budgets.push([address+':poll:'+createHash('sha256').update(code).digest('hex'),60]);
            }
            for(const [key,maximum] of budgets){
                const limit=this.pairLimits.get(key)||{count:0,until:now+60000};limit.count++;this.pairLimits.set(key,limit);
                if(limit.count>maximum){res.status(429).json({message:'Слишком много попыток подключения. Повторите через минуту.'});return;}
            }
        }
        if(suffix==='embedding'){await this.deviceEmbedding(req,res);return;}
        const auth=publicPair?null:await this.authGuard.authenticate({headers:{authorization:req.headers.authorization}} as Request);
        if(!publicPair&&!auth?.deviceId){res.status(401).json({message:'MCP не подключён или доступ отозван.'});return;}
        try{
            const response=await this.http.post(`${this.catalogUrl}/internal/device-channel/${suffix}`,req.body,{
                headers:{'x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN||'',...(!publicPair||suffix==='pair/start'?{authorization:req.headers.authorization}:{})}});
            res.status(response.status).json(response.data===''?null:response.data);
            if(response.status>=200&&response.status<300&&auth&&!suffix.startsWith('embedding')){this.live.bridge(auth.email,auth.deviceId,/^jobs\//.test(suffix)?suffix.split('/')[1]:undefined);}
            if(response.status>=200&&response.status<300&&/\/(progress|complete)$/.test(suffix)&&['succeeded','failed'].includes(String((req.body as {state?:unknown})?.state))){this.live.sections(['knowledge','projects','operations','audit']);}
        }catch{res.status(502).json({message:'Сервис подключений недоступен.'});}
    }

    /** Закрытие клиента отменяет только его embedding, включая ожидание проверки Bearer. */
    private async deviceEmbedding(req:Request,res:Response):Promise<void>{
        let timedOut=false;
        const abort=new AbortController(),disconnected=()=>abort.abort();
        const timer=setTimeout(()=>{timedOut=true;abort.abort();},115000);
        const closed=()=>{if(!res.writableEnded)abort.abort();};
        const connected=()=>!req.aborted&&!res.destroyed&&!res.writableEnded;
        const open=()=>!abort.signal.aborted&&connected();
        const timeoutReply=()=>{if(timedOut&&connected())res.status(504).json({code:'EMBEDDING_TIMEOUT',message:'Модель не ответила вовремя. Проверьте хостинг и повторите действие.'});};
        req.on('aborted',disconnected);res.on('close',closed);
        try{
            if(req.aborted||res.destroyed)abort.abort();
            if(!open())return;
            let auth:IAuthPayload|null;
            try{auth=await awaitEmbedding(this.authGuard.authenticate({headers:{authorization:req.headers.authorization}} as Request),abort.signal);}
            catch(error){if(!open()){timeoutReply();return;}throw error;}
            if(!open()){timeoutReply();return;}
            if(!auth?.deviceId){res.status(401).json({message:'MCP не подключён или доступ отозван.'});return;}
            try{
                const response=await awaitEmbedding(this.http.post(`${this.catalogUrl}/internal/device-channel/embedding`,req.body,{
                    timeout:115000,maxContentLength:8*1024*1024,signal:abort.signal,
                    headers:{'x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN||'',authorization:req.headers.authorization}}),abort.signal);
                if(open())res.status(response.status).json(response.data===''?null:response.data);
            }catch{if(open())res.status(502).json({message:'Сервис подключений недоступен.'});else timeoutReply();}
        }finally{clearTimeout(timer);req.removeListener('aborted',disconnected);res.removeListener('close',closed);}
    }

    private buildHeaders(headers: Record<string, unknown>, auth: IAuthPayload): Record<string, string> {
        const result: Record<string, string> = {};

        for (const [key, value] of Object.entries(headers)) {
            const lowerKey = key.toLowerCase();
            // identity-заголовки отдаём только из валидной сессии (защита от спуфинга клиентом;
            // в т.ч. другие регистры — x-bridge-* вырезаем case-insensitive)
            if (STRIP_HEADERS.has(lowerKey) || lowerKey.startsWith('x-bridge-') || typeof value !== 'string') {
                continue;
            }

            result[lowerKey] = value;
        }

        result['x-bridge-user-id'] = auth.userId;
        result['x-bridge-principal'] = auth.principalName;
        result['x-bridge-roles'] = encodeURIComponent(auth.activeRole);
        result['x-bridge-actor'] = encodeURIComponent(JSON.stringify({email:auth.email,activeRole:auth.activeRole}));
        result['x-neurocenter-internal'] = process.env.NEUROCENTER_INTERNAL_TOKEN || '';
        result['x-bridge-policies'] = encodeURIComponent(JSON.stringify(auth.policies));

        return result;
    }
}
