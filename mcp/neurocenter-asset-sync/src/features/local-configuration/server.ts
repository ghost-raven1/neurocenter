import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { configurationPage } from './page.js';
import { configurationStatus, readConfiguration, saveConfiguration } from './state.js';
import type { ConfigurationContext } from './context.js';
import { validateConfigurationValues } from './schema.js';
import { projectLocalEmbeddingFields } from './project-local-embedding.js';
const active = new Map<string,{expiresAt:string;close:()=>void}>();
const token = () => randomBytes(32).toString('base64url');
async function body(request: IncomingMessage): Promise<Record<string,unknown>> {
    if (request.headers['content-type'] !== 'application/json') {throw new Error();}
    let size = 0; const chunks: Buffer[] = [];
    for await (const chunk of request) {size += chunk.length; if (size > 64 * 1024) {throw new Error();} chunks.push(chunk);}
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!result || typeof result !== 'object' || Array.isArray(result)) {throw new Error();} return result;
}
function json(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}); response.end(JSON.stringify(value));
}
/** Loopback живёт отдельно от очереди. Ни URL, ни токен, ни введённые данные не выходят на сервер площадки. */
export async function startConfigurationSession(context: ConfigurationContext, preparationId: string, expiresAt: string,
    authorizeSave: () => Promise<void>, open: (url:string)=>Promise<boolean>): Promise<void> {
    const previous = active.get(preparationId); if (previous) {return;}
    const bootstrap = token(); const csrf = token(); const nonce = token(); let used = false; let saved = false; let saving = false;
    const initial = await readConfiguration(context); const expectedRevision = initial?.revision ?? null;
    const server = createServer((request,response) => {void (async () => {
        const address = server.address(); if (!address || typeof address === 'string') {throw new Error();}
        const host = `127.0.0.1:${address.port}`; const origin = 'http://' + host;
        if (Date.now() >= Date.parse(expiresAt) || request.headers.host !== host || !['127.0.0.1','::ffff:127.0.0.1'].includes(request.socket.remoteAddress ?? '')) {json(response,403,{message:'Локальная сессия недоступна.'}); return;}
        if (request.method === 'GET' && request.url === '/') {
            response.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff',
                'Content-Security-Policy':`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`});
            response.end(configurationPage.replace('<style>',`<style nonce="${nonce}">`).replace('<script>',`<script nonce="${nonce}">`)); return;
        }
        if (request.method !== 'POST' || request.headers.origin !== origin || request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin') {json(response,403,{message:'Запрос отклонён.'}); return;}
        const input = await body(request);
        if (request.url === '/session' && !used && input.token === bootstrap && Object.keys(input).length === 1) {
            // Резервируем одноразовый токен до первого await: две вкладки не получают одну сессию.
            used = true; await context.assertCurrent();
            json(response,200,{csrf,revision:expectedRevision,expiresAt,name:context.pkg.plugin.name,
                projectLocalEmbeddingFields:projectLocalEmbeddingFields(context.schema),
                fields:context.schema.fields.map(field => ({id:field.id,label:field.label,type:field.type,required:field.required,secret:!!field.secret,configured:Object.hasOwn(initial?.values ?? {},field.id)}))}); return;
        }
        if (request.url !== '/save' || !used || saved || saving || request.headers['x-configuration-csrf'] !== csrf
            || Object.keys(input).some(key => !['updates','remove','expectedRevision'].includes(key)) || input.expectedRevision !== expectedRevision
            || !Array.isArray(input.remove) || input.remove.length > context.schema.fields.length || input.remove.some(id => typeof id !== 'string' || !context.schema.fields.some(field => field.id === id))) {json(response,403,{message:'Запрос отклонён.'}); return;}
        saving = true;
        try {
            const updates = validateConfigurationValues(context.schema,input.updates); const values = {...initial?.values,...updates};
            for (const id of input.remove as string[]) {delete values[id];}
            // После разрешения записи повтор требует нового open-job и нового маркера устаревания статуса.
            saved = true;
            await saveConfiguration(context,values,expectedRevision,authorizeSave,()=>{if(Date.now()>=Date.parse(expiresAt)){throw new Error('Локальная сессия истекла.');}});
            const status = await configurationStatus(context); json(response,200,{ready:status.ready,missingFieldIds:status.missingFieldIds});
        } finally {saving = false;}
    })().catch(() => {if (!response.headersSent) {json(response,400,{message:'Локальная настройка недоступна. Откройте форму заново.'});} else {response.end();}});});
    server.requestTimeout = 5000; server.headersTimeout = 5000; server.maxHeadersCount = 30;
    await new Promise<void>((resolve,reject) => {server.once('error',reject); server.listen(0,'127.0.0.1',resolve);});
    const address = server.address(); if (!address || typeof address === 'string') {server.close(); throw new Error('Локальная настройка недоступна.');}
    const close = () => {server.closeAllConnections(); server.close(); active.delete(preparationId);};
    const timer = setTimeout(close,Math.max(1,Date.parse(expiresAt) - Date.now())); timer.unref(); server.unref();
    active.set(preparationId,{expiresAt,close:() => {clearTimeout(timer); close();}});
    if (!await open(`http://127.0.0.1:${address.port}/#${bootstrap}`)) {active.get(preparationId)?.close(); throw new Error('Не удалось открыть локальную настройку. Разрешите открытие браузера на выбранном компьютере.');}
}
/** Только явное завершение собственных локальных сессий, используется при остановке и в тестах. */
export function closeConfigurationSessions(): void {for (const entry of active.values()) {entry.close();}}
