import {describe,expect,it} from 'vitest';
import {validatePublication} from '../src/publication/publication-validation';
import {buildPackage,verifyPackage} from '../src/catalog/bundle-package';

const artifact={target:'darwin-arm64',sha256:'a'.repeat(64),compressedBytes:100,unpackedBytes:200,filesCount:2,entrypoint:'entrypoint.mjs'};
const source=()=>({name:'Exa Research',kind:'mcp',description:'Search through Gateway',files:[],config:{transport:'stdio',args:[],extra:{runtimeArtifacts:[artifact],hostedMcp:true,
    researchMcp:{adapter:'exa',tools:['web_search_exa','web_fetch_exa']}}}});
describe('Research MCP native publication',()=>{
    it('keeps the hosted/read-only contract in the self-verified immutable package',()=>{
        const input=source(),publication=validatePublication(input);
        expect(publication.config?.extra?.researchMcp).toEqual(input.config.extra.researchMcp);expect(publication.config?.extra?.researchMcp).not.toBe(input.config.extra.researchMcp);
        const pkg=buildPackage({id:'exa',kind:'mcp',name:'Exa Research',version:1},[],'',publication.config);
        expect(pkg.schemaVersion).toBe(5);expect(verifyPackage(pkg)).toBe(true);
        pkg.config!.extra!.hostedMcp=false;expect(verifyPackage(pkg)).toBe(false);
    });
    it.each([false,null,{},[],{adapter:'exa',tools:['web_search_exa']},{adapter:'exa',tools:['web_search_exa','execute_shell']},
        {adapter:'exa',tools:['web_search_exa','web_fetch_exa'],url:'https://private.invalid'},
        {adapter:'unknown',tools:['web_search_exa','web_fetch_exa']}])('rejects unsupported tool grants %j',researchMcp=>{
        const input=source();expect(()=>validatePublication({...input,config:{...input.config,extra:{...input.config.extra,researchMcp}}})).toThrow();
    });
    it('rejects remote/plugin/unbundled hosts and a research descriptor without Gateway hosting',()=>{
        for(const input of [{...source(),kind:'plugin'}, {...source(),config:{transport:'remote',url:'https://mcp.exa.ai/mcp',extra:source().config.extra}},
            {...source(),config:{transport:'stdio',extra:{hostedMcp:true}}},
            {...source(),config:{...source().config,extra:{...source().config.extra,hostedMcp:false}}}])expect(()=>validatePublication(input)).toThrow();
    });
    it('supports explicit false for ordinary bundled MCP, without granting research',()=>{
        const input=source(),{researchMcp:_research,...extra}=input.config.extra;
        expect(validatePublication({...input,config:{...input.config,extra:{...extra,hostedMcp:false}}}).config?.extra?.hostedMcp).toBe(false);
    });
});
