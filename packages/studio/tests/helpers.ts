import { createApp } from '../server/app.ts';
import type { Settings } from '../server/auth.ts';
export const origin = 'http://127.0.0.1:8787';
export const ownerPassword = 'correct-horse-battery-studio';
export const testSettings = (dataDir: string): Settings => ({production:false,origin,dataDir,demo:false});
export type TestApp = Awaited<ReturnType<typeof createApp>>;
export async function setup(app:TestApp['app']) {
  const response=await app.inject({method:'POST',url:'/api/auth/setup',headers:{origin},payload:{email:'owner@example.test',name:'Test owner',password:ownerPassword}});
  if(response.statusCode!==200)throw new Error(response.body);
  return {user:response.json(),cookie:response.cookies.find(c=>c.name==='studio_session')!.value};
}
export function client(app:TestApp['app'],cookie:string) {
  return async (method:'GET'|'POST'|'PUT'|'PATCH'|'DELETE',url:string,payload?:unknown,extraHeaders:Record<string,string>={})=> app.inject({method,url,headers:{origin,cookie:`studio_session=${cookie}`,...extraHeaders},...(payload===undefined?{}:{payload:payload as any})});
}
export async function project(request:ReturnType<typeof client>,title='Acceptance workspace') {
  const response=await request('POST','/api/projects',{title,description:'Traceable implementation',repository:''});
  if(response.statusCode!==201)throw new Error(response.body);return response.json();
}
export async function member(app:TestApp['app'],request:ReturnType<typeof client>,projectId:string,role:'editor'|'viewer'|'owner',email=`${role}@example.test`) {
  const response=await request('POST',`/api/projects/${projectId}/members`,{email,name:`Test ${role}`,role});
  if(response.statusCode!==200)throw new Error(response.body);
  const login=await app.inject({method:'POST',url:'/api/auth/login',headers:{origin},payload:{email,password:response.json().temporaryPassword}});
  if(login.statusCode!==200)throw new Error(login.body);
  return {user:login.json(),cookie:login.cookies.find(c=>c.name==='studio_session')!.value};
}
