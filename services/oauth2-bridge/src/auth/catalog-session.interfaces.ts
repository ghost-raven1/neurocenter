/** Persisted identity is independent of each request's freshly checked authorization. */
export interface ISessionIdentity {
    id: string;
    principalName: string;
    email: string;
    displayName: string;
}
export interface IStoredSession {
    identity: ISessionIdentity;
    selectedRole: string;
    expiresAt: string;
}
export interface ISessionCreate {
    tokenHash: string;
    identity: ISessionIdentity;
    selectedRole: string;
    ttlSeconds: number;
}
