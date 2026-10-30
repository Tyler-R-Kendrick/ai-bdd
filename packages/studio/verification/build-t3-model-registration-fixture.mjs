/** Test-only boundary fault: empty discovery, genuine native MCP and genuine local generation. */
import{build}from'esbuild';import{readFile,mkdir,copyFile}from'node:fs/promises';import{resolve,dirname,join,isAbsolute}from'node:path';import{fileURLToPath}from'node:url';
const here=dirname(fileURLToPath(import.meta.url));const studio=resolve(here,'..');const output=process.argv[2];if(!output||!isAbsolute(output))throw new Error('Provide an absolute disposable fixture output directory');await mkdir(output,{recursive:true});
for(const registered of[false,true]){
 await build({entryPoints:[join(here,'t3-model-registration-fixture.ts')],bundle:true,platform:'node',format:'esm',packages:'external',outfile:join(output,(registered?'registered':'control')+'.mjs'),plugins:[{name:'owned-empty-model-discovery-boundary',setup(build){build.onLoad({filter:/native-t3-runtime\.ts$/},async args=>{let s=await readFile(args.path,'utf8');const registration=', customModels: [this.profile.model]';if(s.split(registration).length!==2)throw new Error('Expected exactly one official model registration');if(!registered)s=s.replace(registration,'');s=s.replace("import { createServer, type Server } from 'node:http';","import { createServer, request as inventoryRequest, type Server } from 'node:http';");s=s.replace('  modelServer?: Server;',`  modelServer?: Server;
  inventoryProxy?: Server; inventoryProxyOrigin = ''; inventoryBlocked = 0;
  async prepareInventoryProxy() {
    if (this.inventoryProxy) return;
    this.inventoryProxy = createServer((req,res) => {
      const endpoint = new URL(req.url ?? '/', this.openOrigin);
      if (req.method === 'GET' && endpoint.pathname === '/api/model') {
        this.inventoryBlocked++;
        res.setHeader('content-type','application/json'); res.end(JSON.stringify({data:[]})); return;
      }
      const upstream = inventoryRequest(endpoint, {method:req.method,headers:req.headers}, response => {res.writeHead(response.statusCode ?? 502,response.headers);response.pipe(res)});
      upstream.on('error',()=>{if(!res.headersSent)res.writeHead(503);res.end()});req.pipe(upstream);
    });
    this.inventoryProxy.listen(0,'127.0.0.1');await once(this.inventoryProxy,'listening');
    this.inventoryProxyOrigin = 'http://127.0.0.1:'+(this.inventoryProxy.address() as any).port;
  }`);s=s.replace('    let prior: any;', '    await this.prepareInventoryProxy();\n    let prior: any;');s=s.replace('serverUrl: this.openOrigin,','serverUrl: this.inventoryProxyOrigin,');s=s.replace('this.modelServer = undefined; }',`this.modelServer = undefined; await closeServer(this.inventoryProxy); this.inventoryProxy = undefined; if (this.inventoryBlocked) console.error(JSON.stringify({scope:'owned-empty-discovery-proxy',emptyModelCatalogRequests:this.inventoryBlocked})); }`);return{contents:s,loader:'ts',resolveDir:join(studio,'server/local')}})}}]});
}

for(const name of ['studio-local-worker.mjs','studio-local-decisions.mjs'])await copyFile(join(studio,'server/local',name),join(output,name));
