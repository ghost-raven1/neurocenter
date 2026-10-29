import type {RemoteProviderAccessService} from '../src/remote-providers/remote-provider.service';

/** Explicit anonymous-provider port for unrelated metadata/protocol fixtures; real ACL/key isolation uses owned PG tests. */
export const anonymousProviderAccess={wire:()=>({acquire:async()=>({release:async()=>undefined})})}as unknown as RemoteProviderAccessService;
