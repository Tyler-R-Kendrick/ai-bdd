// Read-only screenshots of already completed, real hosted local-model work. Never starts inference.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from '@playwright/test';
import { hostedLocalAITarget, assertLocalAgentCatalog, assertLocalDecisionCatalog } from './hosted-local-ai-guards.ts';
const target = hostedLocalAITarget(process.env), origin = target.origin;
assert(process.env.STUDIO_HOSTED_LOCAL_AI_RECEIPT && process.env.STUDIO_HOSTED_LOCAL_AI_UI_EVIDENCE_DIR);
const receiptBytes = await readFile(process.env.STUDIO_HOSTED_LOCAL_AI_RECEIPT);
assert(receiptBytes.length < 2 * 1024 * 1024);
const receipt = JSON.parse(receiptBytes.toString('utf8'));
assert.equal(receipt.kind, 'hosted downloaded local-model chat and decisions');
assert.equal(receipt.passed, true);
assert.equal(receipt.origin, origin);
assert.equal(receipt.deploymentSourceProvidedByOperator, process.env.STUDIO_HOSTED_LOCAL_AI_SOURCE);
assert.equal(receipt.deploymentIdProvidedByOperator, process.env.STUDIO_HOSTED_LOCAL_AI_DEPLOYMENT_ID);
const directory = process.env.STUDIO_HOSTED_LOCAL_AI_UI_EVIDENCE_DIR;
await mkdir(directory, { recursive: true });
try { await lstat(join(directory, 'hosted-local-ai-ui.json')); throw new Error('A fresh capture directory is required'); }
catch(error) { if(error.code !== 'ENOENT') throw error; }
const ids = receipt.resources;
for(const key of ['projectId','artifactId','threadId','assistantMessageId','reviewJobId','evaluationId']) assert.match(ids[key], /^[a-f0-9-]{36}$/);
const report = {
  schemaVersion: 1, kind: 'read-only actual hosted local-AI screenshots', origin,
  source: receipt.deploymentSourceProvidedByOperator, deploymentId: receipt.deploymentIdProvidedByOperator,
  priorReceiptSha256: createHash('sha256').update(receiptBytes).digest('hex'), resources: ids,
  startedAt: new Date().toISOString(), passed: false, captures: [],
  modelRequests: 0, sourceWrites: 0, tlsCertificateVerification: true, credentialsRecorded: false,
  blockedForeignRequests: 0, blockedPageMutations: 0,
  webSocket: { transport: 'Playwright exact-origin routed relay', observed: 0, framesReceived: 0, errors: 0 },
};
let browser, context, stage = 'launch', sessionCreated = false;
try {
  const proxyAddress = process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
  const proxy = proxyAddress ? new URL(proxyAddress) : null;
  browser = await chromium.launch({
    headless: true,
    ...(process.env.STUDIO_BROWSER_EXECUTABLE ? {executablePath:process.env.STUDIO_BROWSER_EXECUTABLE} : {}),
    ...(proxy ? {proxy:{server:proxy.origin,...(proxy.username ? {username:decodeURIComponent(proxy.username),password:decodeURIComponent(proxy.password)}:{})}} : {}),
  });
  report.browserVersion = browser.version();
  context = await browser.newContext({viewport:{width:1600,height:1280},ignoreHTTPSErrors:false,serviceWorkers:'block',extraHTTPHeaders:target.previewHeaders});
  await context.route('**/*', async route => {
    try {
      const req = route.request();
      if(new URL(req.url()).origin !== origin) {report.blockedForeignRequests++;return await route.abort('blockedbyclient');}
      if(!['GET','HEAD','OPTIONS'].includes(req.method())) {report.blockedPageMutations++;return await route.abort('blockedbyclient');}
      await route.continue();
    } catch {report.routeErrors=(report.routeErrors??0)+1;}
  });
  await context.routeWebSocket('**/*', socket => {
    try {
      const url = new URL(socket.url()), expected = new URL(origin);
      if(url.protocol!=='wss:'||url.hostname!==expected.hostname||url.port) {report.blockedForeignRequests++;socket.close({code:1008,reason:'Only the approved origin is permitted'});return;}
      socket.connectToServer();
    } catch {report.webSocket.errors++;}
  });
  async function api(path, options={}) {
    const url = new URL(path,origin); assert.equal(url.origin,origin); assert(url.pathname.startsWith('/api/'));
    const response = await context.request.fetch(url.href,{...options,maxRedirects:0,timeout:60000,headers:{origin,...options.headers}});
    assert.equal(response.status(),200); return response.json();
  }
  stage='owner-login';
  assert(process.env.STUDIO_HOSTED_LOCAL_AI_EMAIL&&process.env.STUDIO_HOSTED_LOCAL_AI_PASSWORD_FILE);
  const password=(await readFile(process.env.STUDIO_HOSTED_LOCAL_AI_PASSWORD_FILE,'utf8')).replace(/\r?\n$/,'');
  await api('/api/auth/login',{method:'POST',data:{email:process.env.STUDIO_HOSTED_LOCAL_AI_EMAIL,password}}); sessionCreated=true;
  const profiles={agent:assertLocalAgentCatalog(await api(`/api/artifacts/${ids.artifactId}/agent/profile`)),decision:assertLocalDecisionCatalog(await api(`/api/artifacts/${ids.artifactId}/decision/profile`))};
  assert.deepEqual(profiles.agent.profile,receipt.profilePersistence.chatProfile);
  assert.equal(profiles.decision.profile.minimumConfidence,.7);
  const bundle=await api(`/api/artifacts/${ids.artifactId}`);
  assert.equal(bundle.artifact.version,receipt.sourceVersion);
  assert.equal(createHash('sha256').update(JSON.stringify(bundle.artifact.content)).digest('hex'),receipt.sourceHash);
  assert(bundle.messages.some(message=>message.id===ids.assistantMessageId&&message.body===receipt.chat.answer));
  const page=await context.newPage(); let pageErrors=0, serverFailures=0;
  page.on('pageerror',()=>pageErrors++);
  page.on('response',response=>{if(response.status()>=500)serverFailures++;});
  page.on('websocket',socket=>{report.webSocket.observed++;socket.on('framereceived',()=>report.webSocket.framesReceived++);socket.on('socketerror',()=>report.webSocket.errors++);});
  async function inViewport(locator) {
    await locator.scrollIntoViewIfNeeded(); const box=await locator.boundingBox(), viewport=page.viewportSize();
    assert(box&&box.x>=0&&box.y>=0&&box.x+box.width<=viewport.width+1&&box.y+box.height<=viewport.height+1);
  }
  async function capture(name, locator, claim) {
    await page.evaluate(()=>document.fonts.ready); await inViewport(locator);
    assert.equal(pageErrors,0);assert.equal(serverFailures,0);
    assert.equal(await page.locator('.error-banner').count(),0);
    await page.screenshot({path:join(directory,name),fullPage:true,animations:'disabled'});
    report.captures.push({file:name,viewport:page.viewportSize(),claim,targetFullyInViewport:true});
  }
  stage='retained-chat-desktop';
  await page.goto(new URL(`/?project=${ids.projectId}&artifact=${ids.artifactId}`,origin).href,{waitUntil:'domcontentloaded',timeout:90000});
  const assistant=page.locator('.message-assistant .message-body').filter({hasText:/^\s*4[.!]?\s*$/});
  await assistant.waitFor({state:'visible',timeout:60000});
  assert.equal(await assistant.count(),1);
  await capture('hosted-local-chat-desktop.png',assistant,'Actual persisted native T3/studioLocal answer 4 in the artifact thread.');
  stage='native-local-profile-desktop';
  await page.getByRole('tab',{name:'Connections',exact:true}).click();
  const agent=page.getByRole('region',{name:'Agent runtime',exact:true}),decision=page.getByRole('region',{name:'Decision models',exact:true});
  assert.equal(await agent.getByRole('combobox',{name:'Agent harness',exact:true}).inputValue(),'t3-code');
  assert.equal(await agent.getByRole('combobox',{name:'Model provider',exact:true}).inputValue(),'studioLocal');
  await capture('hosted-local-agent-profile-desktop.png',agent,'The saved default generative profile is native T3 Code with the registered local CPU model. No fallback was selected.');
  assert.equal(await decision.getByRole('combobox',{name:'Decision provider',exact:true}).inputValue(),'llama-cpp-cpu');
  assert.equal(await decision.getByRole('combobox',{name:'Decision model',exact:true}).inputValue(),'qwen2.5-0.5b-instruct-q4-k-m');
  assert.equal(await decision.getByRole('spinbutton',{name:'Minimum decision confidence',exact:true}).inputValue(),'0.7');
  await decision.getByText(/not calibrated probabilities of correctness/i).waitFor({state:'visible'});
  await capture('hosted-local-decision-profile-desktop.png',decision,'A separately persisted local decision provider/model uses threshold 0.7, with an explicit uncalibrated-option-likelihood note.');
  stage='retained-native-review-desktop';
  await page.getByRole('button',{name:'Review design',exact:true}).click();
  const modal=page.getByRole('dialog',{name:'Design review',exact:true}),assessment=modal.getByRole('region',{name:'Design assessment'});
  await assessment.waitFor({state:'visible',timeout:60000});assert.equal(await assessment.count(),1);
  const goal=assessment.locator('.design-review-finding').filter({hasText:'An actionable implementation goal is identifiable'});
  await capture('hosted-local-predicate-desktop.png',goal,'Retained actual local predicate result; the displayed outcome may be accepted or honestly abstained.');
  const choice=assessment.locator('.design-review-finding').filter({hasText:'Authoring harness advice'});
  await capture('hosted-local-choice-desktop.png',choice,'Retained actual finite harness choice and conditional option mass; advice does not change the selected harness or approve work.');
  await page.keyboard.press('Escape');
  stage='retained-chat-mobile';
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'Show artifact panel',exact:true}).click();
  await page.getByRole('tab',{name:'Chat',exact:true}).click();
  await capture('hosted-local-chat-mobile.png',assistant,'The same persisted native local answer 4 in the mobile artifact discussion.');
  report.pageErrors=pageErrors; report.serverFailures=serverFailures;
  assert.equal(report.blockedPageMutations,0);
  report.profilePersistenceVerified=profiles;
  report.qualityObservations=receipt.qualityObservations;
  report.passed=true;
} catch(error) {
  report.failure={stage,code:'read-only-hosted-local-ui-failure',browserNetworkCode:String(error?.message??'').match(/net::(ERR_[A-Z_]+)/)?.[1]??null};
  process.exitCode=1;
} finally {
  if(context&&sessionCreated) {
    try {const response=await context.request.post(new URL('/api/auth/logout',origin).href,{headers:{origin},data:{},maxRedirects:0,timeout:60000});report.ownedSessionClosed=response.status()===200;}
    catch {report.ownedSessionClosed=false;}
  }
  await context?.unrouteAll({behavior:'ignoreErrors'}).catch(()=>{});
  await context?.close().catch(()=>{});await browser?.close().catch(()=>{});
  if(sessionCreated&&!report.ownedSessionClosed){report.passed=false;process.exitCode=1;}
}
report.completedAt=new Date().toISOString();
await writeFile(join(directory,'hosted-local-ai-ui.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({passed:report.passed,captures:report.captures,failure:report.failure??null,ownedSessionClosed:report.ownedSessionClosed??null}));
