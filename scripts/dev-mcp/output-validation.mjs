import {createRequire} from 'node:module';
import {outputSchemas} from './output-schemas.mjs';
import {DiagnosticError} from './constants.mjs';

const require=createRequire(new URL('../../mcp/neurocenter-asset-sync/package.json',import.meta.url));
const {AjvJsonSchemaValidator}=require('@modelcontextprotocol/sdk/validation/ajv-provider.js');
const provider=new AjvJsonSchemaValidator();
const validators=new Map();

/** Reuse the installed MCP validator, retaining fixed errors without response values or parser excerpts. */
export function validateOutput(name,value){
    if(!Object.hasOwn(outputSchemas,name))throw new DiagnosticError('OUTPUT_CONTRACT_MISMATCH','The developer tool response does not match its published contract.');
    if(!validators.has(name))validators.set(name,provider.getValidator(outputSchemas[name]));
    if(!validators.get(name)(value).valid)throw new DiagnosticError('OUTPUT_CONTRACT_MISMATCH','The developer tool response does not match its published contract.');
    return value;
}
