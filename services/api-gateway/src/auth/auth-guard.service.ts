import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';
import type { Request } from 'express';

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
    deviceId?:string;
    email: string;
    activeRole: string;
    userId: string;
    principalName: string;
    userRoles: string[];
    policies: Record<string, string[]>;
}

/**
 * Auth-guard gateway: единый источник истины — oauth2-bridge (`/auth/me`).
 * - Есть валидная сессия / SSO-off (bridge вернул 200) → профиль.
 * - Нет / bridge вернул 401 → null (401).
 * Режим dev без SSO: bridge сам решает (всегда 200) → guard прозрачен, app не «запирает» после logout.
 *
 * @param {Request} req - входящий запрос (cookie пересылается bridge)
 * @returns {Promise<IAuthPayload | null>}
 */
@Injectable()
export class AuthGuardService {
    private readonly authUrl: string;
    private readonly catalogUrl:string;
    private readonly http: AxiosInstance;

    constructor(configService: ConfigService) {
        this.authUrl = (configService.get<string>('AUTH_SERVICE_URL') || 'http://localhost:22222').replace(/\/+$/, '');
        this.catalogUrl=(configService.get<string>('CATALOG_SERVICE_URL')||'http://localhost:4100').replace(/\/+$/,'');
        this.http = axios.create({ timeout: 10000, validateStatus: () => true });
    }

    public async authenticate(req: Request): Promise<IAuthPayload | null> {
        const cookie = req.headers['cookie'];

        try {
            if(req.headers.authorization){
                if(!/^Bearer [a-f0-9]{64}$/.test(req.headers.authorization)){return null;}
                const response=await this.http.post(`${this.catalogUrl}/internal/device-channel/identity`,{},{headers:{authorization:req.headers.authorization,'x-neurocenter-internal':process.env.NEUROCENTER_INTERNAL_TOKEN||''}});
                if(response.status!==201&&response.status!==200){return null;}
                const d=response.data as {id:string;email:string;role:string};
                return {deviceId:d.id,email:d.email,activeRole:d.role,userId:d.email,principalName:d.email,userRoles:[d.role],policies:{}};
            }
            const response = await this.http.get<unknown>(`${this.authUrl}/auth/me`, {
                headers: cookie ? { cookie } : {},
                timeout: 10000,
            });

            if (response.status !== 200) {
                return null;
            }

            const data = response.data as IAuthMeResponse;

            return {
                email: data.user.email,
                activeRole: data.user.activeRole,
                userId: data.user.id,
                principalName: data.user.principalName,
                userRoles: data.user.userRoles,
                policies: data.policies,
            };
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error('[api-gateway] auth check failed:',error instanceof Error?error.message:'unavailable');
            return null;
        }
    }
}
