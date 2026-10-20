export const TOOL_SOURCE_MAX_BYTES:number;
export function toolRuntimePath(sha:string):string;
export function toolSourcePath(sha:string):string;
export function assertToolSupplyLayout(asset:{delivery:{artifacts:Array<{descriptor:{sha256:string}}>};source:{type:string;sha256?:string};recipe?:{path:string;sha256:string}}):void;
