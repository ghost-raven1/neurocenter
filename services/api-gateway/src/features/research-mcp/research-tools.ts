import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { isIP } from 'node:net';
import { RESEARCH_TOOL_NAMES } from './research-package';

const record = (value: unknown): value is Record<string, unknown> =>
    !!value && typeof value === 'object' && !Array.isArray(value);
const bad = () => new BadRequestException('Некорректный запрос поискового инструмента.');
export function publicResearchUrl(raw: unknown): string | undefined {
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

/** Explicit search/fetch capabilities prevent a model from selecting arbitrary MCP mutations. */
export function researchArguments(name: unknown, raw: unknown): { name: string; arguments: Record<string, unknown> } {
    if (
        typeof name !== 'string' ||
        !RESEARCH_TOOL_NAMES.includes(name as (typeof RESEARCH_TOOL_NAMES)[number]) ||
        !record(raw)
    )
        throw bad();
    if (name === 'web_search_exa') {
        if (
            Object.keys(raw).some((key) => !['query', 'objective', 'numResults'].includes(key)) ||
            typeof raw.query !== 'string' ||
            !raw.query.trim() ||
            raw.query.length > 4096 ||
            typeof raw.objective !== 'string' ||
            !raw.objective.trim() ||
            raw.objective.length > 4096 ||
            (raw.numResults !== undefined &&
                (!Number.isSafeInteger(raw.numResults) || Number(raw.numResults) < 1 || Number(raw.numResults) > 10))
        )
            throw bad();
        return { name, arguments: { query: raw.query, objective: raw.objective, numResults: raw.numResults ?? 5 } };
    }
    if (
        Object.keys(raw).some((key) => !['urls', 'maxCharacters'].includes(key)) ||
        !Array.isArray(raw.urls) ||
        raw.urls.length < 1 ||
        raw.urls.length > 5 ||
        raw.urls.some((url) => !publicResearchUrl(url)) ||
        (raw.maxCharacters !== undefined &&
            (!Number.isSafeInteger(raw.maxCharacters) ||
                Number(raw.maxCharacters) < 1 ||
                Number(raw.maxCharacters) > 10000))
    )
        throw bad();
    return {
        name,
        arguments: { urls: raw.urls.map((url) => publicResearchUrl(url)!), maxCharacters: raw.maxCharacters ?? 4000 },
    };
}

export function researchTools(raw: unknown) {
    const tools = record(raw) && Array.isArray(raw.tools) ? raw.tools : [];
    return {
        tools: RESEARCH_TOOL_NAMES.map((name) => {
            const tool = tools.find((value) => record(value) && value.name === name);
            if (
                !record(tool) ||
                !record(tool.annotations) ||
                tool.annotations.readOnlyHint !== true ||
                tool.annotations.destructiveHint !== false ||
                !record(tool.inputSchema) ||
                tool.inputSchema.type !== 'object' ||
                Buffer.byteLength(JSON.stringify(tool.inputSchema)) > 8192
            )
                throw new BadGatewayException('Поисковый MCP не подтвердил разрешённые инструменты.');
            return {
                name,
                description: typeof tool.description === 'string' ? tool.description.slice(0, 1200) : name,
                inputSchema: tool.inputSchema,
            };
        }),
    };
}

/** MCP text is untrusted evidence. Only bounded text and public source links reach the planner. */
export function researchOutput(raw: unknown): { text: string; sources: Array<{ url: string; title?: string }> } {
    if (!record(raw) || raw.isError === true || !Array.isArray(raw.content))
        throw new BadGatewayException('Поисковый MCP не выполнил запрос.');
    const text = raw.content
        .filter((item) => record(item) && item.type === 'text' && typeof item.text === 'string')
        .map((item) => (item as { text: string }).text)
        .join('\n');
    if (!text.trim() || Buffer.byteLength(text) > 64 * 1024)
        throw new BadGatewayException('Поисковый MCP вернул пустой или слишком большой ответ.');
    const urls = [
        ...new Set(
            (text.match(/https?:\/\/[^\s<>"\])}]+/g) ?? [])
                .map((value) => publicResearchUrl(value.replace(/[.,;]+$/, '')))
                .filter((value): value is string => !!value),
        ),
    ].slice(0, 12);
    return { text, sources: urls.map((url) => ({ url })) };
}
