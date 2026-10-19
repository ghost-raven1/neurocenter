/**
 * Контракты SSO-моста (Blitz authorize/token/userinfo + сессионный профиль).
 */

/** Ответ токенового endpoint (/blitz/oauth/te, grant_type=authorization_code). */
export interface ITokenResponse {
    access_token: string;
    token_type?: string;
    expires_in?: number;
}

/** Профиль из userinfo endpoint (/blitz/oauth/me). */
export interface IProfile {
    email_verified?: boolean;
    sub?: string;
    uid?: string | number;
    email?: string;
    mail?: string;
    name?: string;
    preferred_username?: string;
    dn?: string;
}

/** Профиль пользователя, отдаваемый фронтенду (совпадает с IUserInfo фронта). */
export interface IBridgeUser {
    id: string;
    principalName: string;
    email: string;
    projectRoles: Array<{ projectId: string; projectName: string; role: string }>;
    displayName: string;
    userRoles: string[];
    activeRole: string;
    routePermissions: string[];
}

/** Ответ GET /auth/me (совпадает с IAuthMe фронта). */
export interface IAuthMeResponse {
    user: IBridgeUser;
    policies: Record<string, string[]>;
}

/** Параметры OAuth-клиента (env). */
export interface IOauthBridgeConfig {
    ssoHost: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    scope: string;
    panelUrl: string;
    ssoDisabled: boolean;
}
