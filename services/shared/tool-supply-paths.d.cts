export const TOOL_SOURCE_MAX_BYTES:number;
export function toolRuntimePath(sha:string):string;
export function toolSourcePath(sha:string):string;
export function assertToolSupplyLayout(asset:{kind?:string;delivery:{type?:string;artifacts?:Array<{descriptor:{sha256:string}}>};source:{type:string;sha256?:string};recipe?:{path:string;sha256:string}}):void;
