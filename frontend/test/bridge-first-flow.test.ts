import {expect,it} from 'vitest';
import {unifiedSetupStep} from '../src/modules/Start/projectSetupModel';
import {startQueryUrl} from '../src/modules/Start/startQuery';

it.each([0,1,2,3,4,5])('bridge-first URL exposes sequential stage %i without legacy remapping',step=>{
    expect(unifiedSetupStep('?setup=1&setupFlow=bridge-first&step='+step)).toBe(step);
});
it('preserves recovery context and marks newly generated stages with the current flow',()=>{
    const url=new URL(startQueryUrl('?p=project&connect=PAIR&extension=rag&help=offline',{setup:true,step:4},'#tools'),'https://qa.test');
    expect(url.searchParams.get('setupFlow')).toBe('bridge-first');expect(url.searchParams.get('step')).toBe('4');
    expect(url.searchParams.get('p')).toBe('project');expect(url.searchParams.get('connect')).toBe('PAIR');expect(url.hash).toBe('#tools');
});
it.each(['?step=1','?step=2&legacy=1','?connect=PAIR','?setup=1&connect=PAIR','?addComputer=1'])('legacy connection %s opens bridge stage',query=>{
    expect(unifiedSetupStep(query)).toBe(0);
});
it('keeps historical agents/check URLs as the corresponding new stages',()=>{
    expect(unifiedSetupStep('?setup=1&step=2&p=project')).toBe(4);
    expect(unifiedSetupStep('?setup=1&step=3&p=project')).toBe(5);
});
