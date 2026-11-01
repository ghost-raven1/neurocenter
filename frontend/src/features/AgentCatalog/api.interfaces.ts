import type { IBridgeJob } from '../McpBridge/api';

/** Contract owned by api. */
export type TAgentJob = IBridgeJob & { desiredRevision?: number };
