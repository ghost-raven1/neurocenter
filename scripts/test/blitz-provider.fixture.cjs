'use strict';
const https = require('node:https');
const fs = require('node:fs');
const { randomBytes, createHash } = require('node:crypto');
const codes = new Map();
const tokens = new Set();
/** Тестовый IdP живёт только в изолированном Compose-проекте и не входит в production-стек. */
const tlsOptions = { cert: fs.readFileSync('/fixture/tls.crt'), key: fs.readFileSync('/fixture/tls.key') };
async function handleBlitzRequest(req, res) {
    try {
        const url = new URL(req.url, 'https://blitz.test');
        res.setHeader('Content-Type', 'application/json');
        if (url.pathname === '/blitz/oauth/ae') {
            if (
                url.searchParams.get('client_id') !== 'fixture-client' ||
                url.searchParams.get('redirect_uri') !== 'https://panel.test/auth/callback' ||
                url.searchParams.get('code_challenge_method') !== 'S256'
            ) {
                res.writeHead(400);
                res.end('{}');
                return;
            }
            const code = randomBytes(24).toString('hex');
            codes.set(code, url.searchParams.get('code_challenge'));
            const callback = new URL('https://panel.test/auth/callback');
            callback.searchParams.set('state', url.searchParams.get('state'));
            callback.searchParams.set('code', code);
            res.writeHead(302, { location: callback.href });
            res.end();
            return;
        }
        if (url.pathname === '/blitz/oauth/te') {
            let body = '';
            for await (const chunk of req) {
                body += chunk;
                if (body.length > 16000) {
                    res.writeHead(413);
                    res.end();
                    return;
                }
            }
            const params = new URLSearchParams(body);
            const challenge = codes.get(params.get('code'));
            codes.delete(params.get('code'));
            if (
                !challenge ||
                challenge !==
                    createHash('sha256')
                        .update(params.get('code_verifier') || '')
                        .digest('base64url') ||
                req.headers.authorization !==
                    'Basic ' + Buffer.from('fixture-client:fixture-only').toString('base64') ||
                params.has('client_secret') ||
                params.get('redirect_uri') !== 'https://panel.test/auth/callback'
            ) {
                res.writeHead(400);
                res.end('{}');
                return;
            }
            const token = randomBytes(24).toString('hex');
            tokens.add(token);
            res.end(JSON.stringify({ access_token: token, token_type: 'Bearer' }));
            return;
        }
        if (url.pathname === '/blitz/oauth/me') {
            if (!tokens.has((req.headers.authorization || '').replace(/^Bearer /, ''))) {
                res.writeHead(401);
                res.end('{}');
                return;
            }
            res.end(
                JSON.stringify({
                    sub: 'fixture-admin',
                    email: 'admin@example.test',
                    name: 'Тестовый администратор',
                    email_verified: true,
                }),
            );
            return;
        }
        if (
            url.pathname === '/blitz/oauth/logout' &&
            url.searchParams.get('client_id') === 'fixture-client' &&
            url.searchParams.get('post_logout_redirect_uri') === 'https://panel.test/'
        ) {
            tokens.clear();
            res.writeHead(302, { location: 'https://panel.test/' });
            res.end();
            return;
        }
        res.writeHead(404);
        res.end('{}');
    } catch {
        res.writeHead(500);
        res.end('{}');
    }
}
// 443 — контейнерная нога: bridge ходит на SSO_HOST (https://blitz.test, порт 443).
// 8443 — хостовая нога верификации (127.0.0.1:18444 → 8443): трафик host→container с
// destination-портом 443 перехватывается антивирусом хоста (KESL) с переизданием
// сертификата, и тест-клиент, доверяющий CA фикстуры, отвергает переизданную цепочку
// (SELF_SIGNED_CERT_IN_CHAIN); контейнерный трафик (bridge → blitz.test:443) не затрагивается.
for (const port of [443, 8443]) {
    https.createServer(tlsOptions, handleBlitzRequest).listen(port, '0.0.0.0');
}
