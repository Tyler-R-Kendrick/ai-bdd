/** Controlled OAuth browser boundary. No live Connect/GitHub accounts or model calls. */
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import {existsSync} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {chromium,type Browser,type BrowserContext,type CDPSession,type Page} from '@playwright/test';
import {createApp} from '../server/app.ts';
import type {Settings} from '../server/auth.ts';
import type {GitHubSignInProvider} from '../server/github-signin.ts';
import {githubSignInFixture} from './identity/github-signin-fixture.ts';

const managedOrigin='https://connect.vercel.com';
const connectorId='scl_OpenSignInFixture';
// These identify accounts only at the owned test provider, not at Studio's UI.
const firstActor='first-github-actor@example.test',secondActor='second-github-actor@example.test';
const clientDir=resolve(import.meta.dirname,'../dist/client');
type Studio=Awaited<ReturnType<typeof createApp>>;
type Person={id:string;name:string};
let browser:Browser,studio:Studio,issuer:Awaited<ReturnType<typeof githubSignInFixture>>;
let origin:string,directory:string,contexts:BrowserContext[],requests:{method:string;path:string}[];
let connectStarts:number,blockedExternal:number,harnessFailures:number,pageErrors:string[];

beforeAll(async()=>{
  expect(existsSync(join(clientDir,'index.html')),'Build the reviewed Studio client before controlled browser integration').toBe(true);
  const executable=process.env.STUDIO_CHROMIUM_PATH??process.env.AI_BDD_CHROMIUM_PATH??(existsSync('/usr/bin/chromium')?'/usr/bin/chromium':undefined);
  browser=await chromium.launch({headless:true,args:['--host-resolver-rules=MAP localhost 127.0.0.1'],...(executable?{executablePath:executable}:{})});
});
afterAll(async()=>{await browser?.close();});
beforeEach(async()=>{
  contexts=[];requests=[];connectStarts=0;blockedExternal=0;harnessFailures=0;pageErrors=[];
  directory=await mkdtemp(join(tmpdir(),'studio-open-github-browser-'));issuer=await githubSignInFixture();
  const provider:GitHubSignInProvider={
    async authorizationUrl(input){
      const controlled=new URL(await issuer.provider.authorizationUrl(input));
      const authorization=new URL('/oauth/authorize',managedOrigin);authorization.search=controlled.search;return authorization.href;
    },
    async authenticate(input){
      // This independent fixture consumes a one-use code and verifies exact callback/S256 PKCE.
      const identity=await issuer.provider.authenticate(input);
      if(identity.kind!=='github')throw new Error('Controlled provider returned an unexpected principal');
      return {kind:'vercel-connect',issuer:managedOrigin,connectorId,subject:'fixture:'+identity.id,name:identity.name,verifiedEmails:[]};
    },
  };
  const settings:Settings={production:false,demo:false,origin:'http://127.0.0.1:0',dataDir:directory,githubSignInProvider:provider};
  studio=await createApp(settings,{db:join(directory,'studio.sqlite'),clientDir,startupDispatchLimit:0});
  // No user, owner, membership or invitation is seeded by this test composition.
  expect((await studio.store.one('SELECT COUNT(*) AS n FROM users')).n).toBe(0);
  studio.app.addHook('onRequest',async req=>{requests.push({method:req.method,path:(req.raw.url??req.url).split('?')[0]!});});
  origin=await studio.app.listen({port:0,host:'127.0.0.1'});settings.origin=origin;
});
afterEach(async()=>{
  for(const context of contexts)await context.close().catch(()=>{});
  await studio?.app.close();await issuer?.close();if(directory)await rm(directory,{recursive:true,force:true});
});

async function pageFixture(){
  const context=await browser.newContext({viewport:{width:1600,height:1000},ignoreHTTPSErrors:false,serviceWorkers:'block'});contexts.push(context);
  const page=await context.newPage(),cdp=await context.newCDPSession(page);
  page.on('pageerror',error=>pageErrors.push(String(error.message)));
  await cdp.send('Fetch.enable',{patterns:[{urlPattern:'*',requestStage:'Request'}]});
  cdp.on('Fetch.requestPaused',event=>{void controlledRequest(cdp,event).catch(()=>{
    harnessFailures++;void cdp.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'}).catch(()=>{});
  });});
  return {page,context};
}
async function controlledRequest(cdp:CDPSession,event:any){
  const url=new URL(event.request.url);
  if(url.origin===managedOrigin){
    if(url.pathname!=='/oauth/authorize'){blockedExternal++;return cdp.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'});}
    connectStarts++;
    // Browser-only relay of the fixed Connect origin. Actual Auth code, durable
    // challenges, one-use provider code, PKCE, user admission and session all run.
    const controlled=new URL('/authorize',issuer.origin);controlled.hostname='localhost';controlled.search=url.search;
    return cdp.send('Fetch.fulfillRequest',{requestId:event.requestId,responseCode:302,responseHeaders:[{name:'location',value:controlled.href},{name:'cache-control',value:'no-store'}],body:''});
  }
  const providerOrigin=new URL(issuer.origin);providerOrigin.hostname='localhost';
  if(url.origin===origin||url.origin===issuer.origin||url.origin===providerOrigin.origin)return cdp.send('Fetch.continueRequest',{requestId:event.requestId});
  blockedExternal++;return cdp.send('Fetch.failRequest',{requestId:event.requestId,errorReason:'BlockedByClient'});
}
async function startFromNormalUi(page:Page){
  await page.goto(origin+'/',{waitUntil:'domcontentloaded'});
  const action=page.getByRole('link',{name:'Continue with GitHub',exact:true});
  await action.waitFor({state:'visible'});expect(await action.count()).toBe(1);
  expect(await action.getAttribute('href')).toBe('/api/auth/github');
  expect(await page.locator('input,form').count()).toBe(0);
  await action.click();
  await page.getByRole('heading',{name:'Owned GitHub OAuth test provider',exact:true}).waitFor();
  const binding=(await page.context().cookies(origin+'/api/auth/github/callback')).find(cookie=>cookie.name==='studio_github_signin');
  expect(binding).toMatchObject({httpOnly:true,sameSite:'Lax',path:'/api/auth/github'});
}
async function submitOwnedIdentity(page:Page,actor:string){
  await page.getByLabel('Fixture GitHub email',{exact:true}).fill(actor);
  await page.getByRole('button',{name:'Continue fixture GitHub sign-in',exact:true}).click();
}
async function finishInWorkspace(page:Page,actor:string):Promise<Person>{
  await submitOwnedIdentity(page,actor);
  await page.locator('.studio').waitFor({state:'visible'});
  await page.getByRole('button',{name:'New project',exact:true}).first().waitFor({state:'visible'});
  const me=await page.request.get(origin+'/api/me');expect(me.status()).toBe(200);
  const person=await me.json();expect(typeof person.id).toBe('string');expect(person.id.length).toBeGreaterThan(20);
  expect((await page.context().cookies(origin)).some(cookie=>cookie.name==='studio_session'&&cookie.httpOnly&&cookie.sameSite==='Strict')).toBe(true);
  return person;
}
async function logout(page:Page){
  await page.getByRole('button',{name:'Sign out',exact:true}).click();
  await page.getByRole('link',{name:'Continue with GitHub',exact:true}).waitFor();
  expect((await page.request.get(origin+'/api/me')).status()).toBe(401);
}
async function onlyNormalGitHubAuthentication(){
  expect(requests.some(req=>/enrollment|invitation|signup/.test(req.path))).toBe(false);
  expect(requests.some(req=>['/api/auth/login','/api/auth/setup','/api/auth/demo'].includes(req.path))).toBe(false);
  expect(requests.filter(req=>req.method==='POST'&&req.path!=='/api/auth/logout')).toHaveLength(0);
  expect(harnessFailures).toBe(0);expect(blockedExternal).toBe(0);expect(pageErrors).toEqual([]);
  expect((await studio.store.one('SELECT COUNT(*) AS n FROM studio_durable_jobs')).n).toBe(0);
}

describe('controlled normal GitHub sign-in with automatic internal accounts',()=>{
  it('opens a workspace for a new email-less managed principal without a seeded account and keeps its generated identity on relogin',async()=>{
    const {page}=await pageFixture();await startFromNormalUi(page);
    expect((await studio.store.one('SELECT COUNT(*) AS n FROM sessions')).n).toBe(0);
    const created=await finishInWorkspace(page,firstActor);
    expect((await studio.store.one('SELECT COUNT(*) AS n FROM users')).n).toBe(1);
    expect(await studio.store.one('SELECT user_id,subject FROM github_connect_signin_identities')).toEqual({user_id:created.id,subject:'fixture:'+issuer.account(firstActor).id});
    expect(issuer.tokenRequests).toBe(1);await logout(page);
    await startFromNormalUi(page);const again=await finishInWorkspace(page,firstActor);
    expect(again.id).toBe(created.id);
    expect((await studio.store.one('SELECT COUNT(*) AS n FROM users')).n).toBe(1);
    expect((await studio.store.one('SELECT COUNT(*) AS n FROM github_connect_signin_identities')).n).toBe(1);
    expect(issuer.tokenRequests).toBe(2);expect(connectStarts).toBe(2);
    await logout(page);expect((await studio.store.one('SELECT COUNT(*) AS n FROM sessions')).n).toBe(0);
    await onlyNormalGitHubAuthentication();
  });

  it('creates distinct internal identities for distinct genuine managed principals and does not transfer browser sessions',async()=>{
    const first=await pageFixture();await startFromNormalUi(first.page);const a=await finishInWorkspace(first.page,firstActor);
    const second=await pageFixture();expect((await second.page.request.get(origin+'/api/me')).status()).toBe(401);
    await startFromNormalUi(second.page);const b=await finishInWorkspace(second.page,secondActor);
    expect(a.id===b.id).toBe(false);
    expect((await studio.store.one('SELECT COUNT(*) AS n FROM users')).n).toBe(2);
    expect((await studio.store.one('SELECT COUNT(*) AS n FROM github_connect_signin_identities')).n).toBe(2);
    expect((await (await first.page.request.get(origin+'/api/me')).json()).id).toBe(a.id);
    expect((await (await second.page.request.get(origin+'/api/me')).json()).id).toBe(b.id);
    expect(issuer.tokenRequests).toBe(2);await logout(first.page);await logout(second.page);
    expect((await studio.store.one('SELECT COUNT(*) AS n FROM sessions')).n).toBe(0);
    await onlyNormalGitHubAuthentication();
  });

  it('does not create an account or session when the genuine controlled provider exchange fails',async()=>{
    const {page}=await pageFixture();await startFromNormalUi(page);issuer.failTokens(true);
    await submitOwnedIdentity(page,firstActor);await page.getByRole('alert').waitFor({state:'visible'});
    const final=new URL(page.url());expect(final.searchParams.get('signin')).toBe('failed');expect([...final.searchParams.keys()]).toEqual(['signin']);
    expect((await page.request.get(origin+'/api/me')).status()).toBe(401);
    expect((await studio.store.one('SELECT COUNT(*) AS n FROM users')).n).toBe(0);
    expect((await studio.store.one('SELECT COUNT(*) AS n FROM sessions')).n).toBe(0);
    expect((await studio.store.one('SELECT COUNT(*) AS n FROM github_connect_signin_identities')).n).toBe(0);
    expect(issuer.tokenRequests).toBe(1);await onlyNormalGitHubAuthentication();
  });
});
