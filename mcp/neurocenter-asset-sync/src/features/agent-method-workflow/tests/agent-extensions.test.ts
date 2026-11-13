import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import type { IAgentExtension } from '../../../../../services/shared/project-agents.cjs';
import { agentMcpWhitelist, agentOverlayPath, validateKitOverlay, type IAgentKitOverlay } from '../agent-extensions.js';
import { MethodExecutionError } from '../process.js';
import { runMethodCommand } from '../process.js';

const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const MANIFEST = 'a'.repeat(64);
const extension = (patch: Partial<IAgentExtension> = {}): IAgentExtension => ({
    assetId: 'mcp-goodserver',
    assetKind: 'mcp',
    version: 1,
    manifest: MANIFEST,
    origin: 'approved',
    ...patch,
});
const overlayPayload = (
    patch: Partial<Omit<IAgentKitOverlay, 'schemaVersion' | 'sha256'>> = {},
): Omit<IAgentKitOverlay, 'sha256'> => ({
    schemaVersion: 1,
    agentId: 'agent-owned',
    projectId: 'qa-project',
    agentsManifestSha256: 'b'.repeat(64),
    extensions: [extension()],
    mcpOverride: null,
    ...patch,
});
const overlayJson = (kit: Omit<IAgentKitOverlay, 'sha256'>): string =>
    JSON.stringify({
        ...kit,
        sha256: sha(
            JSON.stringify({
                agentId: kit.agentId,
                projectId: kit.projectId,
                agentsManifestSha256: kit.agentsManifestSha256,
                extensions: kit.extensions,
                mcpOverride: kit.mcpOverride,
            }),
        ),
    });

describe('FR-306 kit overlay contract', () => {
    it('accepts a consistent overlay and refuses drift, extra keys, duplicates and unproven mcp shapes', () => {
        const kit = overlayPayload();
        expect(validateKitOverlay(overlayJson(kit))).toMatchObject({ agentId: kit.agentId, mcpOverride: null });
        const withOverride = overlayPayload({ mcpOverride: { goodserver: { type: 'local', command: 'good' } } });
        expect(validateKitOverlay(overlayJson(withOverride))).toMatchObject({
            mcpOverride: { goodserver: { type: 'local', command: 'good' } },
        });
        const raw = overlayJson(kit);
        expect(validateKitOverlay(raw.slice(0, -2) + '0}')).toBeNull(); // corrupted sha256
        expect(validateKitOverlay(raw.replace('"mcpOverride"', '"mcpOverrideX"'))).toBeNull(); // renamed key
        const duplicate = overlayPayload({ extensions: [extension(), extension()] });
        expect(validateKitOverlay(overlayJson(duplicate))).toBeNull();
        const badOverride = overlayPayload({ mcpOverride: { goodserver: 'not-an-object' } });
        expect(validateKitOverlay(overlayJson(badOverride))).toBeNull();
        const wrongAgent = overlayJson(overlayPayload({ agentId: 'agent-other' }));
        expect(validateKitOverlay(wrongAgent)).toMatchObject({ agentId: 'agent-other' });
    });
});

describe('FR-306 mcp isolation', () => {
    let root: string;
    beforeEach(async () => {
        root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-ext-mcp-')));
    });
    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });
    const receiptFile = (kind: string, assetId: string): string =>
        path.join(root, '.opencode/neurocenter/receipts', sha(kind + ':' + assetId).slice(0, 24) + '.json');
    it('keeps the receipt-proven approved server and disables every other project-level mcp entry', async () => {
        await fs.mkdir(path.dirname(receiptFile('mcp', 'mcp-goodserver')), { recursive: true });
        await fs.writeFile(
            receiptFile('mcp', 'mcp-goodserver'),
            JSON.stringify({
                version: 1,
                manifest: MANIFEST,
                config: {
                    path: '.opencode/opencode.json',
                    key: 'goodserver',
                    value: { type: 'local', command: 'good' },
                },
            }),
        );
        await fs.mkdir(path.join(root, '.opencode'), { recursive: true });
        await fs.writeFile(
            path.join(root, '.opencode/opencode.json'),
            JSON.stringify({
                mcp: {
                    goodserver: { type: 'local', command: 'stale' },
                    evilserver: { type: 'local', command: 'evil' },
                },
            }),
        );
        const override = await agentMcpWhitelist(root, {
            extensions: [
                extension(),
                {
                    assetId: 'mcp-evilserver',
                    assetKind: 'mcp',
                    version: 2,
                    manifest: 'c'.repeat(64),
                    origin: 'experimental',
                },
            ],
        });
        expect(override).toEqual({ goodserver: { type: 'local', command: 'good' }, evilserver: { enabled: false } });
    });
    it('is null without any mcp extension and refuses an approved mcp entry without a proving receipt', async () => {
        expect(
            await agentMcpWhitelist(root, {
                extensions: [
                    { assetId: 'skill-x', assetKind: 'skill', version: 1, manifest: MANIFEST, origin: 'approved' },
                ],
            }),
        ).toBeNull();
        await expect(agentMcpWhitelist(root, { extensions: [extension()] })).rejects.toThrow(MethodExecutionError);
        const noConfigReceipt = receiptFile('mcp', 'mcp-goodserver');
        await fs.mkdir(path.dirname(noConfigReceipt), { recursive: true });
        await fs.writeFile(noConfigReceipt, JSON.stringify({ version: 1, manifest: MANIFEST }));
        await expect(agentMcpWhitelist(root, { extensions: [extension()] })).rejects.toThrow(MethodExecutionError);
    });
});

describe('FR-306 runner applies the committed kit before starting the engine', () => {
    const runner = fileURLToPath(new URL('../opencode-http-runner.ts', import.meta.url));
    let temporary: string, root: string, engine: string;
    const AGENT = {
        slug: 'nc-owned',
        mode: 'primary' as const,
        model: { providerID: 'owned-provider', modelID: 'owned-alias' },
        agentId: 'agent-owned',
        extensions: [extension()],
        overlay: agentOverlayPath('agent-owned'),
    };
    beforeEach(async () => {
        temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'agent-ext-runner-')));
        root = path.join(temporary, 'проект');
        await fs.mkdir(path.join(root, 'processes'), { mode: 0o700, recursive: true });
        engine = path.join(root, 'engine');
        await fs.writeFile(
            engine,
            `#!${process.execPath}
const http=require('node:http'),fs=require('node:fs');
const expected='Basic '+Buffer.from(process.env.OPENCODE_SERVER_USERNAME+':'+process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
if(process.argv.slice(2).join(' ')!=='serve --hostname 127.0.0.1 --port 0'||!process.env.OPENCODE_SERVER_PASSWORD)process.exit(2);
const server=http.createServer(async(req,res)=>{
 const route=new URL(req.url,'http://127.0.0.1');
 if(req.headers.authorization!==expected||route.searchParams.get('directory')!==process.cwd()){res.writeHead(401);res.end('{}');return;}
 if(req.method==='GET'&&route.pathname==='/agent'){
  const selected=${JSON.stringify(AGENT)};
  res.end(JSON.stringify([{name:'build',mode:'primary',model:{providerID:'default',modelID:'default'}},{name:selected.slug,mode:selected.mode,model:selected.model}]));return;
 }
 let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);res.setHeader('content-type','application/json');
 if(route.pathname==='/session'){
  if(body.permission.length!==3||body.permission.some(rule=>rule.action!=='deny')){res.writeHead(400);res.end('{}');return;}
  res.end(JSON.stringify({id:'ses_owned'}));return;
 }
 if(route.pathname==='/session/ses_owned/message'){
  const selected=${JSON.stringify(AGENT)};
  if(body.parts[0].text!=='OWNED_TASK'||body.agent!==selected.slug||JSON.stringify(body.model)!==JSON.stringify(selected.model)){res.writeHead(400);res.end('{}');return;}
  fs.writeFileSync('app.js','implemented by owned HTTP runtime');
  const final={info:{id:'msg_owned',sessionID:'ses_owned',role:'assistant',time:{created:1,completed:2},finish:'stop',agent:selected.slug,providerID:selected.model.providerID,modelID:selected.model.modelID},parts:[{id:'prt_owned',messageID:'msg_owned',sessionID:'ses_owned',type:'text',text:'OK'}]};
  res.end(JSON.stringify(final));return;
 }
 res.writeHead(404);res.end('{}');
});
server.listen(0,'127.0.0.1',()=>{
 fs.writeFileSync('server.pid',String(process.pid));
 fs.writeFileSync('env-dump.json',JSON.stringify({overlay:process.env.NC_AGENT_EXTENSION_OVERLAY||null,config:process.env.OPENCODE_CONFIG_CONTENT||null}));
 console.log('opencode server listening on http://127.0.0.1:'+server.address().port);
});
`,
        );
        await fs.chmod(engine, 0o700);
    });
    afterEach(async () => {
        await fs.rm(temporary, { recursive: true, force: true });
    });
    const run = (baseConfig?: string) =>
        runMethodCommand(
            process.execPath,
            [runner, '--agent-method-runtime', engine, root, 'OWNED_TASK', JSON.stringify(AGENT)],
            root,
            { ...process.env, ...(baseConfig !== undefined ? { OPENCODE_CONFIG_CONTENT: baseConfig } : {}) },
            async () => {},
            new AbortController().signal,
            {
                nonce: randomUUID(),
                receipt: path.join(root, 'processes', randomUUID() + '.json'),
                retain: async () => {},
            },
            true,
        );
    const commitOverlay = async (kit: Omit<IAgentKitOverlay, 'sha256'>) => {
        const target = path.join(root, agentOverlayPath(AGENT.agentId));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, overlayJson(kit), { mode: 0o600 });
    };
    it('starts the engine only with the merged mcp isolation and the overlay location from the committed kit', async () => {
        await commitOverlay(
            overlayPayload({
                mcpOverride: { goodserver: { type: 'local', command: 'good' }, evilserver: { enabled: false } },
            }),
        );
        const result = await run('{"theme":"dark"}');
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout).type).toBe('agent_method_completed');
        const env = JSON.parse(await fs.readFile(path.join(root, 'env-dump.json'), 'utf8'));
        expect(env.overlay).toBe(path.join(root, agentOverlayPath(AGENT.agentId)));
        expect(JSON.parse(env.config)).toEqual({
            theme: 'dark',
            mcp: { goodserver: { type: 'local', command: 'good' }, evilserver: { enabled: false } },
        });
    }, 30000);
    it('keeps the base inline config when the kit has no mcp isolation', async () => {
        await commitOverlay(overlayPayload());
        const result = await run('{"theme":"dark"}');
        expect(result.code).toBe(0);
        const env = JSON.parse(await fs.readFile(path.join(root, 'env-dump.json'), 'utf8'));
        expect(env.overlay).toBe(path.join(root, agentOverlayPath(AGENT.agentId)));
        expect(env.config).toBe('{"theme":"dark"}');
    }, 30000);
    it('refuses a committed kit whose sha256 no longer proves its own fields', async () => {
        const target = path.join(root, agentOverlayPath(AGENT.agentId));
        await fs.mkdir(path.dirname(target), { recursive: true });
        const raw = overlayJson(overlayPayload({ mcpOverride: { goodserver: { type: 'local', command: 'good' } } }));
        // Flip one character of the signed projectId without recomputing sha256.
        await fs.writeFile(target, raw.replace('qa-project', 'qb-project'), { mode: 0o600 });
        const result = await run();
        expect(result.code).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
            type: 'agent_method_failed',
            code: 'SELECTED_AGENT_NOT_READY',
        });
    }, 30000);
    it('refuses a committed kit whose extensions drifted from the server-issued argv kit', async () => {
        await commitOverlay(overlayPayload({ extensions: [extension({ assetId: 'mcp-other' })] }));
        const result = await run();
        expect(result.code).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
            type: 'agent_method_failed',
            code: 'SELECTED_AGENT_NOT_READY',
        });
    }, 30000);
    it('refuses a missing overlay before starting the engine', async () => {
        const result = await run();
        expect(result.code).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
            type: 'agent_method_failed',
            code: 'SELECTED_AGENT_NOT_READY',
        });
        await expect(fs.stat(path.join(root, 'app.js'))).rejects.toHaveProperty('code', 'ENOENT');
    }, 30000);
});
