import type {Pool} from 'pg';
import {assertCatalogSchema} from './schema-verification';
import {assertAgentSchema} from '../agents/agent-schema-verification';
import {CATALOG_SCHEMA_CONTRACT} from './schema-contract';
import {AGENT_SCHEMA_CONTRACT} from '../agents/agent-schema-contract';
export const CURRENT_CATALOG_SCHEMA_CONTRACT=[...CATALOG_SCHEMA_CONTRACT,...AGENT_SCHEMA_CONTRACT];
/** Runtime readiness checks every managed generation; historical migration assertions stay frozen. */
export async function assertCurrentCatalogSchema(db:Pick<Pool,'query'>):Promise<void>{
 await assertCatalogSchema(db);await assertAgentSchema(db);
}
