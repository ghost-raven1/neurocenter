import {describe,expect,it} from 'vitest';
import {validBridgeVersion} from '../src/asset-sources/bridge-source-version';

describe('A bridge version is comparable in both the source API and installer UI',()=>{
    it.each(['0.0.0','0.9.99','0.10.0','10.100.1000','9007199254740991.0.0'])('accepts canonical stable %s',version=>expect(validBridgeVersion(version)).toBe(true));
    it.each(['00.10.0','0.01.0','0.0.00','9007199254740992.0.0','0.9007199254740992.0','0.0.9007199254740992','0.10.0-rc.1','v0.10.0','0.10','0.10.0\n','-1.0.0','1e2.0.0',null,1,{}])('rejects a version the installer cannot compare: %j',version=>expect(validBridgeVersion(version)).toBe(false));
});
