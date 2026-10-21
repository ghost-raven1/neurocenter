const path = require('node:path');
const fs = require('node:fs');
const {createRequire} = require('node:module');

const root = path.resolve(__dirname, '../..');
const requireGateway = createRequire(path.join(root, 'services/api-gateway/package.json'));
requireGateway('reflect-metadata');
const {NestFactory} = requireGateway('@nestjs/core');
const {Module, Controller, All, Req, Res} = requireGateway('@nestjs/common');
const dist = process.env.GATEWAY_TEST_DIST || path.join(root, 'services/api-gateway/dist');
const {setupApiDocumentation} = require(path.join(dist, 'docs/setup-api-documentation.js'));
const {browserSecurity} = require(path.join(dist, 'security/browser-security.js'));

const fixtureDocument = {
    openapi: '3.0.3', info: {title: 'Neurocenter API test', version: 'fixture'}, servers: [{url: '/'}],
    paths: {'/api/projects': {get: {operationId: 'fixtureProjects', tags: ['Projects'],
        responses: {'200': {description: 'Fixture response', content: {'application/json': {schema: {type: 'array', items: {type: 'object'}}}}}}}}},
};
const human = {email: 'swagger-fixture@example.test', activeRole: 'Наблюдатель', userId: 'fixture',
    principalName: 'swagger-fixture@example.test', userRoles: ['Наблюдатель'], policies: {}};

/** Only authentication and the API resource response are fixtures; Nest, Express and Swagger are real. */
async function startDocumentationFixture(options = {}) {
    const state = {mode: 'human', authCalls: 0, proxyHits: [], requestHeaders: [], ...options.state};
    class ApiFixtureController {
        all(req, res) {
            state.proxyHits.push(req.path);
            state.requestHeaders.push({accept: req.headers.accept,
                'x-neurocenter-request': req.headers['x-neurocenter-request'],
                'sec-fetch-site': req.headers['sec-fetch-site']});
            if (req.method === 'GET' && req.path === '/api/projects') {
                res.json([]); return;
            }
            res.status(418).json({fixtureProxyReached: true});
        }
    }
    Controller('api')(ApiFixtureController);
    const handler = Object.getOwnPropertyDescriptor(ApiFixtureController.prototype, 'all');
    All('{*path}')(ApiFixtureController.prototype, 'all', handler);
    Req()(ApiFixtureController.prototype, 'all', 0);
    Res()(ApiFixtureController.prototype, 'all', 1);
    class FixtureModule {}
    Module({controllers: [ApiFixtureController]})(FixtureModule);
    const app = await NestFactory.create(FixtureModule, {logger: false, bodyParser: false});
    app.use(browserSecurity);
    if (options.productionCsp) {
        const nginx = fs.readFileSync(path.join(root, 'frontend/nginx.conf'), 'utf8');
        const csp = nginx.match(/add_header Content-Security-Policy "([^"]+)" always;/)?.[1];
        if (!csp) throw new Error('Production CSP not found');
        app.use((_req, res, next) => {res.setHeader('Content-Security-Policy', csp); next();});
    }
    setupApiDocumentation(app, options.auth || {authenticate: async req => {
        state.authCalls++;
        if (state.mode === 'unavailable') throw new Error('PRIVATE_AUTH_ADDRESS_AND_SECRET');
        if (state.mode === 'anonymous') return null;
        if (state.mode === 'device') return {...human, deviceId: 'fixture-device'};
        if (state.mode === 'cookie' && req.headers.cookie !== 'bridge_session=fixture-existing') return null;
        return human;
    }}, options.document === 'generated' ? undefined : options.document || fixtureDocument);
    await app.listen(0, '127.0.0.1');
    const server = app.getHttpServer(), base = 'http://127.0.0.1:' + server.address().port;
    return {app, state, base, async close() {server.closeAllConnections(); await app.close();}};
}

module.exports = {startDocumentationFixture, fixtureDocument};
