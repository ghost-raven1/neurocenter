import {logServices,packages,DiagnosticError} from './constants.mjs';
import {outputSchemas} from './output-schemas.mjs';

export const serverVersion='0.4.0';
export const coverageReportPattern='^\\.run/coverage/[A-Za-z0-9][A-Za-z0-9._-]{0,127}/manifest\\.json$';
export const verificationReportPattern='^\\.run/(?:coverage/[A-Za-z0-9][A-Za-z0-9._-]{0,127}/manifest\\.json|check/[A-Za-z0-9][A-Za-z0-9._-]{0,127}/report\\.json|isolated-build/[A-Za-z0-9][A-Za-z0-9._-]{0,127}/receipt\\.json)$';
export const packageNames=packages.map(([name])=>name);
export const checkSteps=['lint','format:check','typecheck','build','test'];
const empty={type:'object',properties:{},additionalProperties:false};
const reportSchema=pattern=>({type:'string',maxLength:180,pattern});
export const launchIdPattern='^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$';
const launchSchema={type:'string',pattern:launchIdPattern};
export const requestIdPattern='^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$';
export const evidenceFamilies=['check','coverage','isolated-build'];

/** Standalone development flags need no running API or product credentials. */
export function toolFlags(environment=process.env){
    const enabled=name=>{
        const value=environment[name];
        if(value!==undefined&&!['0','1'].includes(value))throw new DiagnosticError('INVALID_CONFIGURATION',name+' must be 0 or 1.');
        return value!=='0';
    };
    return {checkPlanEnabled:enabled('NEUROCENTER_DEV_MCP_CHECK_PLAN'),serviceDetailsEnabled:enabled('NEUROCENTER_DEV_MCP_SERVICE_DETAILS'),
        outputSchemasEnabled:enabled('NEUROCENTER_DEV_MCP_OUTPUT_SCHEMAS'),evidenceEnabled:enabled('NEUROCENTER_DEV_MCP_EVIDENCE'),
        impactPlanEnabled:enabled('NEUROCENTER_IMPACT_PLAN')};
}

/** One public catalogue shared by the server and discovery diagnostics. */
export function toolDefinitions({checkPlanEnabled=true,outputSchemasEnabled=true,evidenceEnabled=true,impactPlanEnabled=true}={}){
    const definitions=[
        {name:'workspace_status',description:'Read Git summary, eight package versions, current Node and existing check commands. Does not run checks.',inputSchema:empty},
        {name:'services_health',description:'Probe fixed local liveness and passive readiness separately, with bounded listener ownership inspection. Discards response bodies; supports cancellation.',inputSchema:empty},
        {name:'service_logs',description:'Read a bounded redacted service log, optionally from a retained launch UUID. Launch provenance and current process correlation remain separate from log contents.',inputSchema:{type:'object',properties:{service:{type:'string',enum:logServices},lines:{type:'integer',minimum:1,maximum:100,default:50},launchId:launchSchema},required:['service'],additionalProperties:false}},
        {name:'verification_summary',description:'Summarize one selected coverage manifest, check report or isolated-build receipt. Distinguishes recorded results from current source verification; never returns raw logs.',inputSchema:{type:'object',properties:{report:reportSchema(verificationReportPattern)},required:['report'],additionalProperties:false}},
        {name:'coverage_gaps',description:'Read bounded test-writing targets for a package with unit results in one finished coverage report: uncovered functions/branches, missing sources and unit infrastructure exclusions. HTTP-only reports have no package scope. Does not run or edit code.',inputSchema:{type:'object',properties:{report:reportSchema(coverageReportPattern),package:{type:'string',enum:packageNames},limit:{type:'integer',minimum:1,maximum:20,default:10}},required:['report','package'],additionalProperties:false}},
    ];
    if(checkPlanEnabled)definitions.push({name:'check_plan',description:'Plan existing checks for explicitly selected workspace packages and steps. Does not execute commands, create reports or include full-workspace contracts/Compose.',inputSchema:{type:'object',properties:{packages:{type:'array',items:{type:'string',enum:packageNames},minItems:1,maxItems:8,uniqueItems:true},steps:{type:'array',items:{type:'string',enum:checkSteps},minItems:1,maxItems:5,uniqueItems:true}},required:['packages'],additionalProperties:false}});
    if(evidenceEnabled)definitions.push(
        {name:'evidence_catalog',description:'List a bounded filesystem-order selection of retained check, coverage and isolated-build reports. This is not a latest-runs query; rejected entries and scan limits remain explicit.',inputSchema:{type:'object',properties:{families:{type:'array',items:{type:'string',enum:evidenceFamilies},minItems:1,maxItems:3,uniqueItems:true},limit:{type:'integer',minimum:1,maximum:20,default:10}},additionalProperties:false}},
        {name:'verify_source',description:'Compare the current bounded source fingerprint with one explicitly selected report and expected report SHA. Recorded success, fingerprint match and runtime acceptance are separate; unsupported protocols stay unknown.',inputSchema:{type:'object',properties:{report:reportSchema(verificationReportPattern),expectedReportSha256:{type:'string',pattern:'^[a-f0-9]{64}$'}},required:['report','expectedReportSha256'],additionalProperties:false}},
    );
    definitions.push({name:'request_trace',description:'Read bounded structured ToolBuild or saved-chat events from one Catalog launch. request is the ToolBuild requestKey or the saved-chat requestId. Log events are untrusted observations, not proof of a complete request or product acceptance.',inputSchema:{type:'object',properties:{flow:{type:'string',enum:['tool-build','saved-chat']},request:{type:'string',pattern:requestIdPattern},launchId:launchSchema,limit:{type:'integer',minimum:1,maximum:100,default:50}},required:['flow','request'],additionalProperties:false}});
    if(impactPlanEnabled)definitions.push({name:'impact_plan',description:'Recommend existing checks from a full local base commit and bounded current source observation. Unknown impact falls back to the complete default plan. Does not execute checks or establish coverage; native/database acceptance stays explicit.',inputSchema:{type:'object',properties:{baseRevision:{type:'string',pattern:'^(?:[a-f0-9]{40}|[a-f0-9]{64})$'}},required:['baseRevision'],additionalProperties:false}});
    return definitions.map(tool=>outputSchemasEnabled?{...tool,outputSchema:outputSchemas[tool.name]}:tool);
}

export const expectedToolNames=toolDefinitions().map(tool=>tool.name);
