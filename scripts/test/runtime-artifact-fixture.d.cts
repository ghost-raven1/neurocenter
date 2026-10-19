import type { RuntimeArtifact } from '../../services/shared/runtime-artifacts.cjs';
export function artifactFixture(files?:Array<{path:string;content?:string;mode?:number;type?:string;link?:string}>,target?:string):{archive:Buffer;descriptor:RuntimeArtifact};
