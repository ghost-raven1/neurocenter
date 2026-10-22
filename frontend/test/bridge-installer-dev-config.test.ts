import {afterEach,describe,expect,it,vi} from 'vitest';
import api from '../src/core/api/base';
import {loadBridgeInstallerOrigin} from '../src/features/McpBridge/useBridgeInstaller';

vi.mock('../src/core/api/base',()=>({default:{get:vi.fn()}}));
const supply={version:'0.9.18',buildId:'b'.repeat(64),targets:['darwin-arm64']};
afterEach(()=>vi.resetAllMocks());

describe('Явная dev-поставка Gateway',()=>{
    it('Сохраняет строковый контракт адреса для совместимых callers с dev и без него',async()=>{
        for(const data of [{origin:'https://gateway.test'},{origin:'https://gateway.test',devSupply:supply}]){
            vi.mocked(api.get).mockResolvedValue({data});
            expect(await loadBridgeInstallerOrigin(new AbortController().signal)).toBe(data.origin);
        }
    });
    it.each([null,{},[],{...supply,version:'latest'},{...supply,version:'0.9.18-beta.1'},
        {...supply,version:'99999999999999999999.0.0'},{...supply,buildId:'b'.repeat(63)},
        {...supply,buildId:'B'.repeat(64)},{...supply,targets:[]},{...supply,targets:'darwin-arm64'},
        {...supply,targets:['darwin-arm64','darwin-arm64']},{...supply,targets:[1]},
        {...supply,targets:['darwin-arm64-musl']},{...supply,targets:['../../private']}
    ].map(devSupply=>({devSupply})))('Некорректная присутствующая dev-поставка отклоняет весь ответ без origin-only fallback: $devSupply',async({devSupply})=>{
        vi.mocked(api.get).mockResolvedValue({data:{origin:'https://gateway.test',devSupply}});
        await expect(loadBridgeInstallerOrigin(new AbortController().signal)).rejects.toThrow();
    });
    it('Принимает канонические платформы, не объявляя их текущей платформой браузера',async()=>{
        vi.mocked(api.get).mockResolvedValue({data:{origin:'https://gateway.test',devSupply:{...supply,targets:['darwin-x64','linux-arm64','linux-x64-musl','windows-arm64']}}});
        expect(await loadBridgeInstallerOrigin(new AbortController().signal)).toBe('https://gateway.test');
    });
});
