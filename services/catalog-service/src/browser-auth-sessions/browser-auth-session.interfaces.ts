/** Session identity deliberately excludes credentials and authorization grants. */
export interface IBrowserSessionIdentity {
    id: string;
    principalName: string;
    email: string;
    displayName: string;
}
export interface ICreateBrowserSession {
    tokenHash: string;
    identity: IBrowserSessionIdentity;
    selectedRole: string;
    ttlSeconds: number;
}
export type TBrowserSessionLookup =
    | { found: false }
    | { found: true; session: { identity: IBrowserSessionIdentity; selectedRole: string; expiresAt: string } };
