import type { Request } from 'express';
import type {
    RoleMcpPreparedTarget,
    RoleMcpReceipt,
    RoleMcpTargetSelection,
} from '../../../shared/system-role-mcp.cjs';
import type { RoleRunRow } from '../system-roles/system-role.types';

/** Implementations preserve private durable receipts; this runner contract contains no executable launch configuration. */
export interface SystemRoleMcpAccess {
    assertAdmission(req: Request, projectId: string | null, selection: RoleMcpTargetSelection[]): Promise<void>;
    prepare(
        req: Request,
        projectId: string | null,
        selection: RoleMcpTargetSelection[],
    ): Promise<RoleMcpPreparedTarget[]>;
    canContinueTools?(req: Request, row: RoleRunRow): Promise<boolean>;
    call(
        req: Request,
        row: RoleRunRow,
        prepared: RoleMcpPreparedTarget[],
        toolKey: string,
        args: Record<string, unknown>,
        signal: AbortSignal,
    ): Promise<RoleMcpReceipt>;
    close(runId: string, leaseToken: string): Promise<void>;
}
