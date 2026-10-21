const {test} = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');
const fs = require('node:fs/promises');
const {createRequire} = require('node:module');
const {createHash} = require('node:crypto');
const {createServer} = require('node:http');
const {startDocumentationFixture} = require('./api-documentation.fixture.cjs');

const dist = process.env.GATEWAY_TEST_DIST || path.resolve('services/api-gateway/dist');

async function fixture(t, options) {
    const app = await startDocumentationFixture(options);
    t.after(() => app.close());
    return app;
}

test('Swagger serves the pinned UI5.14.0 assets resolved by the running Nest adapter', async t => {
    const requireRuntime = createRequire(path.join(dist, 'docs/setup-api-documentation.js'));
    const requireSwagger = createRequire(requireRuntime.resolve('@nestjs/swagger/package.json'));
    assert.equal(requireSwagger('swagger-ui-dist/package.json').version, '5.14.0');
    const assets = requireSwagger('swagger-ui-dist/absolute-path.js')();
    const app = await fixture(t);
    const sha = value => createHash('sha256').update(value).digest('hex');
    for (const filename of ['swagger-ui.css','swagger-ui-bundle.js','swagger-ui-standalone-preset.js']) {
        const response = await fetch(app.base + '/api/docs/' + filename);
        assert.equal(response.status, 200);
        assert.equal(sha(Buffer.from(await response.arrayBuffer())), sha(await fs.readFile(path.join(assets, filename))), filename);
    }
});

test('Swagger UI, schema and local static assets precede the wildcard API proxy', async t => {
    const app = await fixture(t);
    for (const route of ['/api/docs', '/api/docs/']) {
        const response = await fetch(app.base + route);
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /text\/html/);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const html = await response.text();
        assert.match(html, /swagger-ui/);
        assert.doesNotMatch(html, /<script[^>]*>\s*[^<\s]/i, 'Production CSP forbids executable inline scripts');
        assert.doesNotMatch(html, /(?:src|href)=["']https?:\/\//i, 'UI assets must be same-origin');
    }
    const spec = await fetch(app.base + '/api/docs/openapi.json');
    assert.equal(spec.status, 200);
    assert.equal(spec.headers.get('cache-control'), 'no-store');
    assert.equal(spec.headers.get('x-content-type-options'), 'nosniff');
    const document = await spec.json();
    assert.equal(document.openapi, '3.0.3');
    assert.ok(document.paths['/api/projects'].get);
    for (const filename of ['swagger-ui.css', 'swagger-ui-bundle.js', 'swagger-ui-standalone-preset.js', 'swagger-ui-init.js']) {
        const asset = await fetch(app.base + '/api/docs/' + filename);
        assert.equal(asset.status, 200, filename);
        assert.equal(asset.headers.get('cache-control'), 'no-store', filename);
        assert.ok((await asset.text()).length > 20, filename);
    }
    assert.deepEqual(app.state.proxyHits, []);
    assert.ok(app.state.authCalls >= 7, 'Every docs and asset request requires a fresh session check');
    assert.equal((await fetch(app.base + '/api/docsfoo')).status, 418);
    assert.deepEqual(app.state.proxyHits, ['/api/docsfoo']);
});

test('Unauthenticated documentation requests never expose UI, assets or OpenAPI', async t => {
    const app = await fixture(t, {state: {mode: 'anonymous'}});
    for (const route of ['/api/docs', '/api/docs/', '/api/docs/openapi.json', '/api/docs/swagger-ui-init.js', '/api/docs/swagger-ui.css',
        '/API/DOCS', '/api/Docs/openapi.json', '/API/docs/swagger-ui-init.js']) {
        const response = await fetch(app.base + route);
        assert.equal(response.status, 401, route);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.doesNotMatch(await response.text(), /fixtureProjects|SwaggerUIBundle|openapi":/);
    }
    assert.deepEqual(app.state.proxyHits, []);
});

test('Authentication outage returns private503, preserves the cookie and recovers without cached authorization', async t => {
    const app = await fixture(t, {state: {mode: 'cookie'}});
    const headers = {cookie: 'bridge_session=fixture-existing'};
    assert.equal((await fetch(app.base + '/api/docs/openapi.json', {headers})).status, 200);
    app.state.mode = 'unavailable';
    const response = await fetch(app.base + '/api/docs/openapi.json', {headers});
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.doesNotMatch(await response.text(), /PRIVATE_AUTH_ADDRESS_AND_SECRET/);
    app.state.mode = 'anonymous';
    assert.equal((await fetch(app.base + '/api/docs/swagger-ui-bundle.js', {headers})).status, 401);
    app.state.mode = 'cookie';
    assert.equal((await fetch(app.base + '/api/docs/openapi.json', {headers})).status, 200);
    assert.deepEqual(app.state.proxyHits, []);
});

test('Real AuthGuard HTTP lookup protects documentation using the existing session cookie', async t => {
    let status = 401;
    const cookies = [];
    const authServer = createServer((req, res) => {
        cookies.push(req.headers.cookie);
        res.writeHead(status, {'content-type': 'application/json'});
        res.end(JSON.stringify(status === 200 ? {user: {id: 'fixture-user', email: 'fixture@example.test',
            principalName: 'fixture@example.test', activeRole: 'Наблюдатель', userRoles: ['Наблюдатель']}, policies: {}} : {}));
    });
    await new Promise(resolve => authServer.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => {authServer.close(resolve); authServer.closeAllConnections();}));
    const {AuthGuardService} = require(path.join(dist, 'auth/auth-guard.service.js'));
    const auth = new AuthGuardService({get: key => key === 'AUTH_SERVICE_URL' ? 'http://127.0.0.1:' + authServer.address().port : undefined});
    const app = await fixture(t, {auth});
    const headers = {cookie: 'bridge_session=fixture-existing'};
    assert.equal((await fetch(app.base + '/api/docs/openapi.json', {headers})).status, 401);
    status = 200;
    assert.equal((await fetch(app.base + '/api/docs/openapi.json', {headers})).status, 200);
    status = 503;
    assert.equal((await fetch(app.base + '/api/docs/openapi.json', {headers})).status, 503);
    status = 200;
    assert.equal((await fetch(app.base + '/api/docs/openapi.json', {headers})).status, 200);
    assert.deepEqual(cookies, Array(4).fill(headers.cookie));
    assert.deepEqual(app.state.proxyHits, []);
});

test('Device identities and Authorization headers cannot access human documentation', async t => {
    const app = await fixture(t, {state: {mode: 'device'}});
    assert.equal((await fetch(app.base + '/api/docs/openapi.json')).status, 403);
    app.state.mode = 'human';
    for (const authorization of ['Bearer ' + 'a'.repeat(64), 'Bearer invalid', 'Basic fixture']) {
        const response = await fetch(app.base + '/api/docs', {headers: {authorization, cookie: 'bridge_session=fixture-existing'}});
        assert.equal(response.status, 403);
    }
    assert.deepEqual(app.state.proxyHits, []);
});

test('HEAD is protected; unknown documentation and unsupported methods cannot reach the API proxy', async t => {
    const app = await fixture(t);
    const head = await fetch(app.base + '/api/docs/openapi.json', {method: 'HEAD'});
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal((await fetch(app.base + '/api/docs/not-a-doc-resource')).status, 404);
    assert.equal((await fetch(app.base + '/api/docs/openapi.json', {method: 'POST'})).status, 405);
    app.state.mode = 'anonymous';
    assert.equal((await fetch(app.base + '/api/docs/openapi.json', {method: 'HEAD'})).status, 401);
    assert.deepEqual(app.state.proxyHits, []);
});

test('Swagger assets work under the existing production CSP with no external validator', async t => {
    const app = await fixture(t, {productionCsp: true});
    const html = await fetch(app.base + '/api/docs');
    const csp = html.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self';/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    const script = await fetch(app.base + '/api/docs/swagger-ui-init.js');
    assert.equal(script.status, 200);
    const body = await script.text();
    assert.match(body, /validatorUrl/);
    assert.match(body, /requestInterceptor/);
    assert.doesNotMatch(body, /validator\.swagger\.io|unpkg\.com|cdnjs\./);
});

test('Try-it-out adds the CSRF marker only to same-origin requests and does not persist authorization', () => {
    const {swaggerUiOptions} = require(path.join(dist, 'docs/swagger-ui-options.js'));
    assert.equal(swaggerUiOptions.withCredentials, true);
    assert.equal(swaggerUiOptions.persistAuthorization, false);
    assert.equal(swaggerUiOptions.validatorUrl, null);
    assert.equal(swaggerUiOptions.queryConfigEnabled, false);
    const invoke = vm.runInNewContext('(' + swaggerUiOptions.requestInterceptor.toString() + ')', {
        window: {location: {origin: 'https://panel.example.test', href: 'https://panel.example.test/api/docs'}}, URL,
    });
    for (const url of ['/api/projects', 'https://panel.example.test/api/projects']) {
        const request = {url, headers: {Accept: 'application/json'}};
        const result = invoke(request);
        assert.equal(result.headers['x-neurocenter-request'], '1');
        assert.equal(result.headers.Accept, 'application/json');
        assert.equal(result.credentials, 'same-origin');
    }
    const mixedCase = invoke({url: '/api/projects', headers: {'X-Neurocenter-Request': '0', 'x-neurocenter-request': '2', Accept: 'application/json'}});
    assert.deepEqual(Object.keys(mixedCase.headers).filter(key => key.toLowerCase() === 'x-neurocenter-request'), ['x-neurocenter-request']);
    assert.equal(mixedCase.headers['x-neurocenter-request'], '1');
    for (const url of ['https://foreign.example.test/api/projects', '//foreign.example.test/api/projects', 'javascript:alert(1)', 'https://user:secret@panel.example.test/api/projects']) {
        const request = {url, headers: {Authorization: 'Bearer fixture'}};
        assert.throws(() => invoke(request), undefined, url);
        assert.equal(request.headers['x-neurocenter-request'], undefined);
    }
});

test('Serialized Swagger interceptor negotiates JSON and SSE only for MCP POST requests', async t => {
    const app = await fixture(t);
    const response = await fetch(app.base + '/api/docs/swagger-ui-init.js');
    assert.equal(response.status, 200);
    let options;
    const SwaggerUIBundle = value => {options = value; return {};};
    SwaggerUIBundle.presets = {apis: {}};
    SwaggerUIBundle.plugins = {DownloadUrl: {}};
    const window = {location: {origin: 'https://panel.example.test', href: 'https://panel.example.test/api/docs', search: ''}};
    vm.runInNewContext(await response.text(), {window, URL, SwaggerUIBundle, SwaggerUIStandalonePreset: {}});
    window.onload();
    assert.equal(typeof options.requestInterceptor, 'function');
    const invoke = options.requestInterceptor;
    for (const [method, url] of [['POST', '/api/mcp-host/m/fixture'], ['post', '/api/mcp-host/m/fixture/?session=fixture']]) {
        const result = invoke({method, url, headers: {Accept: 'application/json', accept: '*/*', ACCEPT: 'text/plain'}});
        assert.deepEqual(Object.keys(result.headers).filter(name => name.toLowerCase() === 'accept'), ['Accept']);
        assert.equal(result.headers.Accept, 'application/json, text/event-stream');
        assert.equal(result.headers['x-neurocenter-request'], '1');
    }
    assert.equal(invoke({method: 'POST', url: '/api/mcp-host/m/fixture'}).headers.Accept, 'application/json, text/event-stream');
    for (const [method, url] of [['GET', '/api/mcp-host/m/fixture'], ['PUT', '/api/mcp-host/m/fixture'],
        ['POST', '/api/projects'], ['POST', '/api/mcp-host/m/fixture/tools'], ['POST', '/api/mcp-host/m/']]) {
        const result = invoke({method, url, headers: {accept: 'application/json'}});
        assert.equal(result.headers.accept, 'application/json', method + ' ' + url);
        assert.equal(result.headers.Accept, undefined, method + ' ' + url);
    }
    assert.throws(() => invoke({method: 'POST', url: 'https://foreign.example.test/api/mcp-host/m/fixture'}));
});
