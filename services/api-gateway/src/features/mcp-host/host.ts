import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { HostedMcpClaim } from './ticket';
import { materializeArtifact } from './artifact-cache';
import {validHostedMcpSession} from './ticket';

/** Child MCPs inherit trusted CA/proxy settings, without provider keys or arbitrary Node preload code. */
export function hostedMcpEnvironment(env:NodeJS.ProcessEnv=process.env):Record<string,string>{
    const result:Record<string,string>={PATH:env.PATH||'/usr/local/bin:/usr/bin:/bin',HOME:env.HOME||'/tmp',LANG:'C.UTF-8'};
    for(const key of ['NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','SSL_CERT_DIR','NODE_USE_SYSTEM_CA','NODE_USE_ENV_PROXY','HTTPS_PROXY','HTTP_PROXY','ALL_PROXY','NO_PROXY','https_proxy','http_proxy','all_proxy','no_proxy'])if(env[key])result[key]=env[key]!;
    return result;
}

const MAX_HOSTS = Math.max(1, Number(process.env.NEUROCENTER_MCP_HOST_MAX || 4));
const IDLE_TTL_MS = 30 * 60 * 1000;
const START_TIMEOUT_MS = 20000;
const TOOL_OUTPUT_LIMIT = 8 * 1024 * 1024;

interface HostSession { claim: HostedMcpClaim; client: Client; lastUsed: number; listeners: number }

class McpHostService {
    private readonly hosts = new Map<string, HostSession>();
    private readonly starting = new Map<string, Promise<HostSession>>();
    private readonly idleTimer:ReturnType<typeof setInterval>;

    constructor(private readonly catalogUrl: string, private readonly internalToken: string) {
        this.idleTimer=setInterval(() => { this.reap(); }, 60 * 1000);this.idleTimer.unref();
    }
    private hostKey(claim:HostedMcpClaim):string{
        return JSON.stringify([claim.artifactSha256,claim.session?.projectId,claim.session?.deviceId,claim.session?.manifest,claim.researchSessionId]);
    }

    private async adopt(claim: HostedMcpClaim): Promise<HostSession> {
        const key=this.hostKey(claim);let session = this.hosts.get(key);
        if (!session) {
            const starting = this.starting.get(key);
            if (starting) { session = await starting; }
            else {
                this.reap();
                if (this.hosts.size + this.starting.size >= MAX_HOSTS) { throw httpError(503, 'Лимит хостов MCP площадки исчерпан. Вернитесь позже.'); }
                const task = this.spawn(claim).finally(() => this.starting.delete(key));
                this.starting.set(key, task);
                session = await task;
                this.hosts.set(key, session);
            }
        }
        if (session.claim.entrypoint !== claim.entrypoint || session.claim.executable !== claim.executable) {
            throw httpError(503, 'Комплект хоста конфликтует. Повторите подключение.');
        }
        session.lastUsed = Date.now();
        session.listeners += 1;
        return session;
    }

    private release(_claim: HostedMcpClaim, session: HostSession): void {
        session.listeners = Math.max(0, session.listeners - 1);
        session.lastUsed = Date.now();
    }

    /** Server research uses the same approved Gateway artifact, with cancellation on each actual MCP operation. */
    async researchTools(claim:HostedMcpClaim,signal:AbortSignal){
        signal.throwIfAborted();const session=await this.adopt(claim);
        try{signal.throwIfAborted();return await session.client.listTools(undefined,{signal,timeout:15000});}
        finally{this.release(claim,session);}
    }

    async researchCall(claim:HostedMcpClaim,name:string,args:Record<string,unknown>,signal:AbortSignal){
        signal.throwIfAborted();const session=await this.adopt(claim);
        try{signal.throwIfAborted();return await session.client.callTool({name,arguments:args},undefined,{signal,timeout:30000});}
        finally{this.release(claim,session);}
    }
    /** Only a request's own research child is closed; public project sessions and shared artifact bytes stay intact. */
    async closeResearchSession(claim:HostedMcpClaim):Promise<void>{
        if(!claim.researchSessionId)return;
        const key=this.hostKey(claim),session=this.hosts.get(key);this.hosts.delete(key);
        if(session)await session.client.close();
    }

    private async spawn(claim: HostedMcpClaim): Promise<HostSession> {
        const root = await materializeArtifact(claim, this.catalogUrl, this.internalToken);
        const entry = entryPath(root, claim.entrypoint);
        let started: HostSession | undefined;
        const transport = new StdioClientTransport({
            command: claim.executable ? entry : process.execPath,
            args: claim.executable ? [] : [entry],
            cwd: root,
            env: hostedMcpEnvironment(),
            stderr: 'pipe',
        });
        transport.stderr?.on('data',()=>undefined);
        const client = new Client({ name: 'neurocenter-mcp-host', version: '1' }, { capabilities: {} });
        try {
            await withTimeout(client.connect(transport), START_TIMEOUT_MS, 'Запуск сервера MCP на площадке превысил время ожидания.');
            started = { claim, client, lastUsed: Date.now(), listeners: 0 };
        } catch (error) {
            await transport.close().catch(() => undefined);
            throw httpError(502, (error as Error).message || 'Сервер MCP не запустился на площадке.');
        }
        transport.onclose = () => {
            const key=this.hostKey(claim),current = this.hosts.get(key);
            if (current && current.client === client) {
                this.hosts.delete(key);
                void client.close().catch(() => undefined);
            }
        };
        return started;
    }

    private reap(): void {
        for (const [key, session] of [...this.hosts]) {
            if (session.lastUsed < Date.now() - IDLE_TTL_MS) {
                this.hosts.delete(key);
                void session.client.close().catch(() => undefined);
            }
        }
    }

    /** Shutdown waits for owned startup attempts, then closes every child and its stdio transport. */
    async onModuleDestroy():Promise<void>{
        clearInterval(this.idleTimer);
        await Promise.allSettled([...this.starting.values()]);
        const sessions=[...this.hosts.values()];this.hosts.clear();
        await Promise.allSettled(sessions.map(session=>session.client.close()));
    }

    /** Безstate-канал: инструменты проксируются в общий процесс-сервер, транспорт живёт ровно время канала. */
    async handle(claim: HostedMcpClaim, req: Request, res: Response): Promise<void> {
        let session: HostSession;
        try { await this.authorizeSession(claim);session = await this.adopt(claim); }
        catch (error) {
            const e = error as { status?: number; message?: string };
            if (!res.headersSent) { res.status(e.status || 502).json({ jsonrpc: '2.0', error: { code: e.status === 503 ? -32000 : -32603, message: e.message || 'Хост MCP недоступен.' }, id: null }); }
            return;
        }
        try {
            const listed = await withTimeout(session.client.listTools(), START_TIMEOUT_MS, 'Список инструментов хоста не отвечал вовремя.');
            const server = new Server({ name: claim.name || 'neurocenter-hosted-mcp', version: '1' }, { capabilities: { tools: { listChanged: false } } });
            server.setRequestHandler(ListToolsRequestSchema, async (_request,extra) => {await this.authorizeSession(claim,extra.signal);return { tools: listed.tools };});
            server.setRequestHandler(CallToolRequestSchema, async (request,extra) => {
                await this.authorizeSession(claim,extra.signal);
                const result = await session.client.callTool({ name: request.params.name, arguments: request.params.arguments ?? {} },undefined,{signal:extra.signal,timeout:30000});
                if (Buffer.byteLength(JSON.stringify(result.content ?? []), 'utf8') > TOOL_OUTPUT_LIMIT) {
                    return { content: [{ type: 'text', text: 'Ответ инструмента превышает размер площадки.' }], isError: true };
                }
                return result;
            });
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            transport.onclose = () => { this.release(claim, session); };
            await server.connect(transport);
            await transport.handleRequest(req as unknown as IncomingMessage, res as unknown as ServerResponse, (req.body ?? {}) as Record<string, unknown>);
            if (!res.writableEnded) { res.end(); }
        } catch (error) {
            const e = error as { status?: number; message?: string };
            if (!res.headersSent && !res.writableEnded) { res.status(e.status || 500).json({ jsonrpc: '2.0', error: { code: -32603, message: e.message || 'Хост MCP недоступен.' }, id: null }); }
            else if (!res.writableEnded) { try { res.end(); } catch { /* Канал уже закрыт. */ } }
        }
    }

    private async authorizeSession(claim:HostedMcpClaim,signal?:AbortSignal):Promise<void>{
        if(!validHostedMcpSession(claim.session))throw httpError(401,'Соединение MCP нужно установить заново.');
        try{
            const response=await fetch(this.catalogUrl.replace(/\/+$/,'')+'/internal/mcp-host/authorize-session',{
                method:'POST',redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(10000),...(signal?[signal]:[])]),
                headers:{'content-type':'application/json','x-neurocenter-internal':this.internalToken},body:JSON.stringify({...claim.session,artifactSha256:claim.artifactSha256}),
            });
            if(!response.ok){await response.body?.cancel();throw httpError(response.status===403||response.status===401?403:503,'Доступ к MCP отозван или временно недоступен.');}
            await response.body?.cancel();
        }catch(error){if((error as {status?:number}).status)throw error;throw httpError(503,'Не удалось подтвердить доступ к MCP.');}
    }
}

function entryPath(root: string, entrypoint: string): string {
    if (path.isAbsolute(entrypoint) || entrypoint.includes('..')) { throw httpError(500, 'Некорректная точка входа хоста.'); }
    const absolute = path.resolve(root, entrypoint);
    if (absolute !== root && !absolute.startsWith(root + path.sep)) { throw httpError(500, 'Некорректная точка входа хоста.'); }
    return absolute;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(httpError(504, message)), ms); timer.unref(); });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function httpError(status: number, message: string): Error & { status: number } {
    const error = new Error(message) as Error & { status: number };
    error.status = status;
    return error;
}

export { McpHostService };
