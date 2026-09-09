import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHandler} from '../src/service.js';

const config={clientId:'Iv-test-app',clientSecret:'server-only-secret'};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
function post(path:string,body:unknown){return new Request('https://silo.example'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});}

test('rejects non-loopback OAuth callbacks without contacting GitHub',async()=>{
 let called=false;const handle=createHandler(config,async()=>{called=true;return json({});});
 const r=await handle(post('/v1/oauth/exchange',{code:'code',codeVerifier:'a'.repeat(43),redirectUri:'https://attacker.example/callback'}));
 assert.equal(r.status,400);assert.equal(called,false);
});
test('requires PKCE rather than silently exchanging an unprotected code',async()=>{
 let called=false;const handle=createHandler(config,async()=>{called=true;return json({});});
 const r=await handle(post('/v1/oauth/exchange',{code:'code',redirectUri:'http://127.0.0.1:49152/github/callback'}));
 assert.equal(r.status,400);assert.equal(called,false);
});
test('selected mode never turns an empty repository set into all repositories',async()=>{
 let called=false;const handle=createHandler(config,async()=>{called=true;return json({});});
 const r=await handle(post('/v1/tokens/scope',{accessToken:'test-token',ownerId:7,repositoryIds:[],allowChanges:false}));
 assert.equal(r.status,400);assert.equal(called,false);
});
test('read-only scope preserves explicit repository IDs and lowers permissions',async()=>{
 const calls:{url:string;body:Record<string,unknown>}[]=[];
 const handle=createHandler(config,async(input,init)=>{
  const url=String(input);const body=JSON.parse(String(init?.body??'{}'));calls.push({url,body});
  if(url.includes('/user/installations'))return json({total_count:1,installations:[{account:{id:7},client_id:config.clientId,suspended_at:null,permissions:{contents:'write',issues:'write',metadata:'read'}}]});
  return json({token:'restricted-result',expires_at:'2099-01-01T00:00:00Z',permissions:{contents:'read'}});
 });
 const r=await handle(post('/v1/tokens/scope',{accessToken:'test-token',ownerId:7,repositoryIds:[11,12],allowChanges:false}));
 assert.equal(r.status,200);assert.deepEqual(await r.json(),{accessToken:'restricted-result',expiresAt:'2099-01-01T00:00:00Z'});
 assert.deepEqual(calls[1].body.repository_ids,[11,12]);assert.equal(calls[1].body.target_id,7);
 assert.deepEqual(calls[1].body.permissions,{contents:'read',issues:'read',metadata:'read'});
});
test('all mode is explicit and still scoped to the specified App installation owner',async()=>{
 let scoped:Record<string,unknown>|undefined;
 const handle=createHandler(config,async(input,init)=>{
  if(String(input).includes('/user/installations'))return json({total_count:1,installations:[{account:{id:7},client_id:config.clientId,suspended_at:null,permissions:{contents:'write'}}]});
  scoped=JSON.parse(String(init?.body));return json({token:'restricted-result',expires_at:'2099-01-01T00:00:00Z'});
 });
 assert.equal((await handle(post('/v1/tokens/scope',{accessToken:'test-token',ownerId:7,repositoryIds:[],allRepositories:true,allowChanges:true}))).status,200);
 assert.equal(scoped?.target_id,7);assert.equal('repository_ids' in scoped!,false);
});
test('owner not authorized by this App cannot obtain a token',async()=>{
 let calls=0;const handle=createHandler(config,async()=>{calls++;return json({total_count:0,installations:[]});});
 assert.equal((await handle(post('/v1/tokens/scope',{accessToken:'test-token',ownerId:7,repositoryIds:[11],allowChanges:true}))).status,403);assert.equal(calls,1);
});
test('upstream errors never expose a request token or the App secret',async()=>{
 const handle=createHandler(config,async()=>json({message:'echo: test-token server-only-secret'},500));
 const r=await handle(post('/v1/oauth/refresh',{refreshToken:'test-token'}));
 assert.equal(r.status,502);const text=await r.text();assert.equal(text.includes('test-token'),false);assert.equal(text.includes(config.clientSecret),false);
 assert.equal(r.headers.get('cache-control'),'no-store');
});
test('unknown operations and cross-origin browser requests are rejected',async()=>{
 const handle=createHandler(config,async()=>{throw Error('must not call');});
 assert.equal((await handle(post('/v1/arbitrary-proxy',{}))).status,404);
 const r=post('/v1/oauth/refresh',{refreshToken:'t'});r.headers.set('Origin','https://attacker.example');
 assert.equal((await handle(r)).status,403);
});

test('Octokit sends the exact PKCE verifier and callback to GitHub',async()=>{
 let sent:Record<string,unknown>|undefined;
 const handle=createHandler(config,async(input,init)=>{
  assert.equal(String(input),'https://github.com/login/oauth/access_token');
  sent=JSON.parse(String(init?.body));
  return new Response(JSON.stringify({access_token:'user-token',refresh_token:'refresh-token',expires_in:28800,refresh_token_expires_in:15897600,scope:''}),{status:200,headers:{'Content-Type':'application/json',date:new Date().toUTCString()}});
 });
 const r=await handle(post('/v1/oauth/exchange',{code:'code',codeVerifier:'x'.repeat(43),redirectUri:'http://127.0.0.1:49152/github/callback'}));
 assert.equal(r.status,200);assert.equal(sent?.code_verifier,'x'.repeat(43));assert.equal(sent?.redirect_uri,'http://127.0.0.1:49152/github/callback');assert.equal(sent?.client_secret,config.clientSecret);
 assert.deepEqual(await r.json(),{accessToken:'user-token',refreshToken:'refresh-token',expiresIn:28800,refreshTokenExpiresIn:15897600});
});
test('all plus explicit repositories is rejected rather than widening a selection',async()=>{
 const handle=createHandler(config,async()=>{throw Error('must not call');});
 assert.equal((await handle(post('/v1/tokens/scope',{accessToken:'t',ownerId:7,repositoryIds:[11],allRepositories:true,allowChanges:true}))).status,400);
});
test('suspended or wrong-App installations cannot supply permissions',async()=>{
 for(const installation of [{client_id:'another-app',suspended_at:null},{client_id:config.clientId,suspended_at:'2026-01-01'}]){
  let calls=0;const handle=createHandler(config,async()=>{calls++;return json({total_count:1,installations:[{...installation,account:{id:7},permissions:{contents:'write'}}]});});
  assert.equal((await handle(post('/v1/tokens/scope',{accessToken:'t',ownerId:7,repositoryIds:[11],allowChanges:true}))).status,403);assert.equal(calls,1);
 }
});
test('caller cancellation reaches the GitHub request',async()=>{
 const controller=new AbortController();let upstream:AbortSignal|null|undefined;
 const handle=createHandler(config,async(_input,init)=>{upstream=init?.signal;controller.abort();assert.equal(upstream?.aborted,true);throw new DOMException('Aborted','AbortError');});
 const original=post('/v1/oauth/refresh',{refreshToken:'t'});
 await handle(new Request(original,{signal:controller.signal}));assert.equal(upstream?.aborted,true);
});

test('read-only tokens omit write-only workflows and lower repository project administration',async()=>{
 let scoped:Record<string,unknown>|undefined;
 const handle=createHandler(config,async(input,init)=>{
  if(String(input).includes('/user/installations'))return json({total_count:1,installations:[{account:{id:7},client_id:config.clientId,suspended_at:null,permissions:{contents:'write',workflows:'write',repository_projects:'admin'}}]});
  scoped=JSON.parse(String(init?.body));return json({token:'restricted-result',expires_at:'2099-01-01T00:00:00Z'});
 });
 const result=await handle(post('/v1/tokens/scope',{accessToken:'t',ownerId:7,repositoryIds:[11],allowChanges:false}));
 assert.equal(result.status,200);
 assert.deepEqual(scoped?.permissions,{contents:'read',repository_projects:'read',metadata:'read'});
});
test('change-enabled tokens preserve the App installation workflow and project grants',async()=>{
 let scoped:Record<string,unknown>|undefined;
 const handle=createHandler(config,async(input,init)=>{
  if(String(input).includes('/user/installations'))return json({total_count:1,installations:[{account:{id:7},client_id:config.clientId,suspended_at:null,permissions:{contents:'write',workflows:'write',repository_projects:'admin'}}]});
  scoped=JSON.parse(String(init?.body));return json({token:'restricted-result',expires_at:'2099-01-01T00:00:00Z'});
 });
 const result=await handle(post('/v1/tokens/scope',{accessToken:'t',ownerId:7,repositoryIds:[11],allowChanges:true}));
 assert.equal(result.status,200);
 assert.deepEqual(scoped?.permissions,{contents:'write',workflows:'write',repository_projects:'admin',metadata:'read'});
});

test('restricted token revocation deletes only that token, never the parent authorization',async()=>{
 const calls:{url:string;method:string|undefined;body:unknown}[]=[];
 const handle=createHandler(config,async(input,init)=>{
  calls.push({url:String(input),method:init?.method,body:JSON.parse(String(init?.body))});
  return new Response(null,{status:204});
 });
 const result=await handle(post('/v1/tokens/revoke',{accessToken:'restricted-token'}));
 assert.equal(result.status,200);assert.deepEqual(await result.json(),{revoked:true});
 assert.deepEqual(calls,[{url:`https://api.github.com/applications/${config.clientId}/token`,method:'DELETE',body:{access_token:'restricted-token'}}]);
});
test('restricted token revocation is idempotent but does not hide a network failure',async()=>{
 const missing=createHandler(config,async()=>json({message:'Not Found'},404));
 assert.equal((await missing(post('/v1/tokens/revoke',{accessToken:'restricted-token'}))).status,200);
 const failed=createHandler(config,async()=>{throw Error('network unavailable');});
 assert.equal((await failed(post('/v1/tokens/revoke',{accessToken:'restricted-token'}))).status,502);
});
