import {describe,expect,it} from 'vitest';
import {defaultFeatureFlags,evaluateFeatureFlags} from '../../shared/feature-flags.cjs';
import {requiredInferenceFeatures} from '../../shared/feature-policy.cjs';

describe('Packager feature boundaries',()=>{
    it('keeps explicit Packager calls independent from group chat',()=>{
        const configured={...defaultFeatureFlags(),group_chat:false,model_chat:false,agents:false};
        expect(requiredInferenceFeatures('agent','agent-packager')).toEqual(['tool_build_agent']);
        expect(evaluateFeatureFlags(configured).flags.tool_build_agent).toBe(true);
        expect(requiredInferenceFeatures('agent','other-agent')).toEqual(['group_chat']);
    });
    it('stops model planning with hosting while retaining the manual runtime gate',()=>{
        const values=evaluateFeatureFlags({...defaultFeatureFlags(),model_hosting:false});
        expect(values.flags.tool_build_agent).toBe(false);expect(values.blockedBy.tool_build_agent).toContain('model_hosting');
        expect(values.flags.tool_build_validation).toBe(true);
    });
    it('makes build disablement block both fresh capabilities',()=>{
        const values=evaluateFeatureFlags({...defaultFeatureFlags(),tool_builds:false});
        expect(values.flags.tool_build_agent).toBe(false);expect(values.flags.tool_build_validation).toBe(false);
        expect(values.blockedBy.tool_build_agent).toContain('tool_builds');expect(values.blockedBy.tool_build_validation).toContain('tool_builds');
    });
});
