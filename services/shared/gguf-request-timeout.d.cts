import type {IncomingMessage,Server,ServerResponse} from 'node:http';
export function ggufRequestTimeouts(server:Server):(req:IncomingMessage&{path?:string},res:ServerResponse,next:()=>void)=>void;
