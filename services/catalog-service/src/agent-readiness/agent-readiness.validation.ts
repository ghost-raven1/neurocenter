import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { object, request, revision, sha } from '../agents/agent-validation';
import { validateModelId } from '../models/model-validation';
import type { StartAgentTrial } from './agent-readiness.types';

export const trialHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Consent is part of the immutable idempotency input; omission never grants a tool permission. */
export function startAgentTrial(raw: unknown): StartAgentTrial {
    const body = object(raw, [
        'requestId',
        'expectedRevision',
        'expectedAgentPin',
        'modelId',
        'expectedModelPin',
        'tool',
        'toolConsent',
    ]);
    request(body.requestId);
    revision(body.expectedRevision);
    if (
        !sha(body.expectedAgentPin) ||
        !sha(body.expectedModelPin) ||
        typeof body.tool !== 'string' ||
        !['none', 'project_search'].includes(body.tool) ||
        (body.toolConsent !== undefined && typeof body.toolConsent !== 'boolean') ||
        (body.tool === 'none' && body.toolConsent === true)
    )
        throw new BadRequestException('Передайте актуальные pins и разрешённый режим испытания.');
    return {
        requestId: body.requestId,
        expectedRevision: body.expectedRevision,
        expectedAgentPin: body.expectedAgentPin,
        modelId: validateModelId(body.modelId),
        expectedModelPin: body.expectedModelPin,
        tool: body.tool as StartAgentTrial['tool'],
        toolConsent: body.toolConsent === true,
    };
}
