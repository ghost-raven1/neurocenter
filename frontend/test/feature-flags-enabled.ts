import {vi} from 'vitest';

/** These feature suites arrange enabled capabilities; off/unknown/dependency behavior has separate integration coverage. */
vi.mock('../src/features/FeatureFlags/FeatureAvailability', async () => {
    const {createElement}=await import('react');
    const antd=await import('antd');
    return {
        FEATURE_FLAGS_CHANGED:'neurocenter:feature-flags-changed',
        useFeatureAvailability:()=>({enabled:true,known:true,reason:'',loading:false,refresh:async()=>undefined}),
        FeatureAvailabilityNotice:()=>null,
        FeatureButton:({features:_features,...props}:import('antd').ButtonProps&{features:string[]})=>createElement(antd.Button,props),
    };
});
