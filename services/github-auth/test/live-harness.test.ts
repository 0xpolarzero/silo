import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {configuration,verify} from './live/authorized-github.js';
const environment:NodeJS.ProcessEnv={
 SILO_GITHUB_TEST_CONFIRM:'private-test-repositories',SILO_GITHUB_CLIENT_ID:'Iv-regression',SILO_GITHUB_CLIENT_SECRET:'synthetic-app-secret',SILO_GITHUB_TEST_USER_TOKEN:'synthetic-parent',
 SILO_GITHUB_TEST_READ_REPO:'owner/read',SILO_GITHUB_TEST_READ_REPO_ID:'11',SILO_GITHUB_TEST_WRITE_REPO:'owner/write',SILO_GITHUB_TEST_WRITE_REPO_ID:'12',SILO_GITHUB_TEST_DENIED_REPO:'owner/denied',SILO_GITHUB_TEST_DENIED_REPO_ID:'13',
};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
test('authenticated regression requires explicit fixtures and credentials instead of skipping',()=>{
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('./live/authorized-github.js',import.meta.url))],{env:{},encoding:'utf8'});
 assert.equal(result.status,1);assert.match(result.stderr,/SILO_GITHUB_TEST_CONFIRM/);assert.doesNotMatch(result.stdout,/PASS/);
 assert.throws(()=>configuration({...environment,SILO_GITHUB_TEST_USER_TOKEN:undefined}),/SILO_GITHUB_TEST_USER_TOKEN/);
 assert.throws(()=>configuration(environment,true),/SILO_TEST_MSB/);
});
test('authenticated regression rejects ambiguous or injectable repository selections',()=>{
 for(const patch of [
  {SILO_GITHUB_TEST_DENIED_REPO_ID:'11'},
  {SILO_GITHUB_TEST_DENIED_REPO:'another/denied'},
  {SILO_GITHUB_TEST_DENIED_REPO:'owner/../other'},
  {SILO_GITHUB_TEST_DENIED_REPO:'owner/..'},
  {SILO_GITHUB_TEST_DENIED_REPO_ID:'9007199254740992'},
 ])assert.throws(()=>configuration({...environment,...patch}));
});
test('public or mismatched repositories fail before tokens or mutations are created',async()=>{
 let calls=0;
 await assert.rejects(verify(configuration(environment),async(input,init)=>{
  calls++;assert.equal(init?.method,'GET');assert.equal(String(input),'https://api.github.com/repos/owner/read');
  return json({id:11,full_name:'owner/read',private:false});
 },()=>{}),/private repository/);
 assert.equal(calls,1);
});
test('partial token issuance is revoked on failure without printing credentials',async()=>{
 let scopes=0;let revocations=0;const messages:string[]=[];
 await assert.rejects(verify(configuration(environment),async(input,init)=>{
  const url=new URL(String(input));
  if(url.pathname.startsWith('/repos/')){
   const name=url.pathname.slice('/repos/'.length);const id=name.endsWith('/read')?11:name.endsWith('/write')?12:13;
   return json({id,full_name:name,private:true,owner:{id:7},has_issues:true});
  }
  if(url.pathname==='/user/installations')return json({total_count:1,installations:[{account:{id:7},client_id:'Iv-regression',suspended_at:null,permissions:{contents:'write',issues:'write',metadata:'read'}}]});
  if(url.pathname.endsWith('/token/scoped')){
   scopes++;
   return scopes===1?json({token:'synthetic-child',expires_at:'2099-01-01T00:00:00Z'}):json({message:'synthetic-app-secret synthetic-parent'},403);
  }
  assert.equal(init?.method,'DELETE');assert.equal(url.pathname,'/applications/Iv-regression/token');
  assert.equal(JSON.parse(String(init?.body)).access_token,'synthetic-child');revocations++;return new Response(null,{status:204});
 },message=>messages.push(message)),/Production token service failed \(HTTP 403\)/);
 assert.equal(scopes,2);assert.equal(revocations,1);
 assert.equal(messages.length,1);assert.doesNotMatch(messages.join('\n'),/synthetic|secret|token/);
});
