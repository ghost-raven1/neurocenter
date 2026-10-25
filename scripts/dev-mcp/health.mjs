import {services as defaults,DiagnosticError} from './constants.mjs';
import {devServiceHealth} from '../workspace/dev-service-health.mjs';

/** Only constructor injection may supply owned test ports; tool arguments never accept destinations. */
export function healthReader(definitions=defaults,options={}){
    const localPath=value=>typeof value==='string'&&/^\/(?!\/)[^\r\n]*$/.test(value);
    if(!Array.isArray(definitions)||definitions.length>8||definitions.some(item=>!defaults.some(service=>service.name===item.name)
        ||!Number.isInteger(item.port)||item.port<1||item.port>65535||!localPath(item.path)
        ||item.readinessPath!==undefined&&!localPath(item.readinessPath)))throw new DiagnosticError('SERVICE_CONFIGURATION','Invalid fixed local health configuration.');
    const read=devServiceHealth(definitions,options);
    return async signal=>({scope:'Fixed local passive GET probes. Liveness does not prove dependency readiness; frontend compilation is partial. Readiness endpoints with filesystem writes are skipped. Ownership requires OS listener and process metadata; unknown is not owned.',services:await read(signal)});
}
