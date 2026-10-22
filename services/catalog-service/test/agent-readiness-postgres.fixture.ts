import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { NotFoundException } from '@nestjs/common';
import { Pool } from 'pg';
import { AccessDb } from '../src/access/access-db';
import { AgentRepository } from '../src/agents/agent.repository';
import { AgentReadinessService } from '../src/agent-readiness/agent-readiness.service';
import { ModelsService } from '../src/models/models.service';
import { ModelRuntime } from '../src/models/model-runtime';
import { ModelUsageService } from '../src/model-usage/model-usage.service';
import type { CatalogService } from '../src/catalog/catalog.service';
import type { OllamaClient } from '../src/models/ollama-client';
import type { RemoteConnectionService } from '../src/models/remote-connection.service';
import { ensureCatalogSchema } from '../src/database/catalog-schema';
import { modelFromRow, saveModelVersion } from '../src/models/model-history';
import type { IModel } from '../src/models/model.types';
import type { AgentDefinition } from '../../shared/project-agents.cjs';
import type { AgentTrial } from '../src/agent-readiness/agent-readiness.types';

export const TRIAL_PROJECT = 'prj-agent-trial';
export interface TrialProviderCall { model: IModel; endpoint: string; body: Record<string, unknown>; signal?: AbortSignal }
/** Actual migration/ACL/model selection/ledger; only provider inference and catalog project metadata are fixtures. */
export async function createAgentReadinessFixture(connection: string) {
    const url = new URL(connection);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.port || url.port === '5432') throw new Error('An explicit own QA PostgreSQL port is required.');
    url.pathname = '/postgres'; const admin = new Pool({ connectionString: url.href, max: 1 }), database = 'nc_agent_trial_' + randomUUID().replaceAll('-', '');
    await admin.query('CREATE DATABASE ' + database); url.pathname = '/' + database;
    const db = new Pool({ connectionString: url.href, max: 3 }), oldUrl = process.env.CATALOG_PG_URL, oldToken = process.env.NEUROCENTER_INTERNAL_TOKEN;
    process.env.CATALOG_PG_URL = url.href; process.env.NEUROCENTER_INTERNAL_TOKEN = 'agent-trial-fixture-only';
    let access: AccessDb | undefined, models: ModelsService | undefined, usage: ModelUsageService | undefined, service: AgentReadinessService | undefined;
    try {
        await ensureCatalogSchema(db);
        await db.query("INSERT INTO projects(id,name) VALUES($1,'Diagnostic project')", [TRIAL_PROJECT]);
        for (const [email, role] of [['owner@localhost', 'Разработчик'], ['other@localhost', 'Разработчик'], ['observer@localhost', 'Наблюдатель'], ['admin@localhost', 'Главный админ']]) {
            await db.query('INSERT INTO platform_users(email,is_main_admin) VALUES($1,$2)', [email, role === 'Главный админ']);
            if (role !== 'Главный админ') await db.query('INSERT INTO project_members(project_id,user_id,principal_name,display_name,role) VALUES($1,$2,$2,$2,$3)', [TRIAL_PROJECT, email, role]);
        }
        access = new AccessDb();
        const catalog = { ensureSchema: async () => undefined, getProject: async (id: string) => {
            const row = (await db.query('SELECT * FROM projects WHERE id=$1', [id])).rows[0]; if (!row) throw new NotFoundException('Проект не найден.'); return { ...row, headRevision: 0 };
        } } as unknown as CatalogService;
        models = new ModelsService(catalog, access); usage = new ModelUsageService(models);
        let behavior = async (call: TrialProviderCall): Promise<Record<string, unknown>> => {
            const messages = call.body.messages as Array<{ content: string }>, nonce = /"nonce":"([^"]+)"/.exec(messages.at(-1)!.content)![1];
            return { message: { role: 'assistant', content: JSON.stringify({ nonce, sum: 42 }) }, done_reason: 'stop', usage_reported: true, prompt_eval_count: 31, eval_count: 13 };
        };
        const calls: TrialProviderCall[] = [], provider = { infer: async (model: IModel, endpoint: string, body: Record<string, unknown>, signal?: AbortSignal) => {
            const call = { model, endpoint, body: structuredClone(body), signal }; calls.push(call); return behavior(call);
        } };
        const runtime = new ModelRuntime(provider as unknown as OllamaClient, provider as unknown as RemoteConnectionService, usage);
        service = new AgentReadinessService(models, runtime); await usage.onModuleInit(); await service.onModuleInit();
        const request = (email = 'owner@localhost', role = email === 'admin@localhost' ? 'Главный админ' : email === 'observer@localhost' ? 'Наблюдатель' : 'Разработчик') => ({ headers: {
            'x-neurocenter-internal': 'agent-trial-fixture-only', 'x-bridge-actor': encodeURIComponent(JSON.stringify({ email, activeRole: role })) } } as unknown as Request);
        const addModel = async (id = 'model-diagnostic', changes: Record<string, unknown> = {}) => {
            const descriptor = { model: 'diagnostic:1', runtime: 'remote-openai', capability: 'chat', verificationSha256: 'b'.repeat(64), modelVersion: '1', manifestSha256: null, dimension: null, source: 'custom', description: '', ...changes };
            const row = (await db.query('INSERT INTO model_catalog(id,name,descriptor) VALUES($1,$1,$2::jsonb) RETURNING *', [id, JSON.stringify(descriptor)])).rows[0];
            await saveModelVersion(db, row);
            await db.query("INSERT INTO project_models(project_id,model_id,added_by) VALUES($1,$2,'fixture')", [TRIAL_PROJECT, id]);
            await db.query("INSERT INTO model_remote_connections(model_id,revision,base_url,request_dimensions,credential_kind,semantic_sha,options) VALUES($1,1,'http://127.0.0.1:1',false,'none',$2,'{\"contextWindow\":8192}')", [id, descriptor.verificationSha256]);
            return modelFromRow(row);
        };
        const addAgent = async (definition: Partial<AgentDefinition> = {}, enabled = false) => {
            const id = 'agent-' + randomUUID(), card = await new AgentRepository(db).write(db, id, { slug: 'nc-' + randomUUID().slice(0, 8), name: 'Diagnostic agent',
                definition: { description: 'Diagnostic', prompt: 'Сохранённая persona', mode: 'all', permission: {}, ...definition } }, 1);
            await db.query('INSERT INTO project_agent_sets(project_id) VALUES($1) ON CONFLICT DO NOTHING', [TRIAL_PROJECT]);
            await db.query("INSERT INTO project_agents(project_id,agent_id,version,manifest,enabled,added_by,updated_by) VALUES($1,$2,1,$3,$4,'fixture','fixture')", [TRIAL_PROJECT, id, card.manifest, enabled]);
            await db.query('UPDATE project_agent_sets SET revision=revision+1 WHERE project_id=$1', [TRIAL_PROJECT]); return card;
        };
        const settle = async (id: string, agent: string, req = request()): Promise<AgentTrial> => {
            for (let i = 0; i < 200; i++) { const current = await service!.read(req, TRIAL_PROJECT, agent, id); if (!['queued', 'running'].includes(current.status)) return current; await new Promise(resolve => setTimeout(resolve, 10)); }
            throw new Error('Diagnostic attempt did not settle in the test fixture.');
        };
        return { db, database, models, service, usage, runtime, calls, request, addModel, addAgent, settle,
            setProvider(next: typeof behavior) { behavior = next; },
            async close() { await service!.onApplicationShutdown(); await usage!.onApplicationShutdown(); await models!.onApplicationShutdown(); await access!.onModuleDestroy(); await db.end(); await admin.query('DROP DATABASE ' + database); await admin.end();
                if (oldUrl === undefined) delete process.env.CATALOG_PG_URL; else process.env.CATALOG_PG_URL = oldUrl;
                if (oldToken === undefined) delete process.env.NEUROCENTER_INTERNAL_TOKEN; else process.env.NEUROCENTER_INTERNAL_TOKEN = oldToken; }
        };
    } catch (error) {
        await service?.onApplicationShutdown(); await usage?.onApplicationShutdown(); await models?.onApplicationShutdown(); await access?.onModuleDestroy(); await db.end(); await admin.query('DROP DATABASE ' + database); await admin.end();
        if (oldUrl === undefined) delete process.env.CATALOG_PG_URL; else process.env.CATALOG_PG_URL = oldUrl;
        if (oldToken === undefined) delete process.env.NEUROCENTER_INTERNAL_TOKEN; else process.env.NEUROCENTER_INTERNAL_TOKEN = oldToken; throw error;
    }
}
