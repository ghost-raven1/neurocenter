import {describe,expect,it,vi} from 'vitest';
import type {Pool} from 'pg';
import {approvedRuntimeArtifact} from '../src/devices/runtime-job-artifact';

describe('Архив runtime ограничен одобренным комплектом задания',()=>{
    const sha256='a'.repeat(64),descriptor={sha256,compressedBytes:123};
    const pkg={config:{extra:{runtimeArtifacts:[descriptor]}}};
    it('Выбирает точный SHA из всего закреплённого installSet, включая зависимость навыка',async()=>{
        const query=vi.fn().mockResolvedValue({rows:[{payload:{package:{},installSet:{packages:[{},pkg]}}}]});
        await expect(approvedRuntimeArtifact({query} as unknown as Pool,'device','job','lease',sha256)).resolves.toEqual(descriptor);
        expect(query.mock.calls[0][1]).toEqual(['job','device','lease']);
    });
    it('Сохраняет загрузку одиночного пакета без installSet',async()=>{
        const query=vi.fn().mockResolvedValue({rows:[{payload:{package:pkg}}]});
        await expect(approvedRuntimeArtifact({query} as unknown as Pool,'device','job','lease',sha256)).resolves.toEqual(descriptor);
    });
    it('Нельзя скачать SHA из корневого package вне точного installSet',async()=>{
        const query=vi.fn().mockResolvedValue({rows:[{payload:{package:pkg,installSet:{packages:[{}]}}}]});
        await expect(approvedRuntimeArtifact({query} as unknown as Pool,'device','job','lease',sha256)).rejects.toThrow('не входит');
    });
    it.each([{rows:[]},{rows:[{payload:{package:pkg}}]}])('Отказывает неподтверждённому заданию или чужому SHA',async({rows})=>{
        const query=vi.fn().mockResolvedValue({rows});
        await expect(approvedRuntimeArtifact({query} as unknown as Pool,'device','job','lease','b'.repeat(64))).rejects.toThrow('не входит');
    });
});
