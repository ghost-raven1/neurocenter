import type { Request } from 'express';
import type {
    IRoleMcpPreparedTarget,
    IRoleMcpReceipt,
    TRoleMcpTargetSelection,
} from '../../../shared/system-role-mcp.cjs';
import type { IRoleRunRow } from '../system-roles/system-role.interfaces';

/** Implementations preserve private durable receipts; this runner contract contains no executable launch configuration. */
export interface ISystemRoleMcpAccess {
    assertAdmission(req: Request, projectId: string | null, selection: TRoleMcpTargetSelection[]): Promise<void>;
    prepare(
        req: Request,
        projectId: string | null,
        selection: TRoleMcpTargetSelection[],
    ): Promise<IRoleMcpPreparedTarget[]>;
    canContinueTools?(req: Request, row: IRoleRunRow): Promise<boolean>;
    call(
        req: Request,
        row: IRoleRunRow,
        prepared: IRoleMcpPreparedTarget[],
        toolKey: string,
        args: Record<string, unknown>,
        signal: AbortSignal,
    ): Promise<IRoleMcpReceipt>;
    close(runId: string, leaseToken: string): Promise<void>;
}
