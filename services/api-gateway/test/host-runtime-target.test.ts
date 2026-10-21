import {afterEach,describe,expect,it,vi} from 'vitest';
import {hostRuntimeTarget} from '../src/features/mcp-host/host-target';
const descriptors={platform:Object.getOwnPropertyDescriptor(process,'platform')!,arch:Object.getOwnPropertyDescriptor(process,'arch')!,report:Object.getOwnPropertyDescriptor(process,'report')!};
const host=(platform:string,arch:string,report:unknown)=>{Object.defineProperty(process,'platform',{...descriptors.platform,value:platform});Object.defineProperty(process,'arch',{...descriptors.arch,value:arch});Object.defineProperty(process,'report',{configurable:true,value:report});};

describe('Gateway hosted runtime target selection',()=>{
 afterEach(()=>{for(const[key,descriptor]of Object.entries(descriptors))Object.defineProperty(process,key,descriptor);vi.restoreAllMocks();});
 it.each([['darwin','arm64','darwin-arm64'],['win32','x64','win32-x64']])('selects native target on %s without requesting a Linux report',(platform,arch,expected)=>{
  const getReport=vi.fn(()=>{throw Error('A non-Linux host must not inspect libc.');});host(platform,arch,{getReport});expect(hostRuntimeTarget()).toBe(expected);expect(getReport).not.toHaveBeenCalled();
 });
 it('distinguishes Linux glibc from musl for the current architecture',()=>{
  host('linux','x64',{getReport:()=>({header:{glibcVersionRuntime:'2.36'}})});expect(hostRuntimeTarget()).toBe('linux-x64-glibc');host('linux','arm64',{getReport:()=>({header:{}})});expect(hostRuntimeTarget()).toBe('linux-arm64-musl');
 });
 it('selects musl when a Linux process report or its header is unavailable',()=>{
  host('linux','x64',undefined);expect(hostRuntimeTarget()).toBe('linux-x64-musl');host('linux','x64',{getReport:()=>({})});expect(hostRuntimeTarget()).toBe('linux-x64-musl');
 });
});
