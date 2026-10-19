import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';

import { IBridgeUser } from './interface';

/**
 * In-memory хранилище сессий (token → user), O(1) по Map. Для dev/одного контейнера;
 * при horizontal scale заменить на Redis (интерфейс тот же).
 */
@Injectable()
export class SessionService {
    private readonly sessions = new Map<string, {user:IBridgeUser;expiresAt:number}>();
    readonly ttlMs:number;

    constructor(){
        const seconds=Number(process.env.SESSION_TTL_SECONDS||28800);
        if(!Number.isSafeInteger(seconds)||seconds<60||seconds>86400){throw new Error('SESSION_TTL_SECONDS должен быть от 60 до 86400.');}
        this.ttlMs=seconds*1000;
    }

    /**
     * Создаёт сессию.
     *
     * @param {IBridgeUser} user - профиль
     * @returns {string} токен сессии
     */
    public create(user: IBridgeUser): string {
        const token = randomBytes(24).toString('hex');

        const now=Date.now();
        for(const [key,value] of this.sessions){if(value.expiresAt<=now){this.sessions.delete(key);}}
        this.sessions.set(token, {user,expiresAt:now+this.ttlMs});

        return token;
    }

    /**
     * Возвращает профиль по токену сессии.
     *
     * @param {string | undefined} token
     * @returns {IBridgeUser | null}
     */
    public get(token: string | undefined): IBridgeUser | null {
        if (!token) {
            return null;
        }

        const entry=this.sessions.get(token);
        if(!entry){return null;}
        if(entry.expiresAt<=Date.now()){this.sessions.delete(token);return null;}
        return entry.user;
    }

    /**
     * Удаляет сессию.
     *
     * @param {string | undefined} token
     * @returns {void}
     */
    public remove(token: string | undefined): void {
        if (!token) {
            return;
        }

        this.sessions.delete(token);
    }
}
