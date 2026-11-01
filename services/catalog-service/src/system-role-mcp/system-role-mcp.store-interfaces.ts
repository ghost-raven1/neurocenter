import type { TRoleMcpExecutionResult, TRoleMcpTarget, IRoleMcpTool } from '../../../shared/system-role-mcp.cjs';
import type { IPackage } from '../catalog/bundle-package';
import type { IInstallationSet } from '../devices/installation-set';

export interface IMcpSessionRow {
    id: string;
    owner_email: string;
    actor_role: string;
    project_id: string;
    run_id: string | null;
    lease_token: string | null;
    target_hash: string;
    target: TRoleMcpTarget;
    package: IPackage;
    install_set: IInstallationSet | null;
    job_id: string | null;
    worker_lease: string | null;
    worker_lease_until: Date | string | null;
    claimed_at: Date | string | null;
    worker_closed_at: Date | string | null;
    worker_claim_request_id: string | null;
    worker_claim_token_hash: string | null;
    state: 'open' | 'closed';
    deadline_at: Date | string;
    created_at: Date | string;
}

export interface IMcpCallRow {
    id: string;
    session_id: string;
    run_id: string | null;
    kind: 'list' | 'call';
    dispatch_proof: string;
    tool_key: string | null;
    name: string | null;
    schema_digest: string | null;
    arguments: Record<string, unknown> | null;
    state: 'queued' | 'dispatched' | 'succeeded' | 'failed' | 'unknown' | 'cancelled';
    result: TRoleMcpExecutionResult | null;
    late_result: TRoleMcpExecutionResult | null;
    deadline_at: Date | string;
    created_at: Date | string;
    dispatched_at: Date | string | null;
    completed_at: Date | string | null;
}

export interface IMcpDiscoveryRow {
    id: string;
    owner_email: string;
    actor_role: string;
    project_id: string;
    request_hash: string;
    target: TRoleMcpTarget;
    session_id: string;
    call_id: string;
    created_at: Date | string;
    expires_at: Date | string;
}

export interface IMcpDiscoveryView {
    id: string;
    state: 'pending' | 'ready' | 'failed';
    target: TRoleMcpTarget;
    tools: IRoleMcpTool[];
    message: string;
}
