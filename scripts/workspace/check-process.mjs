import {runBuildProcess} from './isolated-build-process.mjs';

/** Reuse the owned POSIX supervisor; check receipts expose no PID, command or foreign process inventory. */
export async function runCheckProcess(options){
    const result=await runBuildProcess(options),renamed={BUILD_TIMEOUT:'CHECK_TIMEOUT',BUILD_FAILED:'CHECK_FAILED',BUILD_LOG_LIMIT:'CHECK_LOG_LIMIT',BUILD_PROCESS_FAILED:'CHECK_EXECUTION_FAILED'};
    return {ok:result.ok,exitCode:result.exitCode,signal:result.signal,durationMs:result.durationMs,leaderReaped:result.leaderReaped,
        cleanup:{noLiveDescendants:result.cleanup.noLiveDescendants,signals:result.cleanup.signals,zombieCount:result.cleanup.zombiePids?.length||0},
        ...(result.failure?{failure:{code:renamed[result.failure.code]||result.failure.code},...(result.failure.errno?{errorCode:result.failure.errno}:{})}:{})};
}
