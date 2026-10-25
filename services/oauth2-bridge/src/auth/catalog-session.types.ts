/** Persisted identity is independent of each request's freshly checked authorization. */
export interface SessionIdentity {id:string;principalName:string;email:string;displayName:string}
export interface StoredSession {identity:SessionIdentity;selectedRole:string;expiresAt:string}
export interface SessionCreate {tokenHash:string;identity:SessionIdentity;selectedRole:string;ttlSeconds:number}
