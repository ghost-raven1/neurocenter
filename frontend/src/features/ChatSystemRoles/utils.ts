import type { IChatRoleOrigin } from './interfaces';

export const chatRoleOriginKey = (origin: IChatRoleOrigin): string =>
    JSON.stringify([origin.kind, origin.originId, origin.projectId]);
