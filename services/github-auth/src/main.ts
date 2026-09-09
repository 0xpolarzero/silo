import {createHttpServer} from './server.js';
import {createHandler} from './service.js';

const clientId=process.env.GITHUB_CLIENT_ID,clientSecret=process.env.GITHUB_CLIENT_SECRET;
if(!clientId||!clientSecret)throw Error('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET must be configured on the server.');
const handler=createHandler({clientId,clientSecret});
const port=Number(process.env.PORT??8787);
if(!Number.isInteger(port)||port<1||port>65535)throw Error('Invalid PORT.');
const server=createHttpServer(handler);
server.listen(port,process.env.HOST??'127.0.0.1',()=>console.log('Silo GitHub authorization service ready.'));
for(const signal of ['SIGINT','SIGTERM']as const)process.on(signal,()=>{server.closeAllConnections();server.close(()=>process.exit(0));});
