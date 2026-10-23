import {describe,expect,it} from 'vitest';
import {opencodeModelCandidates} from '../src/bridge/opencode-model-scan.js';
import {ollamaAdapterUrl} from '../src/features/opencode-providers/ollama-entry.js';

const id='neurocenter-ollama-'+'a'.repeat(16);
const config=()=>({provider:{[id]:{npm:ollamaAdapterUrl,options:{baseURL:'https://ollama.example.test'},models:{'qwen3:8b':{id:'qwen3:8b',options:{temperature:0,topP:0.3,maxOutputTokens:128,contextWindow:8192},limit:{context:8192}}}}}});
describe('Native Ollama metadata projection',()=>{
    it('discovers the shipped adapter as native Ollama and keeps the exact root URL and public generation controls',()=>{
        expect(opencodeModelCandidates(config())[0]).toMatchObject({provider:id,model:'qwen3:8b',runtime:'remote-ollama',baseUrl:'https://ollama.example.test',hasKey:false,blocker:null,
            options:{temperature:0,topP:0.3,maxOutputTokens:128,contextWindow:8192}});
    });
    it.each(['different-file','latest-sdk','lookalike'])('a %s adapter never becomes a trusted native transport',kind=>{
        const value=config();value.provider[id].npm=kind==='different-file'?ollamaAdapterUrl.replace('ollama-sdk','foreign-sdk'):kind==='latest-sdk'?'ollama-ai-provider-v2@latest':ollamaAdapterUrl+'?same=true';
        expect(opencodeModelCandidates(value)[0]).toMatchObject({runtime:null,blocker:'unsupported-provider'});
    });
    it('does not confuse a matching provider name on an OpenAI transport with the native Ollama protocol',()=>{
        const value=config();value.provider[id].npm='@ai-sdk/openai-compatible';
        expect(opencodeModelCandidates(value)[0]).toMatchObject({runtime:null,blocker:'unsupported-provider'});
    });
    it.each(['context','generation','headers','disabled'])('keeps a %s override blocked instead of reporting equivalent semantics',kind=>{
        const value:any=config();if(kind==='context')value.provider[id].models['qwen3:8b'].limit.context=4096;
        if(kind==='generation')value.provider[id].models['qwen3:8b'].options.thinking={secret:'PRIVATE_NOT_METADATA'};
        if(kind==='headers')value.provider[id].options.headers={Authorization:'PRIVATE_NOT_METADATA'};
        if(kind==='disabled')value.disabled_providers=[id];
        const candidate=opencodeModelCandidates(value)[0];expect(candidate!.blocker).not.toBeNull();expect(JSON.stringify(candidate)).not.toContain('PRIVATE_NOT_METADATA');
    });
});
