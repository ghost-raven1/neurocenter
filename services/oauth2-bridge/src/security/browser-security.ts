import type { Request, Response, NextFunction } from 'express';

/** Origin сравнивается с настройкой площадки, а не с подделываемыми proxy-заголовками. */
export function panelOrigin(): string {
    const panel = new URL(process.env.PANEL_URL || 'http://localhost:5173');
    if (!['http:', 'https:'].includes(panel.protocol) || panel.username || panel.password) {
        throw new Error('Некорректный PANEL_URL');
    }
    return panel.origin;
}
export function allowBrowserOrigin(origin: unknown): boolean {
    return origin === undefined || origin === panelOrigin();
}
/** Несессионные Bearer-клиенты сохраняют контракт; cookie-запрос требует нестандартный заголовок и доверенный Origin. */
export function browserSecurity(req: Request, res: Response, next: NextFunction): void {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.path === '/auth/logout';
    if (unsafe && /(?:^|;\s*)bridge_session=/.test(req.headers.cookie || '')) {
        if (
            req.headers['x-neurocenter-request'] !== '1' ||
            !allowBrowserOrigin(req.headers.origin) ||
            req.headers['sec-fetch-site'] === 'cross-site'
        ) {
            res.status(403).json({ message: 'Запрос должен быть отправлен из интерфейса Нейроцентра.' });
            return;
        }
    }
    next();
}
