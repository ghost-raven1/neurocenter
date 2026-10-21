const {test}=require('node:test');
const assert=require('node:assert/strict');
const {issueHostedMcpTicket,verifyHostedMcpTicket}=require('../../services/api-gateway/dist/features/mcp-host/ticket.js');

test('Public host tickets never serialize private research process identity or caller extras',()=>{
 const before=process.env.NEUROCENTER_MCP_HOST_SECRET;
 process.env.NEUROCENTER_MCP_HOST_SECRET='qa-ticket-only-secret';
 try {
  const claim={artifactSha256:'a'.repeat(64),entrypoint:'server.mjs',executable:false,name:'QA',compressedBytes:12,
   session:{deviceId:'device',projectId:'project',assetId:'asset',version:1,manifest:'b'.repeat(64)},
   researchSessionId:'private-process-identity',unexpected:'not-a-public-field'};
  const ticket=issueHostedMcpTicket(claim),raw=JSON.parse(Buffer.from(ticket.split('.')[0],'base64url'));
  assert.equal(raw.researchSessionId,undefined);assert.equal(raw.unexpected,undefined);
  assert.deepEqual(verifyHostedMcpTicket(ticket),{artifactSha256:claim.artifactSha256,entrypoint:'server.mjs',
   executable:false,name:'QA',compressedBytes:12,session:claim.session,exp:raw.exp});
 }finally{if(before===undefined)delete process.env.NEUROCENTER_MCP_HOST_SECRET;else process.env.NEUROCENTER_MCP_HOST_SECRET=before;}
});
