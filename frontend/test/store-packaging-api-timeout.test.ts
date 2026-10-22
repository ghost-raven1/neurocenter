import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAxiosError } from 'axios';
import base from '../src/core/api/base';
import { packagingApi } from '../src/modules/Store/packaging/api';
import { buildSubmissionRequest, readPendingBuild, savePendingBuild, resumePendingBuild } from '../src/modules/Store/packaging/pendingBuild';
import type { ToolBuildRequest } from '../src/modules/Store/packaging/types';

const key = '77fbc358-c183-4af8-b784-55d0aff94a1a'; // gitleaks:allow — тестовый UUID идемпотентного запроса, не ключ доступа.
const body: ToolBuildRequest = { requestKey: key, name: 'Fixture', description: 'Fixture', kind: 'mcp', source: { type: 'npm', specifier: 'fixture@1.0.0' } };
const queued = { id: 'build', operationId: 'operation', state: 'QUEUED', percent: 0, message: 'Ожидание' };
const originalBase = base.defaults.baseURL;
afterEach(() => { base.defaults.baseURL = originalBase; vi.useRealTimers(); vi.unstubAllGlobals(); });

async function serverFixture(handler: http.RequestListener) {
    const server = http.createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
    base.defaults.baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    return async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
}

describe('Ограничение HTTP ожидания только для упаковки', () => {
    it('Зависшая проверка архива отменяется через 30 секунд без создания сборки', async () => {
        let received!: () => void; const seen = new Promise<void>(resolve => { received = resolve; });
        const requests: string[] = [];
        const close = await serverFixture(request => { requests.push(request.method + ' ' + request.url); request.resume(); received(); });
        try {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
            const result = packagingApi.archive({ name: 'tool.zip', contentBase64: 'UEsA/w==' }).catch(error => error); await seen;
            await vi.advanceTimersByTimeAsync(30_000);
            expect(isAxiosError(await result)).toBe(true);
            expect(requests).toEqual(['POST /api/tool-builds/archive']);
        } finally { await close(); }
    });
    it('Реальный зависший POST освобождает ожидание через 90 секунд, сохраняя UUID для lookup и ручного повтора', async () => {
        const storage = new Map<string, string>();
        vi.stubGlobal('localStorage', { setItem: (name: string, value: string) => storage.set(name, value), getItem: (name: string) => storage.get(name), removeItem: (name: string) => storage.delete(name) });
        const requests: string[] = []; const requestKeys: string[] = []; const operations = new Set<string>(); let postSeen!: () => void;
        const post = new Promise<void>(resolve => { postSeen = resolve; });
        const close = await serverFixture((request, response) => {
            requests.push(request.method + ' ' + request.url);
            if (request.method === 'POST') {
                let raw = ''; request.on('data', chunk => { raw += String(chunk); });
                request.on('end', () => {
                    const submitted = JSON.parse(raw) as ToolBuildRequest; requestKeys.push(submitted.requestKey); operations.add(submitted.requestKey);
                    if (requestKeys.length === 1) { postSeen(); return; }
                    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(queued));
                });
                return;
            }
            response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(queued));
        });
        try {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
            savePendingBuild('alice', key);
            const result = packagingApi.create(body).catch(error => error); await post;
            await vi.advanceTimersByTimeAsync(90_000);
            expect(isAxiosError(await result)).toBe(true); expect(readPendingBuild('alice')).toBe(key);
            expect(requests.filter(value => value.startsWith('POST'))).toHaveLength(1);
            const recovered = await resumePendingBuild(key, packagingApi.lookup, new AbortController().signal);
            expect(recovered.id).toBe(queued.id);
            const retried = buildSubmissionRequest(JSON.stringify(body), {signature:JSON.stringify(body),key}, readPendingBuild('alice'));
            assert.equal(retried.key, key);
            expect((await packagingApi.create({ ...body, requestKey: retried.key })).id).toBe(queued.id);
            expect(requestKeys).toEqual([key, key]); expect(operations.size).toBe(1);
        } finally { await close(); }
    });
    it.each(['lookup', 'get'] as const)('Зависший %s прекращает HTTP запрос через 10 секунд', async method => {
        let received!: () => void; const seen = new Promise<void>(resolve => { received = resolve; });
        const close = await serverFixture(request => { request.resume(); received(); });
        try {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
            const result = packagingApi[method](key).catch(error => error); await seen;
            await vi.advanceTimersByTimeAsync(10_000);
            expect(isAxiosError(await result)).toBe(true);
        } finally { await close(); }
    });
    it.each([
        { name: 'npm', path: '/api/tool-builds/npm', params: { specifier: '@scope/fixture@1.0.0' }, send: () => packagingApi.npm('@scope/fixture@1.0.0') },
        { name: 'repository', path: '/api/tool-builds/repository', params: { url: 'https://github.com/owner/repository', ref: 'feature/branch', subdirectory: 'packages/my tool', entrypoint: 'src/main.ts' }, send: () => packagingApi.repository({ url: 'https://github.com/owner/repository', ref: 'feature/branch', subdirectory: 'packages/my tool', entrypoint: 'src/main.ts' }) },
    ])('Зависший metadata GET $name сохраняет параметры и прекращается через 90 секунд', async ({ path, params, send }) => {
        let received!: () => void; const seen = new Promise<void>(resolve => { received = resolve; });
        let requested: URL | undefined;
        const close = await serverFixture(request => { requested = new URL(request.url!, 'http://127.0.0.1'); request.resume(); received(); });
        try {
            vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
            let settled = false;
            const result = send().catch(error => error).finally(() => { settled = true; }); await seen;
            expect(requested?.pathname).toBe(path);
            expect(Object.fromEntries(requested!.searchParams)).toEqual(params);
            await vi.advanceTimersByTimeAsync(89_999); expect(settled).toBe(false);
            await vi.advanceTimersByTimeAsync(1);
            expect(isAxiosError(await result)).toBe(true);
        } finally { await close(); }
    });
    it('AbortSignal владельца доходит до Axios lookup и отменяет незавершённый HTTP запрос', async () => {
        let received!: () => void; const seen = new Promise<void>(resolve => { received = resolve; });
        const close = await serverFixture(request => { request.resume(); received(); });
        try {
            const controller = new AbortController();
            const result = packagingApi.lookup(key, controller.signal).catch(error => error); await seen;
            controller.abort(); expect(isAxiosError(await result)).toBe(true);
        } finally { await close(); }
    });
});

describe('HTTP отмена упаковки',()=>{
    it('DELETE requestKey сохраняет подтверждение tombstone и не делает POST',async()=>{
        const requests:string[]=[];const responseBody={requestKey:key,state:'CANCELLED',build:null};
        const close=await serverFixture((request,response)=>{requests.push(request.method+' '+request.url);request.resume();response.setHeader('content-type','application/json');response.end(JSON.stringify(responseBody));});
        try{expect(await packagingApi.cancelRequest(key)).toEqual(responseBody);expect(requests).toEqual(['DELETE /api/tool-builds/requests/'+key]);}
        finally{await close();}
    });
    it.each(['cancel','cancelRequest'] as const)('Зависший %s ограничен 10 секундами; ошибку нельзя принять за подтверждённую отмену',async method=>{
        let received!:()=>void;const seen=new Promise<void>(resolve=>{received=resolve;});const requests:string[]=[];
        const close=await serverFixture(request=>{requests.push(request.method+' '+request.url);request.resume();received();});
        try{
            vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']});const result=packagingApi[method](key).catch(error=>error);await seen;
            await vi.advanceTimersByTimeAsync(10_000);expect(isAxiosError(await result)).toBe(true);expect(requests).toEqual(['DELETE /api/tool-builds/'+(method==='cancelRequest'?'requests/':'')+key]);
        }finally{await close();}
    });
});
