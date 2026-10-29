import { createApp } from './app.ts';
import { settingsFromEnv } from './auth.ts';
import { resolve } from 'node:path';
const settings=settingsFromEnv(process.env);
// The bundle is dist/server/main.js; source development uses a separately served Vite client.
const clientDir=resolve(import.meta.dirname,'../client');
const {app}=await createApp(settings,{logger:true,clientDir});
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void app.close().then(()=>process.exit(0));});
await app.listen({port:Number(process.env.STUDIO_PORT??8787),host:process.env.STUDIO_HOST??'127.0.0.1'});
