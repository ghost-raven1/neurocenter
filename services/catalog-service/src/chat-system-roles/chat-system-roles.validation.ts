import { BadRequestException } from '@nestjs/common';
import { chatProject } from '../system-role-chat/system-role-chat.validation';
import type { IChatSystemRoleOrigin } from './chat-system-roles.interfaces';
/** Only canonical saved chat references are accepted; content and caller identity are never copied. */
export function chatSystemRoleOrigin(raw: unknown): IChatSystemRoleOrigin {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new BadRequestException('Выберите сохранённый исходный чат.');
    const value = raw as Record<string, unknown>,
        projectId = chatProject(value.projectId);
    if (
        Object.keys(value).some((key) => !['kind', 'originId', 'projectId'].includes(key)) ||
        !['model-chat', 'project-chat'].includes(String(value.kind)) ||
        typeof value.originId !== 'string' ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.originId) ||
        (value.kind === 'project-chat' && !projectId)
    )
        throw new BadRequestException('Выберите точный чат и его проект.');
    return { kind: value.kind as IChatSystemRoleOrigin['kind'], originId: value.originId, projectId };
}
