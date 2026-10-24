import { Controller, Get,ServiceUnavailableException } from '@nestjs/common';
import {checkReadiness,httpReady} from '../../shared/readiness.cjs';

/**
 * Health-эндпоинт gateway.
 */
@Controller()
export class AppController {
    @Get('ready')
    ready():{ok:true;checks:{gateway:'ready'}}{return {ok:true,checks:{gateway:'ready'}};}
    /** Dependency diagnostics do not decide whether unrelated routes may receive traffic. */
    @Get('ready/dependencies')
    async dependencies():Promise<unknown>{const state=await checkReadiness(Object.fromEntries([
        ['catalog',process.env.CATALOG_SERVICE_URL||'http://localhost:4100'],['skills',process.env.SKILLS_SERVICE_URL||'http://localhost:4200'],
        ['rag',process.env.RAG_SERVICE_URL||'http://localhost:4300'],['auth',process.env.AUTH_SERVICE_URL||'http://localhost:22222'],
        ['featureFlags',process.env.FEATURE_FLAGS_SERVICE_URL||'http://localhost:4400'],
    ].map(([name,url])=>[name,()=>httpReady(url)])));if(!state.ok){throw new ServiceUnavailableException(state);}return state;}
    /**
     * Health-check.
     *
     * @returns {{ ok: boolean }}
     */
    @Get('health')
    public health(): { ok: boolean } {
        return { ok: true };
    }
}
