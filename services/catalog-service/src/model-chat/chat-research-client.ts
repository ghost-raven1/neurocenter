import { HttpException, ServiceUnavailableException } from '@nestjs/common';
import { isIP } from 'node:net';
import type { IPackage } from '../catalog/bundle-package';

export const RESEARCH_TOOL_NAMES = ['web_search_exa', 'web_fetch_exa'] as const;
export type ResearchToolName = (typeof RESEARCH_TOOL_NAMES)[number];
export interface ResearchExternalSource {
    url: string;
    title?: string;
}
export interface ResearchToolOutput {
    text: string;
    sources: ResearchExternalSource[];
}
export interface ResearchToolDefinition {
    name: ResearchToolName;
    description: string;
    inputSchema: Record<string, unknown>;
}
const object = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);

/** A fetch request may address public documents only; neither credentials nor local hosts cross this boundary. */
export function researchPublicUrl(raw: unknown): string | undefined {
    if (typeof raw !== 'string' || raw.length > 2048) return;
    try {
        const url = new URL(raw),
            host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
        if (
            !['https:', 'http:'].includes(url.protocol) ||
            url.username ||
            url.password ||
            (url.port && !['80', '443'].includes(url.port)) ||
            !host.includes('.') ||
            host === 'localhost' ||
            /\.(localhost|local|internal|test|invalid)$/.test(host) ||
            isIP(host) ||
            /^(0|10|127|169\.254|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host)
        )
            return;
        url.hash = '';
        return url.href;
    } catch {
        return;
    }
}

/** Only the approved Gateway transport receives the exact native package, never a user-selected server URL. */
export class ChatResearchMcpClient {
    private readonly base = (process.env.API_GATEWAY_URL || 'http://localhost:4000').replace(/\/+$/, '');
    async list(pkg: IPackage, signal: AbortSignal): Promise<ResearchToolDefinition[]> {
        const data = await this.request('list', { pkg }, signal);
        if (!object(data) || !Array.isArray(data.tools) || data.tools.length !== 2) throw this.invalid();
        const tools = data.tools;
        return RESEARCH_TOOL_NAMES.map((name) => {
            const tool = tools.find((value: unknown) => object(value) && value.name === name);
            if (
                !object(tool) ||
                typeof tool.description !== 'string' ||
                Buffer.byteLength(tool.description) > 8192 ||
                !object(tool.inputSchema) ||
                tool.inputSchema.type !== 'object' ||
                Buffer.byteLength(JSON.stringify(tool.inputSchema)) > 8192
            )
                throw this.invalid();
            return { name, description: tool.description, inputSchema: tool.inputSchema };
        });
    }
    async call(
        pkg: IPackage,
        name: ResearchToolName,
        args: Record<string, unknown>,
        signal: AbortSignal,
    ): Promise<ResearchToolOutput> {
        if (!RESEARCH_TOOL_NAMES.includes(name)) throw this.invalid();
        const data = await this.request('call', { pkg, name, arguments: args }, signal);
        if (
            !object(data) ||
            typeof data.text !== 'string' ||
            !data.text.trim() ||
            Buffer.byteLength(data.text) > 65536 ||
            !Array.isArray(data.sources) ||
            data.sources.length > 12
        )
            throw this.invalid();
        const sources = data.sources.map((source: unknown) => {
            if (
                !object(source) ||
                !researchPublicUrl(source.url) ||
                (source.title !== undefined &&
                    (typeof source.title !== 'string' || Buffer.byteLength(source.title) > 1024))
            )
                throw this.invalid();
            return {
                url: researchPublicUrl(source.url)!,
                ...(typeof source.title === 'string' ? { title: source.title } : {}),
            };
        });
        return { text: data.text, sources };
    }
    private invalid(): ServiceUnavailableException {
        return new ServiceUnavailableException(
            'Поисковый MCP вернул неподтверждённый ответ. История исследования сохранена.',
        );
    }
    private async request(path: 'list' | 'call', body: unknown, signal: AbortSignal): Promise<unknown> {
        const token = process.env.NEUROCENTER_INTERNAL_TOKEN;
        if (!token) throw new ServiceUnavailableException('Серверный канал поисковых инструментов не настроен.');
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(50000)]);
        let response: Response;
        try {
            response = await fetch(this.base + '/internal/research-mcp/' + path, {
                method: 'POST',
                redirect: 'error',
                signal: bounded,
                headers: { 'content-type': 'application/json', 'x-neurocenter-internal': token },
                body: JSON.stringify(body),
            });
        } catch {
            signal.throwIfAborted();
            throw new ServiceUnavailableException('Поисковый MCP недоступен или не ответил вовремя.');
        }
        const reader = response.body?.getReader(),
            parts: Uint8Array[] = [];
        let bytes = 0;
        try {
            if (reader)
                for (;;) {
                    const part = await reader.read();
                    if (part.done) break;
                    bytes += part.value.byteLength;
                    if (bytes > 512 * 1024) {
                        await reader.cancel();
                        throw this.invalid();
                    }
                    parts.push(part.value);
                }
        } catch (error) {
            signal.throwIfAborted();
            if (error instanceof HttpException) throw error;
            throw this.invalid();
        } finally {
            reader?.releaseLock();
        }
        let data: unknown;
        try {
            data = JSON.parse(Buffer.concat(parts).toString('utf8'));
        } catch {
            throw this.invalid();
        }
        if (!response.ok) {
            if (object(data) && [400, 403, 409].includes(response.status) && typeof data.message === 'string')
                throw new HttpException({ message: data.message.slice(0, 2000) }, response.status);
            throw new ServiceUnavailableException('Поисковый MCP не выполнил запрос. История исследования сохранена.');
        }
        return data;
    }
}
