/** Opt-in permanent regression against GitHub. Never part of the default suite. */
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHandler} from '../../src/service.js';

type Repository = {name:string;id:number};
export interface LiveConfiguration {
 clientId:string;clientSecret:string;userToken:string;
 read:Repository;write:Repository;denied:Repository;
 vm?:{msb:string;library:string};
}
class VerificationFailure extends Error {}
function requireValue(env:NodeJS.ProcessEnv,key:string):string {
 const value=env[key];
 if(!value||/[\x00-\x20\x7f]/.test(value))throw new VerificationFailure(`Missing or invalid ${key}.`);
 return value;
}
export function configuration(env:NodeJS.ProcessEnv,vm=false):LiveConfiguration {
 if(env.SILO_GITHUB_TEST_CONFIRM!=='private-test-repositories')throw new VerificationFailure('Set SILO_GITHUB_TEST_CONFIRM=private-test-repositories to authorize changes to the named test repositories.');
 const repository=(role:string):Repository=>{
  const name=requireValue(env,`SILO_GITHUB_TEST_${role}_REPO`);
  const id=Number(requireValue(env,`SILO_GITHUB_TEST_${role}_REPO_ID`));
  if(!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(name)||name.split('/')[1]==='.'||name.split('/')[1]==='..'||!Number.isSafeInteger(id)||id<=0)throw new VerificationFailure(`Invalid ${role} test repository name or ID.`);
  return {name,id};
 };
 const read=repository('READ'),write=repository('WRITE'),denied=repository('DENIED');
 const repos=[read,write,denied];
 if(new Set(repos.map(r=>r.name.toLowerCase())).size!==3||new Set(repos.map(r=>r.id)).size!==3||new Set(repos.map(r=>r.name.split('/')[0].toLowerCase())).size!==1)throw new VerificationFailure('Use three distinct private test repositories belonging to the same owner.');
 const result:LiveConfiguration={clientId:requireValue(env,'SILO_GITHUB_CLIENT_ID'),clientSecret:requireValue(env,'SILO_GITHUB_CLIENT_SECRET'),userToken:requireValue(env,'SILO_GITHUB_TEST_USER_TOKEN'),read,write,denied};
 if(vm)result.vm={msb:requireValue(env,'SILO_TEST_MSB'),library:requireValue(env,'SILO_TEST_LIBKRUNFW')};
 return result;
}
type ObjectValue=Record<string,unknown>;
function object(value:unknown):ObjectValue {return value&&typeof value==='object'&&!Array.isArray(value)?value as ObjectValue:{};}
function expect(condition:unknown,message:string):asserts condition {if(!condition)throw new VerificationFailure(message);}
const QUERY='query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id nameWithOwner}}';
const CREATE='mutation($input:CreateIssueInput!){createIssue(input:$input){issue{id number title}}}';
const UPDATE='mutation($input:UpdateIssueInput!){updateIssue(input:$input){issue{id title}}}';
const CLOSE='mutation($input:CloseIssueInput!){closeIssue(input:$input){issue{id state}}}';

export async function verify(config:LiveConfiguration,fetchImplementation:typeof fetch=fetch,report:(message:string)=>void=console.log):Promise<void> {
 const handler=createHandler({clientId:config.clientId,clientSecret:config.clientSecret},fetchImplementation);
 const children=new Set<string>();let issueId:string|undefined;let cleanupFailed=false;
 const call=async(token:string,path:string,body?:unknown)=>{
  let response:Response;
  try{response=await fetchImplementation(`https://api.github.com${path}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',accept:'application/vnd.github+json','x-github-api-version':'2022-11-28','user-agent':'Silo-authenticated-regression'},...(body===undefined?{}:{body:JSON.stringify(body)}),redirect:'error',signal:AbortSignal.timeout(30000)});}catch{throw new VerificationFailure('A GitHub regression request failed. No mutation was retried.');}
  let data:unknown;try{data=await response.json();}catch{throw new VerificationFailure('GitHub returned an invalid response.');}
  return {status:response.status,data:object(data)};
 };
 const service=async(route:string,body:unknown)=>{
  const response=await handler(new Request(`https://silo-regression.invalid${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));
  expect(response.ok,`Production token service failed (HTTP ${response.status}).`);
  return object(await response.json());
 };
 const graphql=async(token:string,query:string,variables:unknown)=>call(token,'/graphql',{query,variables});
 const successfulGraphql=(response:Awaited<ReturnType<typeof graphql>>)=>response.status===200&&!response.data.errors;
 const authorizationDenied=(response:Awaited<ReturnType<typeof graphql>>)=>response.status===200&&Array.isArray(response.data.errors)&&response.data.errors.some(error=>['FORBIDDEN','NOT_FOUND'].includes(String(object(error).type)));
 const repoQuery=(repository:Repository)=>({owner:repository.name.split('/')[0],name:repository.name.split('/')[1]});
 try{
  // No mutation or child issuance before checking exact IDs, privacy and ownership.
  const repositories=[];
  for(const repository of [config.read,config.write,config.denied]){
   const response=await call(config.userToken,`/repos/${repository.name}`);
   expect(response.status===200&&response.data.id===repository.id&&response.data.private===true&&String(response.data.full_name).toLowerCase()===repository.name.toLowerCase(),'Test repository preflight failed: each explicit name and ID must match a private repository accessible to the parent token.');
   repositories.push(response.data);
  }
  const ownerId=object(repositories[0].owner).id;
  expect(typeof ownerId==='number'&&repositories.every(repo=>object(repo.owner).id===ownerId),'Test repository owners do not match.');
  expect(repositories[1].has_issues===true,'Enable issues in the write test repository before running this regression.');
  report('PASS: explicit private repository preflight');
  const mint=async(ids:number[],allowChanges:boolean,allRepositories=false)=>{
   const data=await service('/v1/tokens/scope',{accessToken:config.userToken,ownerId,repositoryIds:ids,allowChanges,allRepositories});
   expect(typeof data.accessToken==='string'&&data.accessToken.length>0,'Scoped token response was invalid.');
   children.add(data.accessToken);
   const expiry=Date.parse(String(data.expiresAt));expect(Number.isFinite(expiry)&&expiry>Date.now()+120000,'Scoped token expires too soon.');
   return {token:data.accessToken,expiry:Math.floor(expiry/1000)};
  };
  const read=await mint([config.read.id,config.write.id],false);
  const write=await mint([config.write.id],true);
  for(const repository of [config.read,config.write])expect((await call(read.token,`/repos/${repository.name}`)).status===200,'Read scope rejected an authorized test repository.');
  expect((await call(read.token,`/repos/${config.denied.name}`)).status===404,'Read token exposed the denied private repository.');
  expect((await call(write.token,`/repos/${config.write.name}`)).status===200,'Write scope rejected its authorized test repository.');
  for(const repository of [config.read,config.denied])expect((await call(write.token,`/repos/${repository.name}`)).status===404,'Write token exposed a repository outside its scope.');
  report('PASS: REST repository boundaries');
  const readQuery=await graphql(read.token,QUERY,repoQuery(config.read));
  expect(successfulGraphql(readQuery)&&String(object(object(readQuery.data.data).repository).nameWithOwner).toLowerCase()===config.read.name.toLowerCase(),'GraphQL read failed for an authorized repository.');
  const deniedQuery=await graphql(read.token,QUERY,repoQuery(config.denied));
  expect(authorizationDenied(deniedQuery)&&object(deniedQuery.data.data).repository===null,'GraphQL exposed the denied private repository.');
  report('PASS: GraphQL repository boundaries');
  const marker=`Silo authenticated regression ${randomUUID()}`;
  const created=await graphql(write.token,CREATE,{input:{repositoryId:repositories[1].node_id,title:marker,body:'Created by Silo permanent authenticated integration tests. This issue is closed during cleanup.'}});
  const issue=object(object(object(created.data.data).createIssue).issue);
  if(typeof issue.id==='string')issueId=issue.id;
  expect(successfulGraphql(created)&&issueId&&issue.title===marker,'Write token could not create the isolated regression issue. Check GitHub App Issues permission.');
  const deniedMutation=await graphql(read.token,UPDATE,{input:{id:issueId,title:`${marker} unexpected read write`}});
  expect(authorizationDenied(deniedMutation)&&!object(object(deniedMutation.data.data).updateIssue).issue,'Read token was able to run a node-based write mutation.');
  const unchanged=await call(config.userToken,`/repos/${config.write.name}/issues/${issue.number}`);
  expect(unchanged.status===200&&unchanged.data.title===marker,'Denied mutation changed the test issue.');
  const changed=await graphql(write.token,UPDATE,{input:{id:issueId,title:`${marker} verified`}});
  expect(successfulGraphql(changed)&&object(object(object(changed.data.data).updateIssue).issue).title===`${marker} verified`,'Write token could not perform a node-based mutation.');
  report('PASS: node-based mutation allowed for write and denied for read');
  const all=await mint([],false,true);
  for(const repository of [config.read,config.write,config.denied])expect((await call(all.token,`/repos/${repository.name}`)).status===200,'All authorized repositories did not include an explicitly authorized test repository.');
  report('PASS: All repositories scope');
  await service('/v1/tokens/revoke',{accessToken:all.token});
  expect((await call(all.token,'/user')).status===401,'Individually revoked token still authenticated.');children.delete(all.token);
  expect((await call(config.userToken,'/user')).status===200,'Individual child revocation also revoked the parent authorization.');
  expect((await call(read.token,`/repos/${config.read.name}`)).status===200,'Individual child revocation also revoked a sibling token.');
  report('PASS: individual child revocation preserves parent and sibling');
  if(config.vm){
   const profile={version:1,owners:[{login:config.read.name.split('/')[0],repositoryIds:[config.read.id,config.write.id],readToken:read.token,writeToken:write.token,expiresAt:Math.min(read.expiry,write.expiry)}]};
   await runVm(config,profile);report('PASS: authenticated VM Git, LFS, gh and live revocation');
  }
 }finally{
  if(issueId){try{const closed=await graphql(config.userToken,CLOSE,{input:{issueId}});expect(successfulGraphql(closed)&&object(object(object(closed.data.data).closeIssue).issue).state==='CLOSED','Test issue cleanup failed.');}catch{cleanupFailed=true;}}
  for(const token of children){try{await service('/v1/tokens/revoke',{accessToken:token});}catch{cleanupFailed=true;}}
  if(cleanupFailed)throw new VerificationFailure('Cleanup could not be confirmed. Inspect the named write repository for the Silo regression issue and revoke remaining test access before rerunning.');
 }
 report('PASS: test issue closed and every remaining child token revoked');
}
async function runVm(config:LiveConfiguration,profile:unknown):Promise<void>{
 const root=fileURLToPath(new URL('../../../../../',import.meta.url));
 const env:NodeJS.ProcessEnv={};
 for(const key of ['PATH','HOME','TMPDIR','CARGO_HOME','RUSTUP_HOME','SDKROOT','DEVELOPER_DIR'])if(process.env[key])env[key]=process.env[key];
 Object.assign(env,{SILO_TEST_MSB:config.vm!.msb,SILO_TEST_LIBKRUNFW:config.vm!.library,SILO_TEST_GITHUB_PROFILE_JSON:JSON.stringify(profile),SILO_GITHUB_TEST_READ_REPO:config.read.name,SILO_GITHUB_TEST_WRITE_REPO:config.write.name,SILO_GITHUB_TEST_DENIED_REPO:config.denied.name});
 // The child receives only scoped tokens and the host toolchain environment.
 await new Promise<void>((resolve,reject)=>{
  const child=spawn('cargo',['test','--manifest-path','app/SiloUI/src-tauri/Cargo.toml','--offline','github_authenticated_guest_workflow','--','--ignored','--test-threads=1'],{cwd:root,env,stdio:'ignore'});
  child.once('error',()=>reject(new VerificationFailure('Could not launch authenticated VM regression.')));
  child.once('exit',code=>code===0?resolve():reject(new VerificationFailure('Authenticated VM regression failed. Child output is suppressed to protect credentials.')));
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  expect(process.argv.slice(2).every(arg=>arg==='--vm'),'Only --vm is accepted.');
  await verify(configuration(process.env,process.argv.includes('--vm')));
 }catch(error){console.error(error instanceof VerificationFailure?error.message:'Authenticated GitHub regression failed. Details suppressed to protect credentials.');process.exitCode=1;}
}
