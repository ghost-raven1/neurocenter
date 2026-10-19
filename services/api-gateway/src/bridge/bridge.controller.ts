import { Controller, Get, Req, Res, NotFoundException } from '@nestjs/common';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response } from 'express';
import {panelOrigin} from '../security/browser-security';

/**
 * Каталог раздачи артефактов моста neurocenter-asset-sync (`/bridge/*`).
 *
 * `GET /bridge/install.sh` — отдаёт установочный скрипт с доверенным PANEL_URL.
 *
 * `GET /bridge/neurocenter-asset-sync.tgz` — переносимый архив моста.
 */
@Controller(['bridge', 'api/bridge'])
export class BridgeController {
    private readonly dir: string;

    constructor() {
        this.dir = process.env.BRIDGE_DIST || path.resolve(
            __dirname,
            '..',
            '..',
            '..',
            '..',
            'bridge-dist',
        );
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
        const template = (await this.read('install.sh')).toString('utf8');
        const baseUrl = `${panelOrigin()}/api/bridge`;
        const script = template.replace(/__BASE_URL__/g, baseUrl).replace(/__RECONNECT__/g, req.query.reconnect === '1' ? '1' : '0');

        res.setHeader('content-type', 'text/x-shellscript; charset=utf-8');
        res.send(script);
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
    public async installWindowsBridge(@Req() req:Request,@Res() res:Response):Promise<void>{await this.script('install.ps1',req,res);}

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

    /**
     * Отдаёт собранный архив моста.
     *
     * @param res - ответ.
     * @returns {Promise<void>}
     */
    @Get('neurocenter-asset-sync.tgz')
    public async artifact(@Res() res: Response): Promise<void> {
        const buf = await this.read('neurocenter-asset-sync.tgz');

        res.setHeader('content-type', 'application/gzip');
        res.setHeader('content-disposition', 'attachment; filename="neurocenter-asset-sync.tgz"');
        res.send(buf);
    }

    /** Готовый runtime передаётся потоком: несколько скачиваний не держат архивы целиком в памяти. */
    @Get('runtime/:file')
    public async runtime(@Req() req: Request, @Res() res: Response): Promise<void> {
        const file = req.params.file;
        if (!/^neurocenter-asset-sync-(darwin|linux|windows)-(x64|arm64)(-musl)?-\d+\.\d+\.\d+\.tgz(\.sha256|\.json)?$/.test(file)) {
            throw new NotFoundException('Автономный пакет для этой платформы не найден.');
        }
        const directory = path.join(this.dir, 'runtime');
        const info = await stat(path.join(directory, file)).catch(() => null);
        if (!info?.isFile()) { throw new NotFoundException('Автономный пакет для этой платформы ещё не подготовлен.'); }
        res.setHeader('cache-control', 'no-store');
        res.setHeader('content-type', file.endsWith('.sha256') ? 'text/plain; charset=utf-8' : file.endsWith('.json') ? 'application/json' : 'application/gzip');
        res.sendFile(file, { root: directory }, error => { if (error && !res.headersSent) { res.status(404).json({ message: 'Пакет недоступен. Повторите скачивание.' }); } });
    }

    private async read(file: string): Promise<Buffer> {
        try {
            return await readFile(path.join(this.dir, file));
        } catch {
            throw new NotFoundException(`bridge artifact not found: ${file}`);
        }
    }

    /** Подставляет адрес площадки с проверкой прокси-заголовков. */
    private async script(file: string, req: Request, res: Response): Promise<void> {
        const script = (await this.read(file)).toString('utf8').replace(/__BASE_URL__/g, `${panelOrigin()}/api/bridge`).replace(/__RECONNECT__/g, req.query.reconnect === '1' ? '1' : '0');
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.send(script);
    }
}
