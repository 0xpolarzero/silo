import assert from 'node:assert/strict';
import {once} from 'node:events';
import {request as httpRequest} from 'node:http';
import {test} from 'node:test';
import {createHttpServer} from '../src/server.js';
import {createHandler} from '../src/service.js';

async function start(handler:(request:Request)=>Promise<Response>){
 const server=createHttpServer(handler);server.listen(0,'127.0.0.1');await once(server,'listening');
 const address=server.address();assert.ok(address&&typeof address!=='string');
 return {url:`http://127.0.0.1:${address.port}`,close:async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}};
}
test('real HTTP health checks have no credential or upstream dependency',async()=>{
 const server=await start(async()=>{throw Error('health must not reach handler');});
 try{
  const response=await fetch(server.url+'/healthz');
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{status:'ok'});
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(response.headers.get('pragma'),'no-cache');
  assert.equal(response.headers.get('x-content-type-options'),'nosniff');
 }finally{await server.close();}
});
test('real HTTP adapter routes native requests and rejects browser origins',async()=>{
 let calls=0;const server=await start(createHandler({clientId:'test',clientSecret:'server-only'},async()=>{calls++;throw Error('must not contact upstream');}));
 try{
  assert.equal((await fetch(server.url+'/unknown')).status,404);
  assert.equal((await fetch(server.url+'/v1/oauth/refresh')).status,405);
  const response=await fetch(server.url+'/v1/oauth/refresh',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://untrusted.example'},body:'{"refreshToken":"t"}'});
  assert.equal(response.status,403);assert.equal(calls,0);
  assert.equal(response.headers.get('cache-control'),'no-store');
 }finally{await server.close();}
});
test('real HTTP body limit rejects declared and chunked oversized input',async()=>{
 let calls=0;const server=await start(async()=>{calls++;return Response.json({ok:true});});
 try{
  assert.equal((await fetch(server.url+'/v1/oauth/refresh',{method:'POST',body:'x'.repeat(65537)})).status,413);
  const status=await new Promise<number|undefined>((resolve,reject)=>{
   const req=httpRequest(server.url+'/v1/oauth/refresh',{method:'POST',headers:{'Transfer-Encoding':'chunked'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
   req.on('error',reject);req.write('x'.repeat(32768));req.end('x'.repeat(32769));
  });
  assert.equal(status,413);assert.equal(calls,0);
 }finally{await server.close();}
});
test('real HTTP overload supplies retry timing while health remains available',async()=>{
 let active=0;let ready!:()=>void;const full=new Promise<void>(resolve=>{ready=resolve;});
 let release!:()=>void;const blocked=new Promise<void>(resolve=>{release=resolve;});
 const server=await start(async()=>{if(++active===32)ready();await blocked;return Response.json({ok:true});});
 const requests=Array.from({length:32},()=>fetch(server.url+'/v1/oauth/refresh',{method:'POST',body:'{}'}));
 try{
  await full;
  const response=await fetch(server.url+'/v1/oauth/refresh',{method:'POST',body:'{}'});
  assert.equal(response.status,503);assert.equal(response.headers.get('retry-after'),'5');
  assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).retryable,true);
  assert.equal((await fetch(server.url+'/healthz')).status,200);
 }finally{release();await Promise.all(requests);await server.close();}
});
