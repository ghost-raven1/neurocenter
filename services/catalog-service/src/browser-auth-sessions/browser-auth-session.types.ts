/** Session identity deliberately excludes credentials and authorization grants. */
export interface BrowserSessionIdentity {id:string;principalName:string;email:string;displayName:string}
export interface CreateBrowserSession {tokenHash:string;identity:BrowserSessionIdentity;selectedRole:string;ttlSeconds:number}
export type BrowserSessionLookup={found:false}|{found:true;session:{identity:BrowserSessionIdentity;selectedRole:string;expiresAt:string}};
