import { ForbiddenException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

import { roleRoutes, rolePolicies } from './roles';
import { IBridgeUser, IOauthBridgeConfig, IProfile, ITokenResponse } from './interface';

/**
 * Логика SSO/Blitz code-flow: authorize URL, обмен кода на токен, userinfo,
 * logout URL. В режиме SSO_DISABLE — без взаимодействия с IdP (mock user).
 */
@Injectable()
export class AuthService {
    private readonly config: IOauthBridgeConfig;
    private readonly http: AxiosInstance;

    constructor(configService: ConfigService) {
        const ssoHost = (configService.get<string>('SSO_HOST') || '').replace(/\/+$/, '');
        const panelUrl = (configService.get<string>('PANEL_URL') || 'http://localhost:5173').replace(/\/+$/, '');

        this.config = {
            ssoHost,
            clientId: configService.get<string>('SSO_CLIENT_ID') || '',
            clientSecret: configService.get<string>('SSO_CLIENT_SECRET') || '',
            redirectUri: configService.get<string>('REDIRECT_URI') || '',
            scope: configService.get<string>('SSO_SCOPE') || 'openid profile email',
            panelUrl,
            ssoDisabled: (configService.get<string>('SSO_DISABLE') || 'false') === 'true',
        };

        this.http = axios.create({ timeout: 15000, maxRedirects: 0 });
    }

    /**
     * Формирует URL authorize-эндпоинта Blitz с PKCE S256.
     *
     * @param {string} state - CSRF-state
     * @returns {string}
     */
    public authorizeUrl(state: string, challenge: string): string {
        const query = new URLSearchParams({
            response_type: 'code',
            client_id: this.config.clientId,
            redirect_uri: this.config.redirectUri,
            scope: this.config.scope,
            state,
            code_challenge: challenge,
            code_challenge_method: 'S256',
        });

        return `${this.config.ssoHost}/blitz/oauth/ae?${query.toString()}`;
    }

    /**
     * URL logout на стороне IdP (Blitz).
     *
     * @returns {string}
     */
    public logoutUrl(): string {
        const query=new URLSearchParams({client_id:this.config.clientId,post_logout_redirect_uri:this.config.panelUrl+'/'});
        return `${this.config.ssoHost}/blitz/oauth/logout?${query}`;
    }

    /**
     * Mock-пользователь для dev-режима без SSO.
     *
     * @returns {IBridgeUser}
     */
    public async mockUser(): Promise<IBridgeUser> {
        return this.refreshAccess({
            id: 'dev-user', principalName: process.env.DEV_USER_EMAIL || 'dev@localhost',
            email: process.env.DEV_USER_EMAIL || 'dev@localhost', displayName: 'Локальный администратор',
            userRoles: [], activeRole: '', routePermissions: [], projectRoles: [],
        });
    }

    /**
     * Применяет активную роль: переопределяет activeRole и routePermissions
     * (admin — полный набор, остальные — базовые, без admin-only разделов).
     *
     * @param {IBridgeUser} user - профиль (мутируем in-place, чтобы сохранить в сессии)
     * @param {string} role - активная роль
     * @returns {IBridgeUser} тот же профиль с обновлёнными правами
     */
    public applyRole(user: IBridgeUser, role: string): IBridgeUser {
        if (!user.userRoles.includes(role)) { throw new ForbiddenException('Эта роль не назначена пользователю.'); }
        user.activeRole = role;
        user.routePermissions = roleRoutes(role);

        return user;
    }

    /**
     * Обмен авторизационного кода на access-токен и профиль.
     *
     * @param {string} code - authorization code из callback
     * @returns {Promise<IBridgeUser>}
     */
    public async exchangeCode(code: string, verifier: string): Promise<IBridgeUser> {
        if(!code||code.length>4096||/[\x00-\x1f]/.test(code)){throw new ForbiddenException('SSO не вернул допустимый код.');}
        // Blitz ожидает client_secret_basic; компоненты кодируются по OAuth 2.0, §2.3.1.
        const credentials=[this.config.clientId,this.config.clientSecret].map(value=>new URLSearchParams({v:value}).toString().slice(2)).join(':');
        const tokenResponse = await this.http.post<ITokenResponse>(
            `${this.config.ssoHost}/blitz/oauth/te`,
            new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: this.config.redirectUri,
                code_verifier: verifier,
            }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded',Authorization:'Basic '+Buffer.from(credentials).toString('base64') } },
        );

        if(typeof tokenResponse.data?.access_token!=='string'||!tokenResponse.data.access_token||/[\x00-\x20]/.test(tokenResponse.data.access_token)){throw new ForbiddenException('SSO вернул некорректный access token.');}
        const profileResponse = await this.http.get<IProfile>(`${this.config.ssoHost}/blitz/oauth/me`, {
            headers: { Authorization: `Bearer ${tokenResponse.data.access_token}` },
        });

        return this.refreshAccess(this.mapProfile(profileResponse.data));
    }

    /**
     * Возвращает политики назначенной роли; права читаются из каталога.
     *
     * @returns {Record<string, string[]>}
     */
    public policies(role: string): Record<string, string[]> { return rolePolicies(role); }

    /** Обновляет назначения из каталога; сбой не превращается в административный доступ. */
    public async refreshAccess(user: IBridgeUser): Promise<IBridgeUser> {
        const url = (process.env.CATALOG_SERVICE_URL || 'http://localhost:4100').replace(/\/$/, '');
        try {
            const { data } = await this.http.get<{userRoles:string[];projects:IBridgeUser['projectRoles']}>(`${url}/internal/access/profile`, {
                params:{email:user.email}, headers:{'x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN || ''},
            });
            user.userRoles = data.userRoles;
            user.projectRoles = data.projects;
            const selected = user.userRoles.includes(user.activeRole) ? user.activeRole : user.userRoles[0];
            if (!selected) { throw new ForbiddenException('Администратор ещё не назначил вам роль.'); }
            return this.applyRole(user,selected);
        } catch (error) {
            if (error instanceof ForbiddenException) { throw error; }
            if (axios.isAxiosError(error) && error.response?.status === 403) { throw new ForbiddenException('Учётная запись не добавлена или отключена.'); }
            throw new ServiceUnavailableException('Не удалось проверить назначения ролей.');
        }
    }

    /**
     * Свойство: включён ли dev-режим без SSO.
     */
    public get ssoDisabled(): boolean {
        return this.config.ssoDisabled;
    }

    /**
     * Свойство: URL панели (куда шлём пользователя после входа).
     */
    public get panelUrl(): string {
        return this.config.panelUrl;
    }

    private mapProfile(profile: IProfile): IBridgeUser {
        if(!profile||typeof profile!=='object'||profile.email_verified===false){throw new ForbiddenException('SSO не подтвердил профиль пользователя.');}
        const rawId = profile.sub ?? profile.uid ?? profile.preferred_username;
        if(!(typeof rawId==='string'&&!!rawId.trim()&&rawId.length<=512)&&!(typeof rawId==='number'&&Number.isSafeInteger(rawId)&&rawId>=0)){throw new ForbiddenException('SSO не вернул идентификатор пользователя.');}
        const id = String(rawId);

        const rawEmail=profile.email??profile.mail;
        const email = typeof rawEmail==='string'?rawEmail.trim().toLowerCase():'';
        if (!/^[^\s@]+@[^\s@]+$/.test(email)) { throw new ForbiddenException('SSO не вернул почту пользователя.'); }
        const name = typeof profile.name === 'string' ? profile.name.trim() : '';
        // An optional IdP label must fit the durable identity boundary without blocking a valid login.
        const displayName = name && name.length <= 512 && !/[\x00-\x1f\x7f]/.test(name) ? name : email;
        return {
            id, email, principalName:email,
            displayName,
            userRoles: [], activeRole: '', routePermissions: [], projectRoles: [],
        };
    }
}
