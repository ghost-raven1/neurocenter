import {GatewayTimeoutException} from '@nestjs/common';
import {TOOL_IMPORT_TIMEOUT_MS} from '../../../shared/tool-import-deadline.cjs';
import {ToolImportCleanupPendingError} from './verify-imported-tool';

export const TOOL_IMPORT_DEADLINE_MESSAGE='Импорт превысил время ожидания. Проверенные файлы сохранены. Повторите тот же запрос поставки.';

/** Await owned work and its cleanup; an expired request never leaves a detached publisher. */
export async function withToolImportDeadline<T>(work:(signal:AbortSignal)=>Promise<T>,requestSignal?:AbortSignal):Promise<T>{
    const deadline=new AbortController(),signal=AbortSignal.any([deadline.signal,...(requestSignal?[requestSignal]:[])]);
    const timer=setTimeout(()=>deadline.abort(new GatewayTimeoutException(TOOL_IMPORT_DEADLINE_MESSAGE)),TOOL_IMPORT_TIMEOUT_MS);timer.unref();
    try{signal.throwIfAborted();return await work(signal);}
    catch(error){if(signal.aborted&&!(error instanceof ToolImportCleanupPendingError))throw signal.reason;throw error;}
    finally{clearTimeout(timer);}
}
