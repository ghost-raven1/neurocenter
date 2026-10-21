import { Controller, Get, Header, Req, Res, NotFoundException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response } from 'express';
import {panelOrigin,publicApiOrigin} from '../security/browser-security';
import { BridgeSupplyService, bridgeRequest } from './bridge-supply.service';

/**
 * Установщики используют импортированный neurocenter-assets и доверенный адрес Gateway.
 */
@Controller(['bridge', 'api/bridge'])
export class BridgeController {
    private readonly dir: string;

    constructor(private readonly supply: BridgeSupplyService) {
        this.dir = process.env.BRIDGE_TEMPLATES_DIR || path.resolve(
            __dirname,
            '..',
            '..',
            '..',
            '..',
            'bridge-dist',
        );
    }

    /** Runtime-настройка для готового frontend: внешний адрес раздачи не зависит от адреса UI. */
    @Get('config')
    @Header('Cache-Control','no-store')
    public configuration():{origin:string} {
        return {origin:publicApiOrigin()};
    }

    /**
     * Отдаёт install.sh с подставленным базовым URL раздачи.
     *
     * @param req - запрос установщика.
     * @param res - ответ.
     * @returns {Promise<void>}
     */
    @Get('install.sh')
    public async installScript(@Req() req: Request, @Res() res: Response): Promise<void> {
        await this.script('install.sh', req, res, true);
    }

    /**
     * Отдаёт установщик OpenCode для текущей площадки.
     *
     * @param res - ответ.
     * @returns {Promise<void>}
     */
    @Get('install_opencode.sh')
    public async installOpenCodeScript(@Req() req: Request, @Res() res: Response): Promise<void> {
        await this.script('install_opencode.sh', req, res);
    }

    /** Первичная регистрация локального MCP в Windows. */
    @Get('install.ps1')
    public async installWindowsBridge(@Req() req:Request,@Res() res:Response):Promise<void>{await this.script('install.ps1',req,res,true);}

    /** Отдаёт установщик для PowerShell без зависимости от Bash. */
    @Get('install_opencode.ps1')
    public async installOpenCodeWindows(@Req() req: Request, @Res() res: Response): Promise<void> {
        await this.script('install_opencode.ps1', req, res);
    }

    /** Раздаёт подготовленные архивы и контрольные суммы только из каталога установки. */
    @Get('opencode/:file')
    public async openCodeArtifact(@Req() req: Request, @Res() res: Response): Promise<void> {
        const file = req.params.file;
        if (!/^opencode-(darwin|linux|windows)-(x64|arm64)(-baseline)?(-musl)?-\d+\.\d+\.\d+\.tgz(\.sha256)?$/.test(file)) {
            throw new NotFoundException('Пакет для этой платформы не найден');
        }
        res.setHeader('content-type', file.endsWith('.sha256') ? 'text/plain' : 'application/gzip');
        res.send(await this.read(`opencode/${file}`));
    }

    /** Только импортированная неизменяемая версия; локального архива или внешнего fallback нет. */
    @Get('runtime/:file')
    public async runtime(@Req() req: Request, @Res() res: Response): Promise<void> {
        await bridgeRequest(req, res, signal => this.supply.runtime(req.params.file, signal, res));
    }

    private async read(file: string): Promise<Buffer> {
        try {
            return await readFile(path.join(this.dir, file));
        } catch {
            throw new NotFoundException(`bridge artifact not found: ${file}`);
        }
    }

    /** Разделяет адрес скачивания и идентичность площадки, сохраняя существующее подключение моста. */
    private async script(file: string, req: Request, res: Response, bridge = false): Promise<void> {
        await bridgeRequest(req, res, async signal => {
            const version = bridge ? (await this.supply.supply(signal)).version : undefined;
            if (signal.aborted) { return; }
            let script = (await this.read(file)).toString('utf8');
            if (bridge) {
                if (script.split('__BRIDGE_VERSION__').length !== 2) { throw new NotFoundException('Шаблон установщика моста недоступен.'); }
                script = script.replace('__BRIDGE_VERSION__', version!);
            }
            if (signal.aborted) { return; }
            const quote = (value:string):string => value.replace(/'/g,file.endsWith('.sh')?"'\"'\"'":"''");
            script = script.replace(/__BASE_URL__/g, () => quote(`${publicApiOrigin()}/api/bridge`))
                .replace(/__SITE_URL__/g, () => quote(panelOrigin()))
                .replace(/__RECONNECT__/g, req.query.reconnect === '1' ? '1' : '0');
            res.setHeader('cache-control', 'no-store');
            res.setHeader('content-type', file.endsWith('.sh') ? 'text/x-shellscript; charset=utf-8' : 'text/plain; charset=utf-8');
            res.send(script);
        });
    }
}
