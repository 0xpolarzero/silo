import {createServer} from 'node:http';

/** Bounded native HTTP adapter. A health probe does not read credentials or call GitHub. */
export function createHttpServer(handler:(request:Request)=>Promise<Response>){
let active=0;
return createServer({maxHeaderSize:8192,requestTimeout:30000,headersTimeout:10000},async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 res.setHeader('Pragma','no-cache');
 res.setHeader('X-Content-Type-Options','nosniff');
 if(req.method==='GET'&&(req.url==='/healthz'||req.url==='/health')){
  res.writeHead(200,{'Content-Type':'application/json'});res.end('{"status":"ok"}');return;
 }
 if(active>=32){res.writeHead(503,{'Content-Type':'application/json','Retry-After':'5'});res.end(JSON.stringify({error:'GitHub sign-in service is busy.',code:'service_busy',retryable:true,retryAfterSeconds:5}));return;}
 active++;
 const abort=new AbortController();
 res.on('close',()=>abort.abort());
 try{
  const declaredSize=Number(req.headers['content-length']);
  if(Number.isFinite(declaredSize)&&declaredSize>65536){res.writeHead(413);res.end();return;}
  let size=0;const chunks:Buffer[]=[];
  for await(const chunk of req){size+=chunk.length;if(size>65536){res.writeHead(413);res.end();return;}chunks.push(Buffer.from(chunk));}
  // A fixed base prevents Host-header input from selecting any upstream URL.
  const headers=new Headers();for(const [name,value]of Object.entries(req.headers)){if(typeof value==='string')headers.set(name,value);}
  const method=req.method??'GET';
  const request=new Request('http://localhost'+(req.url??'/'),{method,headers,signal:abort.signal,...(!['GET','HEAD'].includes(method)?{body:Buffer.concat(chunks)}:{})});
  const result=await handler(request);
  res.writeHead(result.status,Object.fromEntries(result.headers));res.end(Buffer.from(await result.arrayBuffer()));
 }catch{
  // Never log request bodies, authorization headers, exception objects or tokens.
  if(!res.headersSent)res.writeHead(502,{'Content-Type':'application/json'});
  res.end('{"error":"GitHub request failed. Try again."}');
 }finally{active--;}
});
}
