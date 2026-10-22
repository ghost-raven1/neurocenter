import { Controller, Get, Header, Req, Res, NotFoundException } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response } from 'express';
import {panelOrigin,publicApiOrigin} from '../security/browser-security';
import { BridgeSupplyService, bridgeRequest } from './bridge-supply.service';
import type { IBridgeConfiguration } from './bridge-supply.types';

/**
 * Установщики используют проверенную поставку и доверенный адрес Gateway.
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
    public async configuration(@Req() req: Request, @Res() res: Response): Promise<void> {
        await bridgeRequest(req, res, async signal => {
            const origin = publicApiOrigin(), local = await this.supply.developmentSupply(signal);
            if (signal.aborted) { return; }
            const configuration: IBridgeConfiguration = { origin };
            if (local) {
                configuration.devSupply = { version: local.version, buildId: local.buildId, targets: local.artifacts.map(artifact => artifact.target) };
            }
            res.setHeader('cache-control', 'no-store');
            res.json(configuration);
        });
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

    /** Подключение использует установленный runtime и не требует доступной поставки ассетов. */
    @Get('connect.sh')
    public async connectScript(@Req() req: Request, @Res() res: Response): Promise<void> {
        await this.script('connect.sh', req, res);
    }

    /** Подключение существующего моста из PowerShell без повторного скачивания архива. */
    @Get('connect.ps1')
    public async connectWindowsScript(@Req() req: Request, @Res() res: Response): Promise<void> {
        await this.script('connect.ps1', req, res);
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

    /** Проверенная imported версия либо явная локальная host-сборка в development. */
    @Get('runtime/:file')
    public async runtime(@Req() req: Request, @Res() res: Response): Promise<void> {
        await bridgeRequest(req, res, signal => req.query.download === '1'
            ? this.supply.runtime(req.params.file, signal, res, true) : this.supply.runtime(req.params.file, signal, res));
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
            const selected = bridge ? req.query.version : undefined;
            if (selected !== undefined && (typeof selected !== 'string' || !/^\d+\.\d+\.\d+$/.test(selected))) {
                throw new NotFoundException('Версия установщика моста не найдена.');
            }
            // An archive carried to another computer keeps its matching installer after the head changes.
            const version = bridge ? (await (selected === undefined ? this.supply.supply(signal) : this.supply.supply(signal, selected))).version : undefined;
            if (signal.aborted || res.destroyed) { return; }
            let script = (await this.read(file)).toString('utf8');
            if (signal.aborted || res.destroyed) { return; }
            const connection = file === 'connect.sh' || file === 'connect.ps1';
            for (const [token, helper] of [['__BRIDGE_CONTEXT__', 'context.cjs'], ['__BRIDGE_CONNECT__', 'connect.cjs']]) {
                const count = script.split(token).length - 1;
                if ((connection || count > 0) && count !== 1) { throw new NotFoundException('Шаблон подключения моста недоступен.'); }
                if (count) {
                    const text = (await this.read(helper)).toString('utf8');
                    if (signal.aborted || res.destroyed) { return; }
                    script = script.replace(token, () => text);
                }
            }
            if (bridge) {
                if (script.split('__BRIDGE_VERSION__').length !== 2) { throw new NotFoundException('Шаблон установщика моста недоступен.'); }
                script = script.replace('__BRIDGE_VERSION__', version!);
            }
            if (signal.aborted || res.destroyed) { return; }
            const quote = (value:string):string => value.replace(/'/g,file.endsWith('.sh')?"'\"'\"'":"''");
            script = script.replace(/__BASE_URL__/g, () => quote(`${publicApiOrigin()}/api/bridge`))
                .replace(/__SITE_URL__/g, () => quote(panelOrigin()))
                .replace(/__RECONNECT__/g, req.query.reconnect === '1' ? '1' : '0');
            if (/__(?:BRIDGE_[A-Z_]+|BASE_URL|SITE_URL|RECONNECT)__/.test(script)) { throw new NotFoundException('Шаблон подключения моста недоступен.'); }
            res.setHeader('cache-control', 'no-store');
            res.setHeader('content-type', file.endsWith('.sh') ? 'text/x-shellscript; charset=utf-8' : 'text/plain; charset=utf-8');
            if (req.query.download === '1') { res.setHeader('content-disposition', `attachment; filename="${file}"`); }
            res.send(script);
        });
    }
}
