import {request as octokitRequest} from '@octokit/request';
import {exchangeWebFlowCode,refreshToken,scopeToken,deleteAuthorization,deleteToken} from '@octokit/oauth-methods';

export interface Configuration {clientId:string;clientSecret:string}
type ObjectValue=Record<string,unknown>;
class ServiceError extends Error {constructor(readonly status:number,readonly publicMessage:string){super(publicMessage);}}
const invalid=()=>new ServiceError(400,'Invalid GitHub authorization request.');
function object(value:unknown):ObjectValue{if(!value||typeof value!=='object'||Array.isArray(value))throw invalid();return value as ObjectValue;}
function string(value:unknown,max=1024):string{if(typeof value!=='string'||!value.length||value.length>max||/[\x00-\x20\x7f]/.test(value))throw invalid();return value;}
function positiveId(value:unknown):number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<=0)throw invalid();return value;}
function boolean(value:unknown):boolean{if(typeof value!=='boolean')throw invalid();return value;}
function reply(status:number,data:unknown,headers:Record<string,string>={}):Response{return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json','Cache-Control':'no-store','Pragma':'no-cache','X-Content-Type-Options':'nosniff',...headers}});}
function callback(value:unknown):string{
 const text=string(value);let url:URL;try{url=new URL(text);}catch{throw invalid();}
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||Number(url.port)<1024||url.username||url.password||url.pathname!=='/github/callback'||url.search||url.hash)throw invalid();
 return url.href;
}
function session(data:unknown){const d=object(data);const expiresIn=positiveId(d.expires_in),refreshTokenExpiresIn=positiveId(d.refresh_token_expires_in);return {accessToken:string(d.access_token),refreshToken:string(d.refresh_token),expiresIn,refreshTokenExpiresIn};}

/** Stateless native-client endpoint. Neither credentials nor request bodies are logged. */
export function createHandler(config:Configuration,fetchImplementation:typeof fetch=fetch){
 if(!config.clientId||!config.clientSecret)throw new Error('GitHub App server configuration is required.');
 const request=octokitRequest.defaults({baseUrl:'https://api.github.com',headers:{'user-agent':'Silo-GitHub-Auth','x-github-api-version':'2022-11-28'},request:{
  fetch:async(input:RequestInfo|URL,init?:RequestInit)=>{
   const url=new URL(String(input));if(!['https://api.github.com','https://github.com'].includes(url.origin))throw new ServiceError(502,'Invalid GitHub destination.');
   return fetchImplementation(input,{...init,redirect:'error',signal:AbortSignal.any([AbortSignal.timeout(20000),...(init?.signal?[init.signal]:[])])});
  }
 }});
 return async function handle(req:Request):Promise<Response>{
  // Only a failed read or idempotent revocation is safe to repeat after an
  // ambiguous transport failure. Token mint/exchange/refresh may have succeeded.
  let retryable=false;
  try{
   const operation=request.defaults({request:{signal:AbortSignal.any([req.signal,AbortSignal.timeout(60000)])}});
   const auth={clientType:'github-app' as const,clientId:config.clientId,clientSecret:config.clientSecret,request:operation};
   const url=new URL(req.url);
   if(url.pathname==='/health'&&req.method==='GET')return reply(200,{status:'ok'});
   if(!['/v1/oauth/exchange','/v1/oauth/refresh','/v1/oauth/revoke','/v1/tokens/scope','/v1/tokens/revoke'].includes(url.pathname))return reply(404,{error:'Not found.'});
   if(req.method!=='POST')return reply(405,{error:'POST required.'});
   if(req.headers.has('origin'))return reply(403,{error:'This endpoint accepts native application requests only.'});
   if(req.headers.get('content-type')?.split(';')[0].trim()!=='application/json')return reply(415,{error:'JSON required.'});
   const raw=await req.text();if(Buffer.byteLength(raw)>65536)return reply(413,{error:'Request too large.'});
   let input:ObjectValue;try{input=object(JSON.parse(raw));}catch{throw invalid();}
   if(url.pathname==='/v1/oauth/exchange'){
    const code=string(input.code),redirectUrl=callback(input.redirectUri),verifier=string(input.codeVerifier,128);
    if(!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))throw invalid();
    // oauth-methods 6.x does not expose PKCE in its options. Octokit's request
    // defaults carry this official endpoint parameter without replacing OAuth.
    const result=await exchangeWebFlowCode({...auth,code,redirectUrl,request:operation.defaults({code_verifier:verifier})});
    return reply(200,session(result.data));
   }
   if(url.pathname==='/v1/oauth/refresh'){
    const result=await refreshToken({...auth,refreshToken:string(input.refreshToken)});
    return reply(200,session(result.data));
   }
   if(url.pathname==='/v1/oauth/revoke'){
    retryable=true;
    try{await deleteAuthorization({...auth,token:string(input.accessToken)});}catch(error){if(objectStatus(error)!==404)throw error;}
    return reply(200,{revoked:true});
   }
   if(url.pathname==='/v1/tokens/revoke'){
    retryable=true;
    try{await deleteToken({...auth,token:string(input.accessToken)});}catch(error){if(objectStatus(error)!==404)throw error;}
    return reply(200,{revoked:true});
   }
   const token=string(input.accessToken),ownerId=positiveId(input.ownerId),allowChanges=boolean(input.allowChanges);
   const allRepositories=input.allRepositories===undefined?false:boolean(input.allRepositories);
   if(!Array.isArray(input.repositoryIds)||input.repositoryIds.length>500)throw invalid();
   const repositoryIds=input.repositoryIds.map(positiveId);
   if(new Set(repositoryIds).size!==repositoryIds.length||(!allRepositories&&!repositoryIds.length)||(allRepositories&&repositoryIds.length))throw invalid();
   // The user-token endpoint lists only this App's installations. Match the
   // owner and client ID as well; never inherit another App's permission map.
   let permissions:Record<string,'read'|'write'|'admin'>|undefined;
   retryable=true;
   for(let page=1;page<=20;page++){
    const result=await operation('GET /user/installations',{headers:{authorization:`Bearer ${token}`},per_page:100,page});
    for(const item of result.data.installations){
     if(item.account?.id!==ownerId||item.client_id!==config.clientId||item.suspended_at)continue;
     permissions={};
     for(const [name,level]of Object.entries(item.permissions)){
      // GitHub defines workflows as write-only; requesting read is invalid.
      // Omit it from the explicit read grant instead of inheriting write access.
      if(!allowChanges&&name==='workflows')continue;
      if(level==='read'||level==='write'||level==='admin')permissions[name]=allowChanges?level:'read';
     }
     permissions.metadata='read';
    }
    if(permissions||result.data.installations.length<100)break;
    if(page===20)throw new ServiceError(422,'Too many GitHub installations to resolve safely.');
   }
   if(!permissions)throw new ServiceError(403,'This GitHub owner is not authorized for Silo.');
   retryable=false;
   const result=await scopeToken({...auth,token,target_id:ownerId,permissions,...(!allRepositories?{repository_ids:repositoryIds}:{})});
   const d=object(result.data),expiresAt=string(d.expires_at);
   if(!Number.isFinite(Date.parse(expiresAt))||Date.parse(expiresAt)<=Date.now())throw new ServiceError(502,'GitHub returned an invalid token expiration.');
   return reply(200,{accessToken:string(d.token),expiresAt});
  }catch(error){
   if(error instanceof ServiceError)return reply(error.status,{error:error.publicMessage});
   const status=objectStatus(error);
   if(status===401||status===404)return reply(401,{error:'GitHub authorization expired or was revoked. Reconnect GitHub.'});
   const limit=rateLimit(error,status);
   if(limit)return reply(429,{error:'GitHub is temporarily limiting requests.',code:'rate_limited',retryable:true,retryAfterSeconds:limit.seconds},limit.headers);
   if(status===403)return reply(403,{error:'GitHub refused this request. Check App access.',code:'permission_denied',retryable:false});
   if(status===400||status===422)return reply(400,{error:'GitHub rejected the authorization request.'});
   return reply(502,{error:'GitHub could not be reached. Try again.',code:'upstream_error',retryable});
  }
 };
}
function objectStatus(error:unknown):number|undefined{return typeof error==='object'&&error!==null&&'status'in error&&typeof error.status==='number'?error.status:undefined;}

/** GitHub uses 403 for both authorization failures and rate limits. Forward only
 * validated timing fields, never upstream error text or arbitrary headers. */
function rateLimit(error:unknown,status:number|undefined):{seconds:number;headers:Record<string,string>}|undefined{
 if(status!==403&&status!==429)return;
 const response=(error as {response?:{headers?:Record<string,unknown>;data?:{message?:unknown}}}).response;
 const source=response?.headers??{};
 const integer=(value:unknown):number|undefined=>{
  if(typeof value!=='string'||!/^\d+$/.test(value))return;
  const parsed=Number(value);return Number.isSafeInteger(parsed)?parsed:undefined;
 };
 const remaining=integer(source['x-ratelimit-remaining']);
 const reset=integer(source['x-ratelimit-reset']);
 const rawRetry=source['retry-after'];
 const dateRetry=typeof rawRetry==='string'&&/^[A-Za-z]{3},/.test(rawRetry)?Date.parse(rawRetry):NaN;
 const retry=integer(rawRetry)??(Number.isFinite(dateRetry)?Math.max(0,Math.ceil((dateRetry-Date.now())/1000)):undefined);
 const message=response?.data?.message;
 const secondary=typeof message==='string'&&/secondary rate limit|API rate limit exceeded|abuse detection/i.test(message);
 if(status!==429&&remaining!==0&&retry===undefined&&!secondary)return;
 const resetWait=remaining===0&&reset!==undefined?Math.max(0,reset-Math.floor(Date.now()/1000)):undefined;
 const seconds=Math.max(1,retry??0,resetWait??0,...(retry===undefined&&resetWait===undefined?[60]:[]));
 const headers:Record<string,string>={'Retry-After':String(seconds)};
 if(remaining!==undefined)headers['X-RateLimit-Remaining']=String(remaining);
 if(reset!==undefined)headers['X-RateLimit-Reset']=String(reset);
 return {seconds,headers};
}
