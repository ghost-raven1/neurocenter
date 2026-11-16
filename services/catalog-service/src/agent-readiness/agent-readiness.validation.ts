import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { object, request, revision, sha } from '../agents/agent-validation';
import { validateModelId } from '../models/model-validation';
import type { IStartAgentTrial } from './agent-readiness.interfaces';

export const trialHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Consent is part of the immutable idempotency input; omission never grants a tool permission. */
export function startAgentTrial(raw: unknown): IStartAgentTrial {
    const body = object(raw, [
        'requestId',
        'expectedRevision',
        'expectedAgentPin',
        'modelId',
        'expectedModelPin',
        'tool',
        'toolConsent',
        'executionSurface',
    ]);
    request(body.requestId);
    revision(body.expectedRevision);
    const rawSurface = body.executionSurface;
    if (rawSurface !== undefined && rawSurface !== 'server_chat' && rawSurface !== 'opencode')
        throw new BadRequestException('Передайте допустимую поверхность испытания.');
    const surface: IStartAgentTrial['executionSurface'] =
        rawSurface === undefined ? 'server_chat' : (rawSurface as 'server_chat' | 'opencode');
    if (
        !sha(body.expectedAgentPin) ||
        typeof body.tool !== 'string' ||
        !['none', 'project_search'].includes(body.tool) ||
        (body.toolConsent !== undefined && typeof body.toolConsent !== 'boolean') ||
        (body.tool === 'none' && body.toolConsent === true)
    )
        throw new BadRequestException('Передайте актуальные pins и разрешённый режим испытания.');
    // The opencode surface is a contentful probe: it never routes through a project chat model, so the
    // model pin is neither required nor allowed. server_chat keeps the exact prior contract.
    if (surface === 'opencode') {
        if (body.modelId !== undefined || body.expectedModelPin !== undefined)
            throw new BadRequestException('Испытание OpenCode не привязывается к модели проекта.');
        if (body.tool !== 'none')
            throw new BadRequestException('Испытание OpenCode выполняется без проектных инструментов.');
        return {
            requestId: body.requestId,
            expectedRevision: body.expectedRevision,
            expectedAgentPin: body.expectedAgentPin,
            tool: 'none',
            toolConsent: false,
            executionSurface: 'opencode',
        };
    }
    if (!sha(body.expectedModelPin))
        throw new BadRequestException('Передайте актуальные pins и разрешённый режим испытания.');
    return {
        requestId: body.requestId,
        expectedRevision: body.expectedRevision,
        expectedAgentPin: body.expectedAgentPin,
        modelId: validateModelId(body.modelId),
        expectedModelPin: body.expectedModelPin,
        tool: body.tool as IStartAgentTrial['tool'],
        toolConsent: body.toolConsent === true,
        executionSurface: 'server_chat',
    };
}
