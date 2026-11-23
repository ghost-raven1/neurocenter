/**
 * FR-903/AD-O7 fail-test: каждая admin-мутация каталога (POST/PATCH/PUT/DELETE/@All
 * в контроллерах) покрыта либо operations, либо security_events, либо явным
 * allowlist с причиной. Новый мутационный роут без классификации = провал.
 * Инвентарь пересобирается из контроллеров при каждом запуске (drift-guard).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Рекурсивный список контроллеров (без tests). */
function listControllers(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const p = path.join(dir, entry);
        const st = statSync(p);
        if (st.isDirectory()) {
            if (entry !== 'tests' && entry !== 'test') out.push(...listControllers(p));
        } else if (entry.endsWith('.controller.ts')) {
            out.push(p);
        }
    }
    return out;
}

/** Мутационные роуты: @Post/@Patch/@Put/@Delete/@All в каждом @Controller. */
function inventoryRoutes(): string[] {
    const keys: string[] = [];
    const mutators = ['Post', 'Patch', 'Put', 'Delete', 'All'];
    for (const file of listControllers(SRC_ROOT)) {
        const src = readFileSync(file, 'utf8');
        const marks = [...src.matchAll(/@Controller\((?:'([^']*)'|\"([^\"]*)\")?\)/g)];
        for (let i = 0; i < marks.length; i++) {
            const pre = marks[i][1] ?? marks[i][2] ?? '';
            const start = marks[i].index + marks[i][0].length;
            const end = i + 1 < marks.length ? marks[i + 1].index : src.length;
            const segment = src.slice(start, end);
            for (const m2 of mutators) {
                const re = new RegExp(`@${m2}\\((?:'([^']*)'|\"([^\"]*)\")?\\)`, 'g');
                for (const mm of segment.matchAll(re)) {
                    const p = mm[1] ?? mm[2] ?? '';
                    const full = (pre + '/' + p).replace(/\/+/g, '/');
                    keys.push(`${m2 === 'All' ? '*' : m2.toUpperCase()} ${full}`);
                }
            }
        }
    }
    return keys.sort();
}

const COVERAGE: Array<[string, { kind: "operations" | "security" | "allow"; note: string }]> = [
    ["POST /internal/access/authorize", { kind: "allow", note: "internal access-авторизация/claims, не admin-мутация каталога" }],
    ["POST /api/platform/users", { kind: "allow", note: "internal access-авторизация/claims, не admin-мутация каталога" }],
    ["POST /internal/security-events", { kind: "security", note: "новый internal приём security_events (AD-O7); пишет security_events напрямую" }],
    ["POST /internal/error-events", { kind: "security", note: "новый internal приём error_events (AD-O5); пишет error_events напрямую" }],
    ["POST api/projects/:projectId/agents/:agentId/readiness-trials", { kind: "allow", note: "readiness-диагностика: временные trial-записи, не конфигурация проекта" }],
    ["POST api/projects/:projectId/agents/:agentId/readiness-trials/:trialId/cancel", { kind: "allow", note: "readiness-диагностика: временные trial-записи, не конфигурация проекта" }],
    ["POST api/agents", { kind: "operations", note: "agent CRUD/connect/configure/remove пишут operations в agent.repository/project-agent.repository" }],
    ["POST api/projects/:id/agents", { kind: "operations", note: "agent CRUD/connect/configure/remove пишут operations в agent.repository/project-agent.repository" }],
    ["POST api/projects/:id/agents/connect", { kind: "operations", note: "agent CRUD/connect/configure/remove пишут operations в agent.repository/project-agent.repository" }],
    ["PATCH api/agents/:id", { kind: "operations", note: "agent CRUD/connect/configure/remove пишут operations в agent.repository/project-agent.repository" }],
    ["PATCH api/projects/:id/agents/:agentId", { kind: "operations", note: "agent CRUD/connect/configure/remove пишут operations в agent.repository/project-agent.repository" }],
    ["DELETE api/projects/:id/agents/:agentId", { kind: "operations", note: "agent CRUD/connect/configure/remove пишут operations в agent.repository/project-agent.repository" }],
    ["POST api/asset-management/impact", { kind: "operations", note: "asset-management impact/archive/legacy-retirement пишут operations в asset-management.service" }],
    ["POST api/asset-management/archive", { kind: "operations", note: "asset-management impact/archive/legacy-retirement пишут operations в asset-management.service" }],
    ["POST api/asset-sources/refresh", { kind: "operations", note: "asset-source refresh/import/cancel пишут operations в import-repository/asset-management" }],
    ["POST api/asset-imports", { kind: "operations", note: "asset-source refresh/import/cancel пишут operations в import-repository/asset-management" }],
    ["POST api/asset-imports/:id/retry", { kind: "operations", note: "asset-source refresh/import/cancel пишут operations в import-repository/asset-management" }],
    ["POST api/asset-imports/:id/resolve", { kind: "operations", note: "asset-source refresh/import/cancel пишут operations в import-repository/asset-management" }],
    ["POST api/asset-imports/:id/cancel", { kind: "operations", note: "asset-source refresh/import/cancel пишут operations в import-repository/asset-management" }],
    ["PUT api/asset-sources/archive", { kind: "operations", note: "asset-source refresh/import/cancel пишут operations в import-repository/asset-management" }],
    ["POST api/bridge-source/check", { kind: "operations", note: "bridge-source check/import пишут operations в bridge-source.repository" }],
    ["POST api/bridge-source/import", { kind: "operations", note: "bridge-source check/import пишут operations в bridge-source.repository" }],
    ["PUT api/bridge-source/", { kind: "operations", note: "bridge-source check/import пишут operations в bridge-source.repository" }],
    ["POST api/asset-management/legacy-retirement/preview", { kind: "operations", note: "legacy-retirement preview/apply пишут operations в legacy-retirement.service" }],
    ["POST api/asset-management/legacy-retirement/apply", { kind: "operations", note: "legacy-retirement preview/apply пишут operations в legacy-retirement.service" }],
    ["POST api/projects/:project/backups", { kind: "security", note: "project.backup.create пишет security_event в транзакции (FR-903/AD-O7)" }],
    ["POST internal/browser-auth-sessions/", { kind: "allow", note: "internal browser-auth session lifecycle (token), не admin-конфигурация" }],
    ["PATCH internal/browser-auth-sessions/:hash/selected-role", { kind: "allow", note: "internal browser-auth session lifecycle (token), не admin-конфигурация" }],
    ["DELETE internal/browser-auth-sessions/:hash", { kind: "allow", note: "internal browser-auth session lifecycle (token), не admin-конфигурация" }],
    ["POST api/projects/import-local", { kind: "security", note: "project.create (import-local) пишет security_event в транзакции createProject (FR-903/AD-O7)" }],
    ["POST api/projects", { kind: "security", note: "project.create пишет security_event в транзакции createProject (FR-903/AD-O7)" }],
    ["POST api/projects/:id/members", { kind: "security", note: "project CRUD/members/assets/plugins пишут security_events (project-*-repository, securityEvent)" }],
    ["POST api/projects/:id/assets", { kind: "security", note: "project CRUD/members/assets/plugins пишут security_events (project-*-repository, securityEvent)" }],
    ["POST api/maintenance/backup", { kind: "security", note: "project CRUD/members/assets/plugins пишут security_events (project-*-repository, securityEvent)" }],
    ["POST api/ai-plugins/:id/versions/:v/activate", { kind: "security", note: "project CRUD/members/assets/plugins пишут security_events (project-*-repository, securityEvent)" }],
    ["POST api/ai-plugins/:id/versions/:v/retire", { kind: "security", note: "project CRUD/members/assets/plugins пишут security_events (project-*-repository, securityEvent)" }],
    ["POST api/ai-plugins/import-local", { kind: "security", note: "project CRUD/members/assets/plugins пишут security_events (project-*-repository, securityEvent)" }],
    ["POST api/ai-plugins", { kind: "security", note: "project CRUD/members/assets/plugins пишут security_events (project-*-repository, securityEvent)" }],
    ["POST api/local-assets/install", { kind: "security", note: "project CRUD/members/assets/plugins пишут security_events (project-*-repository, securityEvent)" }],
    ["PATCH api/projects/:id", { kind: "security", note: "project CRUD/members/assets/plugins пишут security_events (project-*-repository, securityEvent)" }],
    ["PATCH api/projects/:id/quotas", { kind: "security", note: "project CRUD/members/assets/plugins пишут security_events (project-*-repository, securityEvent)" }],
    ["PATCH api/projects/:id/retention", { kind: "security", note: "project CRUD/members/assets/plugins пишут security_events (project-*-repository, securityEvent)" }],
    ["PATCH api/projects/:id/members/:userId", { kind: "security", note: "project CRUD/members/assets/plugins пишут security_events (project-*-repository, securityEvent)" }],
    ["PATCH api/projects/:id/assets/pin", { kind: "security", note: "project CRUD/members/assets/plugins пишут security_events (project-*-repository, securityEvent)" }],
    ["PATCH api/ai-plugins/:id", { kind: "security", note: "project CRUD/members/assets/plugins пишут security_events (project-*-repository, securityEvent)" }],
    ["DELETE api/projects/:id", { kind: "security", note: "project CRUD/members/assets/plugins пишут security_events (project-*-repository, securityEvent)" }],
    ["DELETE api/projects/:id/members/:userId", { kind: "security", note: "project CRUD/members/assets/plugins пишут security_events (project-*-repository, securityEvent)" }],
    ["DELETE api/projects/:id/assets", { kind: "security", note: "project CRUD/members/assets/plugins пишут security_events (project-*-repository, securityEvent)" }],
    ["DELETE api/ai-plugins/:id", { kind: "security", note: "project CRUD/members/assets/plugins пишут security_events (project-*-repository, securityEvent)" }],
    ["POST api/projects/:id/versions/:sid/activate", { kind: "operations", note: "snapshot commands (activate/rollback/cancel/release-profile/delete) пишут operations в snapshots" }],
    ["POST api/projects/:id/versions/:sid/rollback", { kind: "operations", note: "snapshot commands (activate/rollback/cancel/release-profile/delete) пишут operations в snapshots" }],
    ["POST api/projects/:id/versions/:sid/cancel", { kind: "operations", note: "snapshot commands (activate/rollback/cancel/release-profile/delete) пишут operations в snapshots" }],
    ["POST api/projects/:id/release-profile", { kind: "operations", note: "snapshot commands (activate/rollback/cancel/release-profile/delete) пишут operations в snapshots" }],
    ["DELETE api/projects/:id/versions/:sid", { kind: "operations", note: "snapshot commands (activate/rollback/cancel/release-profile/delete) пишут operations в snapshots" }],
    ["POST api/catalog-requests/", { kind: "operations", note: "catalog-requests create/action/edit пишут operations в request.repository" }],
    ["POST api/catalog-requests/:id/actions", { kind: "operations", note: "catalog-requests create/action/edit пишут operations в request.repository" }],
    ["PATCH api/catalog-requests/:id", { kind: "operations", note: "catalog-requests create/action/edit пишут operations в request.repository" }],
    ["PUT api/chat-presence/session", { kind: "allow", note: "chat-presence session update, idempotent presence, не admin-мутация" }],
    ["POST api/projects/:projectId/chat-search/index", { kind: "operations", note: "chat-search index/search/cancel пишут operations в chat-search.repository" }],
    ["POST api/projects/:projectId/chat-search/search", { kind: "operations", note: "chat-search index/search/cancel пишут operations в chat-search.repository" }],
    ["DELETE api/projects/:projectId/chat-search/jobs/:id", { kind: "operations", note: "chat-search index/search/cancel пишут operations в chat-search.repository" }],
    ["POST api/chat-system-roles/origin", { kind: "allow", note: "chat-system-roles origin bind, не admin-конфигурация" }],
    ["POST /api/device-pairs/:code/approve", { kind: "security", note: "device.pair пишет security_event в транзакции approve; resourceId — digest кода (AD-O8)" }],
    ["POST /api/device-jobs", { kind: "operations", note: "device jobs/pair/install-plan пишут operations в device-operations/device-jobs/install-plans" }],
    ["POST /api/device-jobs/:id/retry", { kind: "operations", note: "device jobs/pair/install-plan пишут operations в device-operations/device-jobs/install-plans" }],
    ["POST /internal/device-channel/pair/start", { kind: "operations", note: "device jobs/pair/install-plan пишут operations в device-operations/device-jobs/install-plans" }],
    ["POST /internal/device-channel/pair/poll", { kind: "operations", note: "device jobs/pair/install-plan пишут operations в device-operations/device-jobs/install-plans" }],
    ["POST /internal/device-channel/identity", { kind: "operations", note: "device jobs/pair/install-plan пишут operations в device-operations/device-jobs/install-plans" }],
    ["POST /internal/device-channel/heartbeat", { kind: "operations", note: "device jobs/pair/install-plan пишут operations в device-operations/device-jobs/install-plans" }],
    ["POST /internal/device-channel/presence", { kind: "operations", note: "device jobs/pair/install-plan пишут operations в device-operations/device-jobs/install-plans" }],
    ["POST /internal/device-channel/jobs/claim", { kind: "operations", note: "device jobs/pair/install-plan пишут operations в device-operations/device-jobs/install-plans" }],
    ["POST /internal/device-channel/worker/pause", { kind: "operations", note: "device jobs/pair/install-plan пишут operations в device-operations/device-jobs/install-plans" }],
    ["POST /internal/device-channel/worker/resume", { kind: "operations", note: "device jobs/pair/install-plan пишут operations в device-operations/device-jobs/install-plans" }],
    ["POST /internal/device-channel/worker/update-cleanup/authorize", { kind: "operations", note: "device jobs/pair/install-plan пишут operations в device-operations/device-jobs/install-plans" }],
    ["POST /internal/device-channel/jobs/:id/authorize", { kind: "operations", note: "device jobs/pair/install-plan пишут operations в device-operations/device-jobs/install-plans" }],
    ["POST /internal/device-channel/agents/compile", { kind: "operations", note: "device jobs/pair/install-plan пишут operations в device-operations/device-jobs/install-plans" }],
    ["POST /internal/device-channel/configuration-authorize", { kind: "operations", note: "device jobs/pair/install-plan пишут operations в device-operations/device-jobs/install-plans" }],
    ["POST /internal/device-channel/project-configuration/authorize", { kind: "operations", note: "device jobs/pair/install-plan пишут operations в device-operations/device-jobs/install-plans" }],
    ["POST /internal/device-channel/opencode-provider/authorize", { kind: "operations", note: "device jobs/pair/install-plan пишут operations в device-operations/device-jobs/install-plans" }],
    ["POST /internal/device-channel/opencode-global-providers/authorize", { kind: "operations", note: "device jobs/pair/install-plan пишут operations в device-operations/device-jobs/install-plans" }],
    ["POST /internal/device-channel/embedding/context", { kind: "operations", note: "device jobs/pair/install-plan пишут operations в device-operations/device-jobs/install-plans" }],
    ["POST /internal/device-channel/codex-inference/context", { kind: "operations", note: "device jobs/pair/install-plan пишут operations в device-operations/device-jobs/install-plans" }],
    ["POST /internal/device-channel/codex-inference/dispatch", { kind: "operations", note: "device jobs/pair/install-plan пишут operations в device-operations/device-jobs/install-plans" }],
    ["POST /internal/device-channel/embedding", { kind: "operations", note: "device jobs/pair/install-plan пишут operations в device-operations/device-jobs/install-plans" }],
    ["POST /internal/device-channel/jobs/:id/progress", { kind: "operations", note: "device jobs/pair/install-plan пишут operations в device-operations/device-jobs/install-plans" }],
    ["POST /internal/device-channel/jobs/:id/complete", { kind: "operations", note: "device jobs/pair/install-plan пишут operations в device-operations/device-jobs/install-plans" }],
    ["DELETE /api/devices/:id", { kind: "security", note: "device.revoke пишет security_event атомарно с отзывом в транзакции (P0-RES/AD-O7)" }],
    ["DELETE /api/device-jobs/:id", { kind: "operations", note: "device jobs/pair/install-plan пишут operations в device-operations/device-jobs/install-plans" }],
    ["POST api/device-install-plans/", { kind: "operations", note: "install-plan prepare/approve/revoke пишут operations в install-plans" }],
    ["POST api/device-install-plans/:id/approve", { kind: "operations", note: "install-plan prepare/approve/revoke пишут operations в install-plans" }],
    ["POST api/device-install-plans/:id/revoke", { kind: "operations", note: "install-plan prepare/approve/revoke пишут operations в install-plans" }],
    ["POST /internal/device-channel/mcp-host/authorize", { kind: "operations", note: "mcp-host authorize пишет operations через device-channel authorize" }],
    ["POST /internal/mcp-host/authorize-session", { kind: "operations", note: "mcp-host authorize пишет operations через device-channel authorize" }],
    ["POST api/discussions/comments", { kind: "allow", note: "discussions comments/attachments — пользовательский контент в domain-таблицах, не admin-конфигурация" }],
    ["POST api/discussions/attachments", { kind: "allow", note: "discussions comments/attachments — пользовательский контент в domain-таблицах, не admin-конфигурация" }],
    ["PATCH api/discussions/comments/:id", { kind: "allow", note: "discussions comments/attachments — пользовательский контент в domain-таблицах, не admin-конфигурация" }],
    ["DELETE api/discussions/comments/:id", { kind: "allow", note: "discussions comments/attachments — пользовательский контент в domain-таблицах, не admin-конфигурация" }],
    ["DELETE api/discussions/attachments/:id", { kind: "allow", note: "discussions comments/attachments — пользовательский контент в domain-таблицах, не admin-конфигурация" }],
    ["PUT api/catalog-reactions/", { kind: "allow", note: "discussions comments/attachments — пользовательский контент в domain-таблицах, не admin-конфигурация" }],
    ["PUT api/catalog-reactions/:kind/:id", { kind: "allow", note: "discussions comments/attachments — пользовательский контент в domain-таблицах, не admin-конфигурация" }],
    ["DELETE api/catalog-reactions/", { kind: "allow", note: "discussions comments/attachments — пользовательский контент в domain-таблицах, не admin-конфигурация" }],
    ["DELETE api/catalog-reactions/:kind/:id", { kind: "allow", note: "discussions comments/attachments — пользовательский контент в domain-таблицах, не admin-конфигурация" }],
    ["PUT api/help/:slug", { kind: "security", note: "help save пишет security_event help.article.update (без полного контента, AD-O8)" }],
    ["POST internal/device-channel/learning/context", { kind: "allow", note: "internal device-channel learning context/record/observe/propose — device-протокол, не admin-мутация" }],
    ["POST internal/device-channel/learning/record", { kind: "allow", note: "internal device-channel learning context/record/observe/propose — device-протокол, не admin-мутация" }],
    ["POST internal/device-channel/learning/observe", { kind: "allow", note: "internal device-channel learning context/record/observe/propose — device-протокол, не admin-мутация" }],
    ["POST internal/device-channel/learning/propose", { kind: "allow", note: "internal device-channel learning context/record/observe/propose — device-протокол, не admin-мутация" }],
    ["POST api/projects/:id/learning/analyses/", { kind: "operations", note: "learning analysis пишет operations в learning-repository" }],
    ["POST api/projects/:id/learning/experiences", { kind: "operations", note: "learning analyses/experiences/hypotheses/candidates пишут operations в learning-repository" }],
    ["POST api/projects/:id/learning/hypotheses", { kind: "operations", note: "learning analyses/experiences/hypotheses/candidates пишут operations в learning-repository" }],
    ["POST api/projects/:id/learning/hypotheses/:hypothesisId/checks", { kind: "operations", note: "learning analyses/experiences/hypotheses/candidates пишут operations в learning-repository" }],
    ["POST api/projects/:id/learning/candidates", { kind: "operations", note: "learning analyses/experiences/hypotheses/candidates пишут operations в learning-repository" }],
    ["POST api/projects/:id/learning/candidates/:candidateId/approve", { kind: "operations", note: "learning analyses/experiences/hypotheses/candidates пишут operations в learning-repository" }],
    ["POST api/projects/:id/learning/candidates/:candidateId/reject", { kind: "operations", note: "learning analyses/experiences/hypotheses/candidates пишут operations в learning-repository" }],
    ["POST api/projects/:id/learning/candidates/:candidateId/revoke", { kind: "operations", note: "learning analyses/experiences/hypotheses/candidates пишут operations в learning-repository" }],
    ["POST api/projects/:id/learning/candidates/:candidateId/activate", { kind: "operations", note: "learning analyses/experiences/hypotheses/candidates пишут operations в learning-repository" }],
    ["POST internal/device-channel/learning-quirks/import", { kind: "operations", note: "learning-quirks import пишет operations/security в learning-quirks" }],
    ["PATCH api/maintenance/policy", { kind: "operations", note: "maintenance backup/policy пишут operations в maintenance" }],
    ["PATCH api/maintenance/rag-quota-policy/", { kind: "operations", note: "rag-quota-policy save пишет operations в maintenance" }],
    ["POST api/model-chats/", { kind: "allow", note: "model-chat turns/attachments — пользовательский чат-контент, не admin-конфигурация" }],
    ["POST api/model-chats/:id/attachments", { kind: "allow", note: "model-chat turns/attachments — пользовательский чат-контент, не admin-конфигурация" }],
    ["POST api/model-chats/:id/context-preview", { kind: "allow", note: "model-chat turns/attachments — пользовательский чат-контент, не admin-конфигурация" }],
    ["POST api/model-chats/:id/turns", { kind: "allow", note: "model-chat turns/attachments — пользовательский чат-контент, не admin-конфигурация" }],
    ["POST api/model-chats/:id/turns/:turnId/retry", { kind: "allow", note: "model-chat turns/attachments — пользовательский чат-контент, не admin-конфигурация" }],
    ["POST api/model-chats/:id/turns/:turnId/cancel", { kind: "allow", note: "model-chat turns/attachments — пользовательский чат-контент, не admin-конфигурация" }],
    ["POST api/model-chats/:id/turns/:turnId/complete", { kind: "allow", note: "model-chat turns/attachments — пользовательский чат-контент, не admin-конфигурация" }],
    ["PATCH api/model-chats/:id", { kind: "allow", note: "model-chat turns/attachments — пользовательский чат-контент, не admin-конфигурация" }],
    ["PUT api/model-chats/:id/participants", { kind: "allow", note: "model-chat turns/attachments — пользовательский чат-контент, не admin-конфигурация" }],
    ["DELETE api/model-chats/:id", { kind: "allow", note: "model-chat turns/attachments — пользовательский чат-контент, не admin-конфигурация" }],
    ["DELETE api/model-chats/:id/attachments/:attachmentId", { kind: "allow", note: "model-chat turns/attachments — пользовательский чат-контент, не admin-конфигурация" }],
    ["DELETE api/model-chats/:id/turns/:turnId", { kind: "allow", note: "model-chat turns/attachments — пользовательский чат-контент, не admin-конфигурация" }],
    ["PUT api/models/:id/rate-limit", { kind: "security", note: "model.rate-limit.update пишет security_event в транзакции trySave (FR-903/AD-O7)" }],
    ["PUT api/models/:id/token-quotas/:email", { kind: "security", note: "model.token-quota.update пишет security_event после записи квоты (FR-903/AD-O7)" }],
    ["POST api/models/:id/device-connection/check", { kind: "operations", note: "device-codex operation пишет operations в device-codex-operation" }],
    ["POST api/models/gguf-imports/", { kind: "operations", note: "gguf-imports create/accept/content/cancel пишут operations в models-repository" }],
    ["POST api/models/gguf-imports/:id/accept", { kind: "operations", note: "gguf-imports create/accept/content/cancel пишут operations в models-repository" }],
    ["PUT api/models/gguf-imports/:id/content", { kind: "operations", note: "gguf-imports create/accept/content/cancel пишут operations в models-repository" }],
    ["DELETE api/models/gguf-imports/:id", { kind: "operations", note: "gguf-imports create/accept/content/cancel пишут operations в models-repository" }],
    ["POST api/models/:id/hosting", { kind: "operations", note: "models hosting control пишет operations в hosting.repository" }],
    ["POST api/models/:id/ollama/api/embed", { kind: "allow", note: "ollama inference passthrough (embed/chat/completions), не мутация состояния каталога" }],
    ["POST api/models/:id/ollama/api/chat", { kind: "allow", note: "ollama inference passthrough (embed/chat/completions), не мутация состояния каталога" }],
    ["POST api/models/:id/ollama/v1/embeddings", { kind: "allow", note: "ollama inference passthrough (embed/chat/completions), не мутация состояния каталога" }],
    ["POST api/models/:id/ollama/v1/chat/completions", { kind: "allow", note: "ollama inference passthrough (embed/chat/completions), не мутация состояния каталога" }],
    ["POST api/models", { kind: "operations", note: "models CRUD/version/assign пишут operations в models-repository/hosting" }],
    ["POST api/models/:id/versions/:v/retire", { kind: "operations", note: "models CRUD/version/assign пишут operations в models-repository/hosting" }],
    ["POST api/projects/:id/models", { kind: "operations", note: "models CRUD/version/assign пишут operations в models-repository/hosting" }],
    ["PATCH api/models/:id", { kind: "operations", note: "models CRUD/version/assign пишут operations в models-repository/hosting" }],
    ["DELETE api/models/:id", { kind: "operations", note: "models CRUD/version/assign пишут operations в models-repository/hosting" }],
    ["DELETE api/projects/:id/models/:modelId", { kind: "operations", note: "models CRUD/version/assign пишут operations в models-repository/hosting" }],
    ["POST /internal/device-channel/opencode-models/context", { kind: "allow", note: "opencode-model-sync context/snapshot/configure — device-протокол синхронизации, не admin-мутация" }],
    ["POST /internal/device-channel/opencode-models/sync", { kind: "allow", note: "opencode-model-sync context/snapshot/configure — device-протокол синхронизации, не admin-мутация" }],
    ["PUT /api/devices/:id/opencode-model-sync", { kind: "allow", note: "opencode-model-sync context/snapshot/configure — device-протокол синхронизации, не admin-мутация" }],
    ["PATCH api/projects/:id/embedding", { kind: "security", note: "project-embedding update/target пишут security_events в project-embedding.repository" }],
    ["PATCH api/projects/:id/embedding/target", { kind: "security", note: "project-embedding update/target пишут security_events в project-embedding.repository" }],
    ["POST api/rag/sync", { kind: "operations", note: "project-rag write-authorize/sync пишет operations в project-rag" }],
    ["POST internal/project-rag/write-authorize", { kind: "operations", note: "project-rag write-authorize/sync пишет operations в project-rag" }],
    ["POST api/projects/:projectId/embedding/reindex/", { kind: "operations", note: "embedding reindex пишут operations в models/project-rag" }],
    ["POST api/projects/:projectId/embedding/reindex/:id/start", { kind: "operations", note: "embedding reindex пишут operations в models/project-rag" }],
    ["POST api/projects/:projectId/embedding/reindex/:id/local-retry", { kind: "operations", note: "embedding reindex пишут operations в models/project-rag" }],
    ["POST api/projects/:projectId/embedding/reindex/:id/retry", { kind: "operations", note: "embedding reindex пишут operations в models/project-rag" }],
    ["POST api/projects/:projectId/embedding/reindex/:id/cancel", { kind: "operations", note: "embedding reindex пишут operations в models/project-rag" }],
    ["POST internal/project-rag/reindex-embedding", { kind: "operations", note: "embedding reindex пишут operations в models/project-rag" }],
    ["POST api/models/import-opencode", { kind: "security", note: "remote-connection check/... пишут security_events в remote-connection.repository" }],
    ["PUT api/models/:id/connection", { kind: "security", note: "remote-connection check/... пишут security_events в remote-connection.repository" }],
    ["DELETE api/models/:id/connection", { kind: "security", note: "remote-connection check/... пишут security_events в remote-connection.repository" }],
    ["POST api/operations/:id/retry", { kind: "operations", note: "operations retry/cancel пишут operations (само-операции)" }],
    ["POST api/operations/:id/cancel", { kind: "operations", note: "operations retry/cancel пишут operations (само-операции)" }],
    ["POST api/tool-builds/archive", { kind: "operations", note: "package-build/tool-builds create/archive/import/cancel пишут operations в package-build.repository" }],
    ["POST api/tool-builds/imports", { kind: "operations", note: "package-build/tool-builds create/archive/import/cancel пишут operations в package-build.repository" }],
    ["POST api/tool-builds/", { kind: "operations", note: "package-build/tool-builds create/archive/import/cancel пишут operations в package-build.repository" }],
    ["DELETE api/tool-builds/requests/:requestKey", { kind: "operations", note: "package-build/tool-builds create/archive/import/cancel пишут operations в package-build.repository" }],
    ["DELETE api/tool-builds/:id", { kind: "operations", note: "package-build/tool-builds create/archive/import/cancel пишут operations в package-build.repository" }],
    ["PUT api/plugin-auto-updates/", { kind: "operations", note: "plugin-auto-updates save пишет operations в auto-update.repository" }],
    ["POST api/projects/:projectId/team-chat/messages", { kind: "allow", note: "project-chat team-chat messages/rooms — пользовательский чат-контент, не admin-конфигурация" }],
    ["POST api/projects/:projectId/team-chat/messages/:messageId/retry", { kind: "allow", note: "project-chat team-chat messages/rooms — пользовательский чат-контент, не admin-конфигурация" }],
    ["POST api/projects/:projectId/team-chat/messages/:messageId/cancel", { kind: "allow", note: "project-chat team-chat messages/rooms — пользовательский чат-контент, не admin-конфигурация" }],
    ["POST api/projects/:projectId/team-chat/rooms", { kind: "allow", note: "project-chat team-chat messages/rooms — пользовательский чат-контент, не admin-конфигурация" }],
    ["POST api/projects/:projectId/team-chat/rooms/:roomId/messages", { kind: "allow", note: "project-chat team-chat messages/rooms — пользовательский чат-контент, не admin-конфигурация" }],
    ["POST api/projects/:projectId/team-chat/rooms/:roomId/messages/:messageId/retry", { kind: "allow", note: "project-chat team-chat messages/rooms — пользовательский чат-контент, не admin-конфигурация" }],
    ["POST api/projects/:projectId/team-chat/rooms/:roomId/messages/:messageId/cancel", { kind: "allow", note: "project-chat team-chat messages/rooms — пользовательский чат-контент, не admin-конфигурация" }],
    ["PUT api/projects/:projectId/team-chat/activity", { kind: "allow", note: "project-chat team-chat messages/rooms — пользовательский чат-контент, не admin-конфигурация" }],
    ["PUT api/projects/:projectId/team-chat/participants", { kind: "allow", note: "project-chat team-chat messages/rooms — пользовательский чат-контент, не admin-конфигурация" }],
    ["PUT api/projects/:projectId/team-chat/rooms/:roomId/activity", { kind: "allow", note: "project-chat team-chat messages/rooms — пользовательский чат-контент, не admin-конфигурация" }],
    ["PUT api/projects/:projectId/team-chat/rooms/:roomId", { kind: "allow", note: "project-chat team-chat messages/rooms — пользовательский чат-контент, не admin-конфигурация" }],
    ["PUT api/projects/:projectId/team-chat/rooms/:roomId/participants", { kind: "allow", note: "project-chat team-chat messages/rooms — пользовательский чат-контент, не admin-конфигурация" }],
    ["POST internal/projects/:id/quota-usage", { kind: "allow", note: "internal quota-usage report, не admin-мутация" }],
    ["POST api/projects/:id/knowledge/text/documents", { kind: "allow", note: "project-text documents/search/authorize — контент и internal authorize, не admin-конфигурация" }],
    ["POST api/projects/:id/knowledge/text/search", { kind: "allow", note: "project-text documents/search/authorize — контент и internal authorize, не admin-конфигурация" }],
    ["POST internal/project-text/authorize", { kind: "allow", note: "project-text documents/search/authorize — контент и internal authorize, не admin-конфигурация" }],
    ["POST internal/skill-audit/events", { kind: "operations", note: "internal skill-audit events приём (каталог-сторона outbox)" }],
    ["POST internal/skill-dependencies/reserve", { kind: "operations", note: "internal skill-dependencies reserve (каталог-сторона outbox)" }],
    ["PUT api/models/:id/my-access", { kind: "operations", note: "remote-providers пишут operations в remote-provider.repository" }],
    ["DELETE api/models/:id/my-access", { kind: "operations", note: "remote-providers пишут operations в remote-provider.repository" }],
    ["POST api/maintenance/restore/previews", { kind: "operations", note: "maintenance restore report/pulse/retired-rag preview/purge/authorize пишут operations в restore/retired-rag" }],
    ["POST api/maintenance/restore/", { kind: "operations", note: "maintenance restore report/pulse/retired-rag preview/purge/authorize пишут operations в restore/retired-rag" }],
    ["POST api/maintenance/restore/requests/:key/cancel", { kind: "operations", note: "maintenance restore report/pulse/retired-rag preview/purge/authorize пишут operations в restore/retired-rag" }],
    ["POST api/maintenance/restore/jobs/:id/cancel", { kind: "operations", note: "maintenance restore report/pulse/retired-rag preview/purge/authorize пишут operations в restore/retired-rag" }],
    ["POST internal/maintenance/restore/report", { kind: "operations", note: "maintenance restore report/pulse/retired-rag preview/purge/authorize пишут operations в restore/retired-rag" }],
    ["POST internal/maintenance/restore/claim", { kind: "operations", note: "maintenance restore report/pulse/retired-rag preview/purge/authorize пишут operations в restore/retired-rag" }],
    ["POST internal/maintenance/restore/jobs/:id/pulse", { kind: "operations", note: "maintenance restore report/pulse/retired-rag preview/purge/authorize пишут operations в restore/retired-rag" }],
    ["POST internal/maintenance/restore/jobs/:id/complete", { kind: "operations", note: "maintenance restore report/pulse/retired-rag preview/purge/authorize пишут operations в restore/retired-rag" }],
    ["POST /api/maintenance/retired-rag-databases/:id/preview", { kind: "operations", note: "retired-rag purges/retirements authorize пишут operations в retired-rag" }],
    ["POST /api/maintenance/retired-rag-databases/:id/purge", { kind: "operations", note: "retired-rag purges/retirements authorize пишут operations в retired-rag" }],
    ["POST /api/maintenance/retired-rag-purges/:id/retry", { kind: "operations", note: "retired-rag purges/retirements authorize пишут operations в retired-rag" }],
    ["POST /internal/retired-rag/purges/:id/authorize", { kind: "operations", note: "retired-rag purges/retirements authorize пишут operations в retired-rag" }],
    ["POST /internal/retired-rag/retirements/:id/authorize-preview", { kind: "operations", note: "retired-rag purges/retirements authorize пишут operations в retired-rag" }],
    ["PATCH /api/maintenance/retired-rag-databases/:id/retention", { kind: "operations", note: "retired-rag purges/retirements authorize пишут operations в retired-rag" }],
    ["PATCH api/runtime-limits/admin", { kind: "operations", note: "runtime-limits пишет operations в runtime-limits.service" }],
    ["POST internal/project-snapshots/verifier/gc", { kind: "operations", note: "snapshot-verifier gc/renew пишет operations в snapshots" }],
    ["POST internal/project-snapshots/verifier/claim", { kind: "operations", note: "snapshot-verifier gc/renew пишет operations в snapshots" }],
    ["POST internal/project-snapshots/verifier/:id/renew", { kind: "operations", note: "snapshot-verifier gc/renew пишет operations в snapshots" }],
    ["POST internal/project-snapshots/verifier/:id/complete", { kind: "operations", note: "snapshot-verifier gc/renew пишет operations в snapshots" }],
    ["POST internal/project-snapshots/verifier/:id/reject", { kind: "operations", note: "snapshot-verifier gc/renew пишет operations в snapshots" }],
    ["POST api/projects/:id/versions", { kind: "operations", note: "snapshots uploads/manifest/complete/blobs/gc/renew пишут operations в snapshots" }],
    ["POST api/projects/:id/versions/commands/:key/cancel", { kind: "operations", note: "snapshots uploads/manifest/complete/blobs/gc/renew пишут operations в snapshots" }],
    ["POST api/projects/:id/versions/requests/:key/cancel", { kind: "operations", note: "snapshots uploads/manifest/complete/blobs/gc/renew пишут operations в snapshots" }],
    ["POST api/projects/:id/snapshot-uploads/:sid/manifest", { kind: "operations", note: "snapshots uploads/manifest/complete/blobs/gc/renew пишут operations в snapshots" }],
    ["POST api/projects/:id/snapshot-uploads/:sid/complete", { kind: "operations", note: "snapshots uploads/manifest/complete/blobs/gc/renew пишут operations в snapshots" }],
    ["PUT api/projects/:id/snapshot-uploads/:sid/blobs/:sha", { kind: "operations", note: "snapshots uploads/manifest/complete/blobs/gc/renew пишут operations в snapshots" }],
    ["POST api/tool-builds/uploads/", { kind: "allow", note: "source-upload — загрузка blob-контента, не admin-конфигурация" }],
    ["PUT api/tool-builds/uploads/:id/content", { kind: "allow", note: "source-upload — загрузка blob-контента, не admin-конфигурация" }],
    ["DELETE api/tool-builds/uploads/requests/:key", { kind: "allow", note: "source-upload — загрузка blob-контента, не admin-конфигурация" }],
    ["DELETE api/tool-builds/uploads/:id", { kind: "allow", note: "source-upload — загрузка blob-контента, не admin-конфигурация" }],
    ["POST api/system-role-chats/", { kind: "allow", note: "system-role-chats dialog/turns — системный чат-контент, не admin-конфигурация" }],
    ["POST api/system-role-chats/:dialogId/prepare", { kind: "allow", note: "system-role-chats dialog/turns — системный чат-контент, не admin-конфигурация" }],
    ["POST api/system-role-chats/:dialogId/turns", { kind: "allow", note: "system-role-chats dialog/turns — системный чат-контент, не admin-конфигурация" }],
    ["POST api/system-role-chats/:dialogId/turns/:turnId/cancel", { kind: "allow", note: "system-role-chats dialog/turns — системный чат-контент, не admin-конфигурация" }],
    ["POST /api/system-role-mcp/discover", { kind: "allow", note: "internal system-role-mcp discover/context/dispatch/result — device-протокол, не admin-мутация" }],
    ["POST /internal/system-role-mcp/context", { kind: "allow", note: "internal system-role-mcp discover/context/dispatch/result — device-протокол, не admin-мутация" }],
    ["POST /internal/system-role-mcp/dispatch", { kind: "allow", note: "internal system-role-mcp discover/context/dispatch/result — device-протокол, не admin-мутация" }],
    ["POST /internal/system-role-mcp/result", { kind: "allow", note: "internal system-role-mcp discover/context/dispatch/result — device-протокол, не admin-мутация" }],
    ["POST /internal/device-channel/system-role-mcp/claim", { kind: "allow", note: "internal system-role-mcp discover/context/dispatch/result — device-протокол, не admin-мутация" }],
    ["POST /internal/device-channel/system-role-mcp/authorize", { kind: "allow", note: "internal system-role-mcp discover/context/dispatch/result — device-протокол, не admin-мутация" }],
    ["POST /internal/device-channel/system-role-mcp/context", { kind: "allow", note: "internal system-role-mcp discover/context/dispatch/result — device-протокол, не admin-мутация" }],
    ["POST /internal/device-channel/system-role-mcp/next", { kind: "allow", note: "internal system-role-mcp discover/context/dispatch/result — device-протокол, не admin-мутация" }],
    ["POST /internal/device-channel/system-role-mcp/dispatch", { kind: "allow", note: "internal system-role-mcp discover/context/dispatch/result — device-протокол, не admin-мутация" }],
    ["POST /internal/device-channel/system-role-mcp/result", { kind: "allow", note: "internal system-role-mcp discover/context/dispatch/result — device-протокол, не admin-мутация" }],
    ["POST /internal/device-channel/system-role-mcp/complete", { kind: "allow", note: "internal system-role-mcp discover/context/dispatch/result — device-протокол, не admin-мутация" }],
    ["POST api/system-roles/:agentId/prepare", { kind: "operations", note: "system-roles prepare/runs/cancel/apply/rollback пишут operations в system-role.operations" }],
    ["POST api/system-roles/:agentId/runs", { kind: "operations", note: "system-roles prepare/runs/cancel/apply/rollback пишут operations в system-role.operations" }],
    ["POST api/system-roles/:agentId/runs/:runId/cancel", { kind: "operations", note: "system-roles prepare/runs/cancel/apply/rollback пишут operations в system-role.operations" }],
    ["POST api/system-roles/:agentId/runs/:runId/apply", { kind: "operations", note: "system-roles prepare/runs/cancel/apply/rollback пишут operations в system-role.operations" }],
    ["POST api/system-roles/:agentId/runs/:runId/rollback", { kind: "operations", note: "system-roles prepare/runs/cancel/apply/rollback пишут operations в system-role.operations" }],
];

describe('FR-903/AD-O7 fail-test: аудит admin-мутаций без пропусков', () => {
    const routes = inventoryRoutes();
    const coverageKeys = COVERAGE.map(([key]) => key);

    it('инвентарь пересобирается из контроллеров и непуст', () => {
        expect(routes.length).toBeGreaterThanOrEqual(240);
        expect(routes).toContain('POST /internal/security-events');
    });

    it('каждый мутационный роут классифицирован (operations | security_events | allowlist)', () => {
        const known = new Set(coverageKeys);
        const missing = [...new Set(routes)].filter((key) => !known.has(key));
        expect(missing).toEqual([]);
    });

    it('в таблице нет устаревших записей (роут удалён из контроллеров)', () => {
        const routeSet = new Set(routes);
        const stale = coverageKeys.filter((key) => !routeSet.has(key));
        expect(stale).toEqual([]);
    });

    it('каждая запись имеет допустимый kind и конкретную причину', () => {
        const valid = new Set(['operations', 'security', 'allow']);
        for (const [key, entry] of COVERAGE) {
            expect(valid.has(entry.kind), `kind для ${key}`).toBe(true);
            expect(entry.note.length, `note для ${key}`).toBeGreaterThan(10);
            expect(entry.note.includes('не классифицировано'), `placeholder для ${key}`).toBe(false);
        }
    });

    it('P0-RES события классифицированы как security', () => {
        const byKey = new Map(COVERAGE);
        expect(byKey.get('DELETE /api/devices/:id')?.kind).toBe('security');
        expect(byKey.get('POST /api/device-pairs/:code/approve')?.kind).toBe('security');
        expect(byKey.get('POST /internal/security-events')?.kind).toBe('security');
    });
});
