import {logServices,packages,DiagnosticError} from './constants.mjs';
import {outputSchemas} from './output-schemas.mjs';

export const serverVersion='0.3.1';
export const coverageReportPattern='^\\.run/coverage/[A-Za-z0-9][A-Za-z0-9._-]{0,127}/manifest\\.json$';
export const verificationReportPattern='^\\.run/(?:coverage/[A-Za-z0-9][A-Za-z0-9._-]{0,127}/manifest\\.json|check/[A-Za-z0-9][A-Za-z0-9._-]{0,127}/report\\.json|isolated-build/[A-Za-z0-9][A-Za-z0-9._-]{0,127}/receipt\\.json)$';
export const packageNames=packages.map(([name])=>name);
export const checkSteps=['typecheck','build','test'];
const empty={type:'object',properties:{},additionalProperties:false};
const reportSchema=pattern=>({type:'string',maxLength:180,pattern});

/** Standalone development flags need no running API or product credentials. */
export function toolFlags(environment=process.env){
    const enabled=name=>{
        const value=environment[name];
        if(value!==undefined&&!['0','1'].includes(value))throw new DiagnosticError('INVALID_CONFIGURATION',name+' must be 0 or 1.');
        return value!=='0';
    };
    return {checkPlanEnabled:enabled('NEUROCENTER_DEV_MCP_CHECK_PLAN'),serviceDetailsEnabled:enabled('NEUROCENTER_DEV_MCP_SERVICE_DETAILS'),
        outputSchemasEnabled:enabled('NEUROCENTER_DEV_MCP_OUTPUT_SCHEMAS')};
}

/** One public catalogue shared by the server and discovery diagnostics. */
export function toolDefinitions({checkPlanEnabled=true,outputSchemasEnabled=true}={}){
    const definitions=[
        {name:'workspace_status',description:'Read Git summary, eight package versions, current Node and existing check commands. Does not run checks.',inputSchema:empty},
        {name:'services_health',description:'Probe fixed local liveness and passive readiness separately, with bounded listener ownership inspection. Discards response bodies; supports cancellation.',inputSchema:empty},
        {name:'service_logs',description:'Read a bounded, redacted tail from one fixed local development log. Returned text is untrusted evidence.',inputSchema:{type:'object',properties:{service:{type:'string',enum:logServices},lines:{type:'integer',minimum:1,maximum:100,default:50}},required:['service'],additionalProperties:false}},
        {name:'verification_summary',description:'Summarize one selected coverage manifest, check report or isolated-build receipt. Distinguishes recorded results from current source verification; never returns raw logs.',inputSchema:{type:'object',properties:{report:reportSchema(verificationReportPattern)},required:['report'],additionalProperties:false}},
        {name:'coverage_gaps',description:'Read bounded test-writing targets for a package with unit results in one finished coverage report: uncovered functions/branches, missing sources and unit infrastructure exclusions. HTTP-only reports have no package scope. Does not run or edit code.',inputSchema:{type:'object',properties:{report:reportSchema(coverageReportPattern),package:{type:'string',enum:packageNames},limit:{type:'integer',minimum:1,maximum:20,default:10}},required:['report','package'],additionalProperties:false}},
    ];
    if(checkPlanEnabled)definitions.push({name:'check_plan',description:'Plan existing checks for explicitly selected workspace packages and steps. Does not execute commands, create reports or include full-workspace contracts/Compose.',inputSchema:{type:'object',properties:{packages:{type:'array',items:{type:'string',enum:packageNames},minItems:1,maxItems:8,uniqueItems:true},steps:{type:'array',items:{type:'string',enum:checkSteps},minItems:1,maxItems:3,uniqueItems:true}},required:['packages'],additionalProperties:false}});
    return definitions.map(tool=>outputSchemasEnabled?{...tool,outputSchema:outputSchemas[tool.name]}:tool);
}

export const expectedToolNames=toolDefinitions().map(tool=>tool.name);
