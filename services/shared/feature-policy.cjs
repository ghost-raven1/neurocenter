'use strict';
const {canonicalAccessRoute}=require('./access-route.cjs');
const record=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const unique=keys=>[...new Set(keys)];

/** Recovery/removal jobs remain usable when every business capability is disabled. */
function requiredJobFeatures(kind,payload={},trustedPayload=false){
    const input=record(payload);
    if(kind==='import-learning-quirks')return ['project_learning_quirks'];
    if(kind==='sync-learning-memory')return (trustedPayload?record(input.memory).mode:input.memoryMode)==='cleanup'?[]:['project_learning_memory'];
    if(['uninstall','restore-rag','inspect-installation','list-local-variants','prepare-local-restore','apply-local-restore','open-local-change-report','open-local-recovery-folder','get-mcp-configuration-status','get-opencode-provider-status'].includes(kind))return [];
    if(['prepare-opencode-provider','open-opencode-provider'].includes(kind))return (trustedPayload?record(input.descriptor).providerKind:input.providerKind)==='codex-bridge'?['opencode_providers','codex_connector']:['opencode_providers'];
    if(['choose-root','prepare-bind-project','bind-project'].includes(kind))return (input.bindingMode==='resume'||input.mode==='resume')?[]:['computer_connections'];
    if(kind==='open-project-configuration')return ['project_configuration','computer_connections'];
    if(kind==='scan-opencode-models')return ['opencode_model_sync'];
    if(kind==='infer-device-codex')return ['device_codex_inference'];
    if(kind==='configure-project-agents')return trustedPayload&&Array.isArray(input.agents)&&input.agents.every(agent=>record(agent).enabled===false)?[]:['agents','computer_connections'];
    if(kind==='publish-project-snapshot')return ['project_snapshots','computer_connections'];
    if(['sync-rag','connect-rag-model'].includes(kind))return ['rag_sync'];
    if(['scan-project-inventory','prepare-adopt-installation','apply-adopt-installation','prepare-local-change','apply-local-change'].includes(kind))return ['local_changes'];
    if(['install','probe-runtime','prepare-mcp-configuration','open-mcp-configuration','open-rag-ui'].includes(kind))return ['tool_installation'];
    return [];
}

/** The native asset kind, never its display name, selects the publication dependency. */
function requiredAssetFeatures(kind){return kind==='model'?['model_catalog']:kind==='agent'?['agents']:['mcp','plugin','skill'].includes(kind)?['tool_catalog']:[];}
function requiredInferenceFeatures(purpose,agentId){
    if(purpose==='agent'&&agentId==='agent-packager')return ['tool_build_agent'];
    if(purpose==='agent'&&agentId==='agent-ai-admin')return ['system_ai_admin'];
    if(purpose==='agent'&&agentId==='agent-autoconfigurator')return ['system_autoconfigurator'];
    if(purpose==='agent'&&agentId==='agent-indexer')return ['system_indexer'];
    if(purpose==='research')return agentId?['group_chat','research_tools']:['research_tools'];
    if(purpose==='agent'||purpose==='compaction'&&agentId)return ['group_chat'];
    if(purpose==='chat'||purpose==='compaction')return ['model_chat'];
    if(purpose==='project-search')return ['project_search'];
    if(purpose==='learning')return ['project_learning','model_hosting'];
    return ['model_hosting'];
}

/** Shared admission policy. Stateful group/consent differences are rechecked by their owning services. */
function requiredRouteFeatures(method,path,body){
    const route=canonicalAccessRoute(path),verb=String(method).toUpperCase(),input=record(body),read=['GET','HEAD','OPTIONS'].includes(verb);
    if(!route)return [];
    if(/^\/api\/feature-flags(?:\/|$)/.test(route))return [];
    if(read){
        if(/^\/api\/tool-builds\/(npm|repository)$/.test(route))return ['tool_builds'];
        if(route==='/api/model-usage')return ['model_usage'];
        return [];
    }
    const systemRole=/^\/api\/system-roles\/(agent-packager|agent-ai-admin|agent-autoconfigurator|agent-indexer)\/(?:prepare|runs\/[^/]+\/apply)$/.exec(route);
    if(verb==='POST'&&systemRole)return requiredInferenceFeatures('agent',systemRole[1]);
    // Canonical role/chat executors check flags after accepted-request replay lookup.
    if(/^\/api\/system-role-chats(?:\/|$)/.test(route))return [];
    // Team-chat admissions preserve accepted replay and cleanup; fresh capabilities are checked by its executor.
    if(/^\/api\/projects\/[^/]+\/team-chat(?:\/|$)/.test(route))return [];
    if(/^\/api\/help\/[^/]+$/.test(route))return verb==='PUT'?['help_center']:[];
    // New admissions are checked by the executor after exact replay lookup.
    if(route==='/api/discussions/comments'&&verb==='POST')return [];
    if(route==='/api/discussions/attachments'&&verb==='POST')return ['discussions','discussion_attachments'];
    if(/^\/api\/discussions\/comments\/[^/]+$/.test(route))return verb==='PATCH'?['discussions']:[];
    if(/^\/api\/catalog-reactions(?:\/|$)/.test(route))return [];
    if(/^\/(?:api|internal)\/device-channel\//.test(route)){
        const suffix=route.replace(/^\/(?:api|internal)\/device-channel\//,'');
        if(suffix==='pair/start')return ['computer_connections'];
        if(['embedding','embedding/context'].includes(suffix))return ['model_hosting'];
        if(suffix.startsWith('opencode-models/'))return ['opencode_model_sync'];
        if(suffix==='agents/compile')return []; // Stateful authorize checks the trusted compiled snapshot, including cleanup.
        if(['learning/record','learning/observe','learning/propose'].includes(suffix))return ['project_learning'];
        return [];
    }
    if(/^\/internal\/research-mcp\/(list|call)$/.test(route))return ['research_tools','tool_catalog'];
    if(route==='/internal/asset-sources/skills/publish')return ['tool_catalog'];
    if(route==='/api/device-jobs'&&verb==='POST')return requiredJobFeatures(input.kind,input);
    if(/^\/api\/devices\/[^/]+\/opencode-model-sync$/.test(route))return input.enabled===false||input.transferCredentials===false?[]:['opencode_model_sync'];
    if(/^\/api\/model-chats(?:\/|$)/.test(route)){
        if(verb==='DELETE'||verb==='PATCH'||/\/(cancel|complete|context-preview)$/.test(route))return [];
        if(verb==='PUT'&&/\/participants$/.test(route))return [];
        if(verb==='POST'&&route==='/api/model-chats')return input.mode==='group'?['group_chat']:['model_chat'];
        if(verb==='POST'&&(/\/attachments$/.test(route)||/\/turns(?:\/[^/]+\/retry)?$/.test(route)))return input.research?unique(['model_chat','research_tools',...(record(input.research).project===true?['project_search']:[]),...(record(input.research).external?['tool_catalog']:[])]):['model_chat'];
        return [];
    }
    if(/^\/api\/projects\/[^/]+\/learning(?:\/|$)/.test(route)){
        if(/\/(revoke|reject)$/.test(route))return [];
        return /\/analyses$/.test(route)?['project_learning','model_hosting']:['project_learning'];
    }
    if(/^\/api\/models\/[^/]+\/ollama\//.test(route))return ['model_hosting'];
    if(/^\/api\/models\/[^/]+\/hosting$/.test(route))return input.action==='stop'?[]:['model_hosting'];
    if(route==='/api/models/import-opencode')return ['opencode_model_sync'];
    // Enforcement can be disabled without losing its administrative settings.
    if(/^\/api\/models\/[^/]+\/rate-limit$/.test(route))return [];
    if(/^\/api\/models(?:\/|$)/.test(route)||/^\/api\/projects\/[^/]+\/models(?:\/|$)/.test(route))return verb==='DELETE'?[]:['model_catalog'];
    if(/^\/api\/projects\/[^/]+\/embedding$/.test(route))return ['model_catalog','rag_sync'];
    if(/^\/api\/projects\/[^/]+\/embedding\/reindex(?:\/|$)/.test(route))return /\/cancel$/.test(route)?[]:['rag_sync'];
    if(route==='/api/rag/sync')return ['rag_sync'];
    if(route==='/api/rag/search')return ['project_search'];
    // Stateful trial admission preserves exact request replay and cancellation after flags are disabled.
    if(/^\/api\/projects\/[^/]+\/agents\/[^/]+\/readiness-trials(?:\/[^/]+(?:\/cancel)?)?$/.test(route))return [];
    if(/^\/api\/projects\/[^/]+\/agents\/connect$/.test(route))return [];
    if(/^\/api\/agents(?:\/|$)/.test(route)||/^\/api\/projects\/[^/]+\/agents(?:\/|$)/.test(route))return verb==='DELETE'||input.enabled===false?[]:['agents'];
    if(verb==='GET'&&route==='/api/tool-builds/connectors/codex')return [];
    if(/^\/api\/tool-builds(?:\/|$)/.test(route))return verb==='DELETE'?[]:unique(['tool_builds',...(route==='/api/tool-builds'||route==='/api/tool-builds/imports'?requiredAssetFeatures(input.kind??record(input.asset).kind):[])]);
    if(/^\/api\/(?:asset-sources|asset-imports|bridge-source)(?:\/|$)/.test(route))return /\/cancel$/.test(route)?[]:['asset_sources'];
    if(/^\/api\/device-install-plans(?:\/|$)/.test(route))return /\/(revoke|cancel)$/.test(route)?[]:['tool_installation'];
    if(/^\/api\/ai-plugins(?:\/|$)/.test(route)||/^\/api\/skills(?:\/|$)/.test(route)||/^\/api\/projects\/[^/]+\/assets(?:\/|$)/.test(route))return verb==='DELETE'?[]:['tool_catalog'];
    if(route==='/api/maintenance/backup')return ['project_backups'];
    if(route==='/api/local-assets/install')return unique(['asset_sources',...requiredAssetFeatures(input.kind)]);
    if(/^\/api\/projects\/[^/]+\/backups$/.test(route))return ['project_backups'];
    if(/^\/api\/projects\/[^/]+\/snapshot-uploads\/[^/]+\/complete$/.test(route))return [];
    if(/^\/api\/projects\/[^/]+\/(?:versions|snapshot-uploads|release-profile)(?:\/|$)/.test(route))return verb==='DELETE'||/\/(cancel|activate|rollback)$/.test(route)||/\/commands\/[^/]+\/cancel$/.test(route)||/\/requests\/[^/]+\/cancel$/.test(route)?[]:['project_snapshots'];
    if(/^\/api\/catalog-requests(?:\/|$)/.test(route))return ['withdraw','reject'].includes(input.action)?[]:['catalog_requests'];
    if(route==='/api/projects'||/^\/api\/projects\/[^/]+$/.test(route))return verb==='DELETE'?[]:['projects'];
    return [];
}
module.exports={requiredRouteFeatures,requiredJobFeatures,requiredAssetFeatures,requiredInferenceFeatures};
