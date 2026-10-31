import { Body, Controller, ForbiddenException, Headers, Inject, Post, Req, Res } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import type { Request, Response } from 'express';
import { requireFeaturesEnabled } from '../../../../shared/feature-client.cjs';
import {
    SYSTEM_ROLE_MCP_LIMITS as limits,
    normalizeRoleMcpDiscovery,
    normalizeRoleMcpOutput,
    boundedMcpJson,
    type RoleMcpSessionContext,
    type RoleMcpCallContext,
    type RoleMcpExecutionResult,
} from '../../../../shared/system-role-mcp.cjs';
import type { McpHostService } from '../mcp-host/host';
import { roleHostedPackage } from './package';
const uuid = (raw: unknown): raw is string =>
    typeof raw === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(raw);
const object = (raw: unknown): raw is Record<string, unknown> =>
    !!raw && typeof raw === 'object' && !Array.isArray(raw);

/** Catalogue alone supplies exact call contexts and one-send admission; the browser never submits launch configuration. */
@Controller('internal/system-role-mcp')
export class SystemRoleMcpGatewayController {
    private readonly catalog = (process.env.CATALOG_SERVICE_URL || 'http://localhost:4100').replace(/\/+$/, '');
    constructor(@Inject('MCP_HOST') private readonly host: McpHostService) {}
    private token(token: unknown) {
        const expected = process.env.NEUROCENTER_INTERNAL_TOKEN ?? '';
        if (
            typeof token !== 'string' ||
            !expected ||
            Buffer.byteLength(token) !== Buffer.byteLength(expected) ||
            !timingSafeEqual(Buffer.from(token), Buffer.from(expected))
        )
            throw new ForbiddenException();
    }
    private async request(path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
        const response = await fetch(this.catalog + '/internal/system-role-mcp/' + path, {
            method: 'POST',
            redirect: 'error',
            signal,
            headers: {
                'content-type': 'application/json',
                'x-neurocenter-internal': process.env.NEUROCENTER_INTERNAL_TOKEN ?? '',
            },
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            await response.body?.cancel();
            throw new Error('MCP не получил подтверждение текущего допуска.');
        }
        const reader = response.body?.getReader();
        if (!reader) throw new Error('Контекст MCP недоступен.');
        let bytes = 0;
        const parts: Uint8Array[] = [];
        try {
            for (;;) {
                const part = await reader.read();
                if (part.done) break;
                bytes += part.value.byteLength;
                if (bytes > 8 * 1024 * 1024) {
                    await reader.cancel();
                    throw new Error('Контекст MCP превысил предел.');
                }
                parts.push(part.value);
            }
        } finally {
            reader.releaseLock();
        }
        return JSON.parse(Buffer.concat(parts).toString('utf8'));
    }
    /** Delivery retries the same private receipt only; caller cancellation never repeats the physical tool action. */
    private async receipt(
        callId: string,
        proof: string,
        result: RoleMcpExecutionResult,
    ): Promise<RoleMcpExecutionResult> {
        const signal = AbortSignal.timeout(5000),
            body = { callId, proof, result };
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                await this.request('result', body, signal);
                break;
            } catch {
                if (signal.aborted) break;
            }
        }
        return result;
    }
    @Post('execute')
    async execute(
        @Headers('x-neurocenter-internal') token: string,
        @Body() body: unknown,
        @Req() req: Request,
        @Res({ passthrough: true }) res: Response,
    ): Promise<RoleMcpExecutionResult> {
        this.token(token);
        if (!object(body) || Object.keys(body).join(',') !== 'callId' || !uuid(body.callId))
            throw new ForbiddenException();
        const controller = new AbortController(),
            abort = () => {
                if (!res.writableEnded) controller.abort();
            };
        req.once('aborted', abort);
        res.once('close', abort);
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(45000)]);
        let dispatched = false,
            proof: string | undefined,
            claim: ReturnType<typeof roleHostedPackage> | undefined;
        try {
            await requireFeaturesEnabled(['system_role_mcp', 'tool_catalog'], process.env, globalThis.fetch, signal);
            const context = (await this.request('context', { callId: body.callId }, signal)) as {
                session: RoleMcpSessionContext;
                call: RoleMcpCallContext;
            };
            if (
                !context?.session ||
                context.call?.id !== body.callId ||
                context.session.target.runtime !== 'server' ||
                typeof context.call.proof !== 'string' ||
                !/^[a-f0-9]{64}$/.test(context.call.proof) ||
                Date.parse(context.session.deadlineAt) <= Date.now() ||
                Date.parse(context.call.deadlineAt) <= Date.now()
            )
                throw new Error('Сессия MCP истекла.');
            proof = context.call.proof;
            claim = roleHostedPackage(context.session.package, context.session.sessionId);
            if (context.call.kind === 'list') {
                dispatched = true;
                await this.request('dispatch', { callId: context.call.id, proof }, signal);
                signal.throwIfAborted();
                return await this.receipt(body.callId, proof, {
                    state: 'succeeded',
                    value: { tools: normalizeRoleMcpDiscovery((await this.host.operationTools(claim, signal)).tools) },
                });
            }
            const tools = normalizeRoleMcpDiscovery((await this.host.operationTools(claim, signal)).tools);
            const call = context.call,
                tool = tools.find((item) => item.name === call.name && item.schemaDigest === call.schemaDigest);
            if (!tool || !object(call.arguments)) throw new Error('Инструмент или его схема изменились.');
            boundedMcpJson(call.arguments, limits.argumentsBytes);
            if (!new AjvJsonSchemaValidator().getValidator(tool.inputSchema)(call.arguments).valid)
                throw new Error('Аргументы не соответствуют схеме.');
            await requireFeaturesEnabled(['system_role_mcp', 'tool_catalog'], process.env, globalThis.fetch, signal);
            signal.throwIfAborted();
            dispatched = true;
            await this.request('dispatch', { callId: call.id, proof }, signal);
            signal.throwIfAborted();
            return await this.receipt(body.callId, proof, {
                state: 'succeeded',
                value: normalizeRoleMcpOutput(await this.host.operationCall(claim, tool.name, call.arguments, signal)),
            });
        } catch {
            if (claim) await this.host.closeOperationSession(claim).catch(() => {});
            const result: RoleMcpExecutionResult = {
                state: dispatched ? 'unknown' : 'failed',
                message: dispatched
                    ? 'Результат вызова MCP не подтверждён. Повтор не выполнен.'
                    : 'MCP недоступен или не подтвердил выбранный инструмент и аргументы.',
            };
            return dispatched && proof ? await this.receipt(body.callId, proof, result) : result;
        } finally {
            req.off('aborted', abort);
            res.off('close', abort);
        }
    }
    @Post('close')
    async close(@Headers('x-neurocenter-internal') token: string, @Body() body: unknown) {
        this.token(token);
        if (!object(body) || Object.keys(body).sort().join(',') !== 'package,sessionId' || !uuid(body.sessionId))
            throw new ForbiddenException();
        await this.host.closeOperationSession(roleHostedPackage(body.package, body.sessionId));
        return { closed: true };
    }
}
