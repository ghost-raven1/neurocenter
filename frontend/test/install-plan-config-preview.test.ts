import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { IInstallPlan } from '../src/features/McpBridge/installPlanTypes';
import { InstallPlanDetails } from '../src/modules/Store/installPlans/InstallPlanModal';
import { installPlanConfigPreview } from '../src/modules/Store/installPlans/installPlanConfigPreview';

const artifact = Object.freeze({target:'darwin-arm64',sha256:'a'.repeat(64),compressedBytes:100,unpackedBytes:200,filesCount:2,entrypoint:'entrypoint.mjs'});

describe('Подключение в плане установки без повторного списка платформ', () => {
    it('Сохраняет прочую конфигурацию и extra, не изменяя одобряемый план', () => {
        const artifacts = Object.freeze([artifact]);
        const extra = Object.freeze({runtimeArtifacts:artifacts,localConfiguration:{schemaVersion:1},label:'fixture'});
        const config = Object.freeze({transport:'stdio',args:['--fixture'],extra});
        const before = JSON.stringify(config);
        expect(installPlanConfigPreview(config)).toEqual({transport:'stdio',args:['--fixture'],extra:{localConfiguration:{schemaVersion:1},label:'fixture'}});
        expect(JSON.stringify(config)).toBe(before);
        expect(config.extra.runtimeArtifacts).toBe(artifacts);
    });

    it('Показывает платформу и SHA один раз, а параметры подключения оставляет видимыми', () => {
        const config = {transport:'stdio',args:['--fixture'],extra:{runtimeArtifacts:[artifact]}};
        const plan: IInstallPlan = {id:'plan',projectId:'qa',assetId:'fixture',assetKind:'mcp',version:1,
            manifest:'b'.repeat(64),status:'approved',revision:1,approvedBy:null,files:[],requirements:{},config};
        const html = renderToStaticMarkup(createElement(InstallPlanDetails,{plan}));
        expect(html.match(/darwin-arm64/g)).toHaveLength(1);
        expect(html.match(new RegExp(artifact.sha256,'g'))).toHaveLength(1);
        expect(html).toContain('macOS · Apple Silicon');
        expect(html).toContain('--fixture');
        expect(html).not.toContain('runtimeArtifacts');
        expect(installPlanConfigPreview(config)).toEqual({transport:'stdio',args:['--fixture']});
        expect(plan.config).toBe(config);
    });

    it('Не скрывает некорректные метаданные, для которых отдельный список не показан', () => {
        for (const runtimeArtifacts of [[],[artifact,artifact],[{...artifact,sha256:'broken'}],'broken']) {
            const config = {extra:{runtimeArtifacts}};
            expect(installPlanConfigPreview(config)).toBe(config);
        }
        const config = {transport:'http',url:'https://example.test/mcp',extra:{label:'fixture'}};
        expect(installPlanConfigPreview(config)).toBe(config);
        expect(installPlanConfigPreview(null)).toBeNull();
    });
});
