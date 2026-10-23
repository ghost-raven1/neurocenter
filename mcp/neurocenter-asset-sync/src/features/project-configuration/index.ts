import {openVerificationPage} from '../../bridge/open-browser.js';
import {configurationContext,type Authorize} from './context.js';
import {startConfigurationSession} from './server.js';
/** The server receives opening identity only; edits, previews and recovery stay on this computer. */
export async function openProjectConfiguration(input:unknown,authorize:Authorize,permit:Authorize,open:(url:string)=>Promise<boolean>=openVerificationPage){
    const context=await configurationContext(input,authorize);await startConfigurationSession(context,permit,open);return {...context.descriptor,opened:true as const};
}
