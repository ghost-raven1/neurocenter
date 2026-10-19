import { Body, Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';

import { AuthService } from './auth.service';
import { IAuthMeResponse } from './interface';
import { SessionService } from './session.service';
import {loginReturn} from './login-return';
import {OAuthTransactions} from './oauth-transactions.service';

const STATE_COOKIE = 'oauth_state';
const SESSION_COOKIE = 'bridge_session';
const RETURN_COOKIE = 'oauth_return';

/**
 * Контроллер SSO-входа через Blitz: login/callback/me/logout/switch-role.
 * Редиректы (login/callback/logout) — HTTP-302; me/switch-role — JSON.
 */
@Controller('auth')
export class AuthController {
    constructor(
        private readonly auth: AuthService,
        private readonly sessions: SessionService,
        private readonly transactions: OAuthTransactions,
    ) {}

    private cookieOptions(){return {httpOnly:true,secure:new URL(this.auth.panelUrl).protocol==='https:',sameSite:'lax' as const,path:'/'};}

    /**
     * Инициирует вход: 302 на Blitz authorize (или mock-сессия в dev).
     *
     * @returns {void}
     */
    @Get('login')
    public async login(@Req() req: Request, @Res() res: Response): Promise<void> {
        const target=loginReturn(req.query.returnTo);
        if (this.auth.ssoDisabled) {
            res.cookie(SESSION_COOKIE, this.sessions.create(await this.auth.mockUser()), {...this.cookieOptions(),maxAge:this.sessions.ttlMs});
            res.redirect(this.auth.panelUrl+target);
            return;
        }

        const {state,challenge} = this.transactions.create(target);
        // Lax позволяет вернуть state после перехода с SSO; срок ограничен десятью минутами.
        res.cookie(STATE_COOKIE, state, {...this.cookieOptions(),maxAge:600000});
        res.redirect(this.auth.authorizeUrl(state,challenge));
    }

    /**
     * OAuth-callback: валидация state, обмен кода на токен+профиль, сессия, 302 на панель.
     *
     * @returns {Promise<void>}
     */
    @Get('callback')
    public async callback(@Req() req: Request, @Res() res: Response): Promise<void> {
        const cookies = req.cookies ?? {};
        const query = req.query as unknown as Record<string, string | undefined>;
        const panel = this.auth.panelUrl;

        if (this.auth.ssoDisabled) {
            res.redirect(`${panel}/`);
            return;
        }

        const transaction=this.transactions.consume(query.state,cookies[STATE_COOKIE]);
        if (!transaction) {
            res.redirect(`${panel}/?login_error=state`);
            return;
        }

        res.clearCookie(STATE_COOKIE,this.cookieOptions());
        res.clearCookie(RETURN_COOKIE,this.cookieOptions());
        if(query.error){res.redirect(`${panel}/?login_error=denied`);return;}

        try {
            const user = await this.auth.exchangeCode(query.code ?? '',transaction.verifier);

            res.cookie(SESSION_COOKIE, this.sessions.create(user), {...this.cookieOptions(),maxAge:this.sessions.ttlMs});
            res.redirect(panel+transaction.returnTo);
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error('[oauth2-bridge] code exchange failed:', error instanceof Error?error.name:'Unavailable');
            res.redirect(`${panel}/?login_error=exchange`);
        }
    }

    /**
     * Текущий пользователь (GET /auth/me) для фронта.
     *
     * @returns {void}
     */
    @Get('me')
    public async me(@Req() req: Request, @Res() res: Response): Promise<void> {
        const cookies = req.cookies ?? {};
        const user = this.sessions.get(cookies[SESSION_COOKIE]);

        if (!user) {
            res.status(401).json({ message: 'Unauthorized' });
            return;
        }

        await this.auth.refreshAccess(user);
        const body: IAuthMeResponse = {
            user,
            policies: this.auth.policies(user.activeRole),
        };

        res.status(200).json(body);
    }

    /**
     * Выход: удаление сессии + 302 (Blitz logout в prod / на панель в dev).
     *
     * @returns {void}
     */
    @Get('logout')
    public logout(@Req() req: Request, @Res() res: Response): void {
        const cookies = req.cookies ?? {};

        this.sessions.remove(cookies[SESSION_COOKIE]);
        res.clearCookie(SESSION_COOKIE);
        res.redirect(this.auth.ssoDisabled ? `${this.auth.panelUrl}/` : this.auth.logoutUrl());
    }

    /** Выход интерфейса подтверждается отзывом серверной сессии до очистки состояния фронта. */
    @Post('logout')
    public logoutJson(@Req() req:Request,@Res() res:Response):void {
        this.sessions.remove(req.cookies?.[SESSION_COOKIE]);
        res.clearCookie(SESSION_COOKIE);
        res.status(200).json(this.auth.ssoDisabled?{}:{redirectUrl:this.auth.logoutUrl()});
    }

    /**
     * Смена роли только среди актуальных назначений пользователя.
     *
     * @returns {void}
     */
    @Post('switch-role')
    public async switchRole(@Req() req: Request, @Res() res: Response, @Body() payload: { role?: string }): Promise<void> {
        const cookies = req.cookies ?? {};
        const user = this.sessions.get(cookies[SESSION_COOKIE]);

        if (!user) {
            res.status(401).json({ message: 'Unauthorized' });
            return;
        }

        // Переключаем активную роль: права (routePermissions) фильтруются по роли.
        await this.auth.refreshAccess(user);
        this.auth.applyRole(user, payload?.role ?? user.activeRole);

        const body: IAuthMeResponse = {
            user,
            policies: this.auth.policies(user.activeRole),
        };

        res.status(200).json(body);
    }
}
