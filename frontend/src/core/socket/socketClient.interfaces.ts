import type { IOperationProgress } from './interfaces';
import type { IOperationStateEvent } from './interfaces';
import type { IVersionVerified } from './interfaces';
import type { IVersionRejected } from './interfaces';
import type { IHeadMoved } from './interfaces';
import type { IProfilePublished } from './interfaces';
import type { ISkillChanged } from './interfaces';
import type { IPackageChanged } from './interfaces';
import type { TLiveSection } from './interfaces';

/** Contract owned by socketClient. */
export interface ISocketHandlers {
    connect: () => void;
    disconnect: () => void;
    connect_error: () => void;
    'section:changed': (payload: { sections: TLiveSection[]; at: string }) => void;
    'bridge:changed': (payload: { deviceId?: string; jobId?: string }) => void;
    'auth:changed': () => void;
    'operation:progress': (payload: IOperationProgress) => void;
    'operation:state': (payload: IOperationStateEvent) => void;
    'version:verified': (payload: IVersionVerified) => void;
    'version:rejected': (payload: IVersionRejected) => void;
    'head:moved': (payload: IHeadMoved) => void;
    'profile:published': (payload: IProfilePublished) => void;
    'skill:changed': (payload: ISkillChanged) => void;
    'package:changed': (payload: IPackageChanged) => void;
}
