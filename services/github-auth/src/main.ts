import {createServer} from 'node:http';
import {createHandler} from './service.js';

const clientId=process.env.GITHUB_CLIENT_ID,clientSecret=process.env.GITHUB_CLIENT_SECRET;
if(!clientId||!clientSecret)throw Error('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be configured on the server.');
const handler=createHandler({clientId,clientSecret});
const port=Number(process.env.PORT??8787);
if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid PORT.');
let active=0;
const server=createServer({maxHeaderSize:8192,requestTimeout:30000,headersTimeout:10000},async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 if(active>=32){res.writeHead(503);res.end();return;}
 active++;
 const abort=new AbortController();
 res.on('close',()=>abort.abort());
 try{
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
server.listen(port,process.env.HOST??'127.0.0.1',()=>console.log('Silo GitHub authorization service ready.'));
for(const signal of ['SIGINT','SIGTERM']as const)process.on(signal,()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
