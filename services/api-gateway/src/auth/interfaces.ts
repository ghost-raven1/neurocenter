/** Профиль, который bridge отдаёт на /auth/me. */
export interface IBridgeUser {
    id: string;
    principalName: string;
    email: string;
    activeRole: string;
    displayName: string;
    userRoles: string[];
    routePermissions: string[];
}

/** Ответ GET /auth/me (совпадает с IAuthMe фронта). */
export interface IAuthMeResponse {
    user: IBridgeUser;
    policies: Record<string, string[]>;
}

/** Вытянутый guard'ом профиль для инжекта в downstream. */
export interface IAuthPayload {
    deviceId?: string;
    email: string;
    activeRole: string;
    userId: string;
    principalName: string;
    userRoles: string[];
    policies: Record<string, string[]>;
}