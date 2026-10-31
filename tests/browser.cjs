const {chromium}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {spawn,execFileSync}=require('node:child_process');
const ROOT=path.resolve(__dirname,'..');
const ARTIFACTS=path.join(ROOT,'test-results');
fs.mkdirSync(ARTIFACTS,{recursive:true});
const results=[];
let server,helper;
function cleanup(){
 if(server)server.close();
 if(helper&&!helper.killed){
  if(process.platform==='win32'){try{execFileSync('taskkill',['/PID',String(helper.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}catch{}}
  else helper.kill();
 }
}
(async()=>{
server=http.createServer((req,res)=>{
 const name=new URL(req.url,'http://127.0.0.1').pathname;
 const file=path.join(ROOT,name==='/'?'index.html':name);
 if(!file.startsWith(ROOT+path.sep)){res.writeHead(403).end();return;}
 const type={'.html':'text/html','.js':'text/javascript','.css':'text/css'}[path.extname(file)]||'application/octet-stream';
 fs.readFile(file,(err,bytes)=>{res.writeHead(err?404:200,{'Content-Type':type});res.end(err?'Not found':bytes);});
});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(8765,'127.0.0.1',resolve);});
const helperCommand=process.env.HELPER_EXE||'python';
helper=spawn(helperCommand,[...(process.env.HELPER_EXE?[]:[path.join(ROOT,'helper','bench_helper.py')]),'--no-browser','--dev'],{windowsHide:true});
const token=await new Promise((resolve,reject)=>{
 let output='';const timer=setTimeout(()=>reject(new Error('Helper did not start')),15000);
 helper.stdout.on('data',bytes=>{output+=bytes;const match=output.match(/#helper=([A-Za-z0-9_-]{43})/);if(match){clearTimeout(timer);resolve(match[1]);}});
 helper.once('error',reject);helper.once('exit',code=>{clearTimeout(timer);reject(new Error('Helper exited: '+code));});
});
const browser=await chromium.launch({channel:'msedge',headless:true});
console.log('Testing Microsoft Edge '+browser.version());
async function scenario(name,fn,options={}){
 const context=await browser.newContext({viewport:{width:1440,height:900},permissions:['clipboard-read','clipboard-write','local-network-access']});
 context.setDefaultTimeout(8000);
 const page=await context.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
 if(!options.native) await page.addInitScript(({unsupported})=>{
 if(unsupported){delete Navigator.prototype.serial;return;}
 window.mock={writes:[],opens:[],mode:'ok'};
 class Port extends EventTarget{
  getInfo(){return {usbVendorId:0x403,usbProductId:0x6001};}
  async open(options){if(mock.mode==='busy')throw new DOMException('Failed to open serial port','NetworkError');mock.opens.push(options);this.readable=new ReadableStream({start:c=>mock.controller=c});this.writable=new WritableStream({write:bytes=>mock.writes.push(Array.from(bytes))});}
  async close(){mock.closed=true;}
 }
 mock.port=new Port(); const serial=new EventTarget();
 serial.getPorts=async()=>[mock.port];
 serial.requestPort=async()=>{if(mock.mode==='cancel')throw new DOMException('No port','NotFoundError');return mock.port;};
 Object.defineProperty(navigator,'serial',{value:serial,configurable:true});
 mock.rx=text=>mock.controller.enqueue(new TextEncoder().encode(text));
 },{unsupported:options.unsupported});
 try{await page.goto('http://127.0.0.1:8765/'+(options.query||'')); await page.waitForTimeout(300);await fn(page,context); assert.deepEqual(errors,[]);results.push({name,status:'PASS'});}
 catch(e){results.push({name,status:'FAIL',error:e.message});}
 console.log(results.at(-1).status+': '+name);
 await context.close();
}
const text=(p,id)=>p.locator('#'+id).textContent();
const connect=async p=>{await p.locator('#connectBtn').click();await p.waitForFunction(()=>document.querySelector('#disconnectBtn').disabled===false);};
const rx=async(p,s)=>{await p.evaluate(s=>mock.rx(s),s);await p.waitForTimeout(100);};
await scenario('Native Edge: initial load, sidebar, pause, latest, clear and responsive layout',async p=>{
 assert.equal(await text(p,'statusText'),'Not connected');assert.equal(await p.locator('#disconnectBtn').isDisabled(),true);
 await p.locator('#sidebarOpenBtn').click();assert.equal(await p.locator('#advancedSidebar').isVisible(),true);await p.locator('#sidebarCloseBtn').click();assert.equal(await p.locator('#advancedSidebar').isVisible(),false);
 await p.locator('#pauseBtn').click();assert.equal(await text(p,'pauseBtn'),'Resume');await p.locator('#pauseBtn').click();
 await p.locator('#latestOnly').check();assert.equal(await p.locator('#latestPanel').isVisible(),true);await p.locator('#latestOnly').uncheck();
 for(const width of [1920,1440,1024,980,768,390,320]){await p.setViewportSize({width,height:900});await p.waitForTimeout(50);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'overflow at '+width);await p.locator('#sidebarOpenBtn').click();assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'sidebar overflow at '+width);await p.locator('#sidebarCloseBtn').click();}
 await p.setViewportSize({width:1440,height:900});await p.screenshot({path:path.join(ARTIFACTS,'serial-desktop.png'),fullPage:true});
 await p.locator('#clearBtn').click();assert.equal(await text(p,'output'),'');assert.equal(await text(p,'byteCount'),'0 bytes');
},{native:true});
await scenario('URL settings, connection, expected signal, send endings and disconnect',async p=>{
 assert.equal(await p.locator('#baudRate').inputValue(),'9600');assert.equal(await p.locator('#expectText').inputValue(),'OK');await connect(p);
 assert.equal(await text(p,'statusText'),'Connected — waiting');assert.equal(await p.evaluate(()=>mock.opens[0].baudRate),9600);
 await rx(p,'hello\n');assert.equal(await text(p,'statusText'),'Responding');await rx(p,'all o');await rx(p,'k\n');assert.equal(await text(p,'resultLabel'),'Device working');
 await p.locator('#sidebarOpenBtn').click();for(const [ending,suffix] of [['nl','\n'],['cr','\r'],['crlf','\r\n'],['none','']]){await p.locator('#lineEnding').selectOption(ending);await p.locator('#sendInput').fill('PING');await p.locator('#sendInput').press('Enter');await p.waitForTimeout(30);assert.equal(await p.evaluate(()=>new TextDecoder().decode(new Uint8Array(mock.writes.at(-1)))),'PING'+suffix);}
 await p.locator('#disconnectBtn').click();await p.waitForFunction(()=>document.querySelector('#statusText').textContent==='Not connected');assert.equal(await p.evaluate(()=>mock.closed),true);
},{query:'?baud=9600&expect=OK'});
await scenario('Pause retains report data; latest reading and log export',async p=>{
 await connect(p);await rx(p,'first\n');await p.locator('#pauseBtn').click();await rx(p,'hidden-reading\n');assert.equal((await text(p,'output')).includes('hidden-reading'),false);
 await p.locator('#copyReportBtn').click();assert.equal((await p.evaluate(()=>navigator.clipboard.readText())).includes('hidden-reading'),true);
 await p.locator('#pauseBtn').click();await p.locator('#latestOnly').check();await rx(p,'42.5\n');assert.equal(await text(p,'latestValue'),'42.5');await p.locator('#pauseBtn').click();await rx(p,'43.5\n');assert.equal(await text(p,'latestValue'),'42.5');
 await p.locator('#sidebarOpenBtn').click();const dlPromise=p.waitForEvent('download');await p.locator('#exportBtn').click();const dl=await dlPromise;assert.match(fs.readFileSync(await dl.path(),'utf8'),/43\.5/);
});
await scenario('No-data warning after eight seconds',async p=>{await connect(p);await p.waitForFunction(()=>document.querySelector('#resultCard').dataset.result==='nodata',null,{timeout:10000});});
await scenario('Picker cancel and busy-port guidance',async p=>{await p.evaluate(()=>mock.mode='cancel');await p.locator('#connectBtn').click();assert.equal(await text(p,'resultLabel'),'No device selected');await p.evaluate(()=>mock.mode='busy');await p.locator('#connectBtn').click();await p.waitForTimeout(100);assert.equal(await text(p,'resultLabel'),'Device is busy in another program');});
await scenario('Unsupported browser guidance',async p=>{assert.equal(await p.locator('#connectBtn').isDisabled(),true);assert.equal(await p.locator('#compatHint').isVisible(),true);},{unsupported:true});
await scenario('Device unplug and automatic reconnect',async p=>{await connect(p);await p.evaluate(()=>mock.port.dispatchEvent(new Event('disconnect')));await p.waitForFunction(()=>mock.opens.length===2);assert.equal(await p.locator('#disconnectBtn').isDisabled(),false);});
await scenario('Burst input bounded DOM and complete report ring buffer',async p=>{await connect(p);await rx(p,Array.from({length:3500},(_,i)=>'value-'+i).join('\n')+'\n');assert.equal(await p.locator('#output > div').count(),500);await p.locator('#copyReportBtn').click();const report=await p.evaluate(()=>navigator.clipboard.readText());assert.match(report,/value-3499/);assert.equal(report.includes('value-0\n'),false);});
await scenario('Text without newline is recognized as received data',async p=>{await connect(p);await rx(p,'OK');assert.equal(await text(p,'statusText'),'Responding');});
await scenario('Hex view still matches expected text',async p=>{await connect(p);await p.locator('#sidebarOpenBtn').click();await p.locator('#hexMode').check();await rx(p,'OK\n');assert.equal(await text(p,'resultLabel'),'Device working');},{query:'?expect=OK'});
await scenario('Fatal stream error updates connection health',async p=>{await connect(p);await rx(p,'good\n');await p.evaluate(()=>mock.controller.error(new Error('Device read failed')));await p.waitForTimeout(100);assert.equal(await p.locator('#resultCard').getAttribute('data-result'),'error');});
await scenario('Expected text change synchronizes header status',async p=>{await connect(p);await rx(p,'OK\n');await p.locator('#sidebarOpenBtn').click();await p.locator('#expectText').fill('NEW');await p.locator('#expectText').dispatchEvent('change');assert.equal(await text(p,'statusText'),'Responding');},{query:'?expect=OK'});
await scenario('Screenshot button creates clipboard PNG or downloads PNG',async p=>{let download; p.on('download',d=>download=d);await p.locator('#screenshotBtn').click();await p.waitForFunction(()=>document.querySelector('#screenshotBtn').dataset.busy==='0',null,{timeout:35000});const output=await text(p,'output');assert.match(output,/Screenshot copied|PNG downloaded instead/);if(download)assert.ok(fs.statSync(await download.path()).size>1000);},{native:true});
await scenario('Newline-free data renders and expected text matches across idle flushes',async p=>{
 await connect(p);await rx(p,'O');await p.waitForTimeout(150);await rx(p,'K');await p.waitForTimeout(150);assert.match(await text(p,'output'),/O/);assert.equal(await text(p,'resultLabel'),'Device working');
},{query:'?expect=OK'});
await scenario('Unexpected end of stream shows error, blocks send and allows disconnect',async p=>{
 await connect(p);await p.evaluate(()=>mock.controller.close());await p.waitForTimeout(100);assert.equal(await text(p,'statusText'),'Read failed');assert.equal(await p.locator('#sendBtn').isDisabled(),true);await p.locator('#disconnectBtn').click();await p.waitForFunction(()=>document.querySelector('#statusText').textContent==='Not connected');
});
await scenario('Serial reader acquisition failure shows a recoverable error',async p=>{
 await p.evaluate(()=>{const original=mock.port.open.bind(mock.port);mock.port.open=async options=>{await original(options);mock.port.readable={getReader(){throw new Error('Reader unavailable');}};};});
 await connect(p);await p.waitForFunction(()=>document.querySelector('#statusText').textContent==='Read failed');assert.equal(await p.locator('#sendBtn').isDisabled(),true);
});
await scenario('Ping page detects unpaired helper and prevents starting',async p=>{
 await p.waitForFunction(()=>document.querySelector('#helperStatus').textContent==='Helper found — pairing needed');assert.equal(await p.locator('#startBtn').isDisabled(),true);
},{native:true,query:'ping.html'});
await scenario('Pairing link updates an already open tab without a reload',async p=>{
 await p.waitForFunction(()=>document.querySelector('#helperStatus').textContent==='Helper found — pairing needed');
 await p.evaluate(key=>location.hash='helper='+key,token);
 await p.waitForFunction(()=>!document.querySelector('#startBtn').disabled);
 assert.equal(await p.evaluate(()=>location.hash),'');
},{native:true,query:'ping.html'});
await scenario('Setup instructions provide installer and explicit launch link',async p=>{
 await p.route('http://127.0.0.1:47831/health',r=>r.abort());await p.locator('#checkHelperBtn').click();
 await p.waitForFunction(()=>document.querySelector('#helperStatus').textContent==='Helper unavailable');
 assert.match(await p.locator('.download-helper').getAttribute('href'),/helper-v1\.1\.0\/HardwareCheckSetup\.exe$/);
 assert.equal(await p.locator('.helper-launch').getAttribute('href'),'hardwarecheck-helper://open');
},{native:true,query:'ping.html'});
await scenario('Opening a new tab reconnects using remembered pairing',async(p,context)=>{
 await p.waitForFunction(()=>!document.querySelector('#startBtn').disabled);
 const next=await context.newPage();await next.goto('http://127.0.0.1:8765/ping.html');
 await next.waitForFunction(()=>!document.querySelector('#startBtn').disabled);await next.close();
},{native:true,query:'ping.html#helper='+token});
await scenario('Ping page pairs with actual helper, validates IP, sends real ICMP, stops and restarts',async p=>{
 await p.waitForFunction(()=>!document.querySelector('#startBtn').disabled);assert.equal(await p.evaluate(()=>location.hash),'');
 for(const invalid of ['8.8.8.8','999.1.1.1','localhost','192.168.01.1']){await p.locator('#ipAddress').fill(invalid);await p.locator('#startBtn').click();assert.equal(await p.locator('#ipError').isVisible(),true);}
 await p.locator('#ipAddress').fill('127.0.0.1');await p.locator('#startBtn').click();await p.waitForFunction(()=>Number(document.querySelector('#received').textContent)>=3);assert.equal(await text(p,'lost'),'0');assert.equal(await text(p,'loss'),'0.0%');assert.notEqual(await text(p,'minMs'),'—');
 await p.locator('#stopBtn').click();await p.waitForFunction(()=>document.querySelector('#testStatus').textContent==='Test stopped');const sent=await text(p,'sent');await p.waitForTimeout(1200);assert.equal(await text(p,'sent'),sent);
 await p.screenshot({path:path.join(ARTIFACTS,'ping-desktop.png'),fullPage:true});
 for(const width of [1920,1024,900,768,390,320]){await p.setViewportSize({width,height:900});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'ping overflow at '+width);}
 await p.setViewportSize({width:390,height:844});await p.screenshot({path:path.join(ARTIFACTS,'ping-mobile.png'),fullPage:true});
 await p.locator('#startBtn').click();await p.waitForFunction(()=>Number(document.querySelector('#received').textContent)>=1);await p.locator('#stopBtn').click();await p.waitForFunction(()=>document.querySelector('#testStatus').textContent==='Test stopped');assert.ok(Number(await text(p,'sent'))<Number(sent));
 await p.reload();await p.waitForFunction(()=>!document.querySelector('#startBtn').disabled);
},{native:true,query:'ping.html#helper='+token});
await scenario('Ping statistics handle mixed replies, timeouts, stop during flight, and helper errors',async p=>{
 await p.waitForFunction(()=>!document.querySelector('#startBtn').disabled);let n=0;
 await p.route('http://127.0.0.1:47831/ping',async route=>{n++;const body=n===2?{ip:'192.168.1.20',ok:false,ms:null,message:'Request timed out'}:{ip:'192.168.1.20',ok:true,ms:n===1?10:30};await route.fulfill({json:body});});
 await p.locator('#ipAddress').fill('192.168.1.20');await p.locator('#startBtn').click();await p.waitForFunction(()=>document.querySelector('#sent').textContent==='3');await p.locator('#stopBtn').click();await p.waitForFunction(()=>document.querySelector('#testStatus').textContent==='Test stopped');assert.equal(await text(p,'received'),'2');assert.equal(await text(p,'lost'),'1');assert.equal(await text(p,'loss'),'33.3%');assert.equal(await text(p,'minMs'),'10 ms');assert.equal(await text(p,'avgMs'),'20.0 ms');assert.equal(await text(p,'maxMs'),'30 ms');
 await p.unroute('http://127.0.0.1:47831/ping');await p.route('http://127.0.0.1:47831/ping',async route=>{await new Promise(r=>setTimeout(r,400));await route.fulfill({json:{ip:'192.168.1.20',ok:true,ms:12}});});
 await p.locator('#startBtn').click();await p.waitForTimeout(100);await p.locator('#stopBtn').click();await p.waitForFunction(()=>document.querySelector('#testStatus').textContent==='Test stopped');assert.equal(await text(p,'sent'),'1');
 await p.unroute('http://127.0.0.1:47831/ping');await p.route('http://127.0.0.1:47831/ping',route=>route.abort());await p.locator('#startBtn').click();await p.waitForFunction(()=>document.querySelector('#testStatus').textContent==='Test interrupted');assert.equal(await p.locator('#startBtn').isDisabled(),true);
},{native:true,query:'ping.html#helper='+token});
await scenario('HTTPS website can reach actual loopback helper with browser permission',async(p,context)=>{
 await p.route('https://rijas99.github.io/serial-bench/**',async route=>{const name=new URL(route.request().url()).pathname.split('/').pop();const file=path.join(ROOT,name||'index.html');await route.fulfill({path:file});});
 await p.goto('https://rijas99.github.io/serial-bench/ping.html#helper='+token);await p.waitForFunction(()=>!document.querySelector('#startBtn').disabled);await p.locator('#ipAddress').fill('127.0.0.1');await p.locator('#startBtn').click();await p.waitForFunction(()=>Number(document.querySelector('#received').textContent)>=1);await p.locator('#stopBtn').click();await p.waitForFunction(()=>document.querySelector('#testStatus').textContent==='Test stopped');
},{native:true,query:'ping.html'});
await scenario('Ping page tolerates rate limiting after a quick restart',async p=>{
 await p.waitForFunction(()=>!document.querySelector('#startBtn').disabled);let n=0;
 await p.route('http://127.0.0.1:47831/ping',async route=>{n++;await route.fulfill(n===1?{status:429,json:{error:'A ping is already running'}}:{json:{ip:'127.0.0.1',ok:true,ms:0}});});
 await p.locator('#ipAddress').fill('127.0.0.1');await p.locator('#startBtn').click();await p.waitForFunction(()=>document.querySelector('#received').textContent==='1');await p.locator('#stopBtn').click();await p.waitForFunction(()=>document.querySelector('#testStatus').textContent==='Test stopped');assert.equal(await text(p,'sent'),'1');
},{native:true,query:'ping.html#helper='+token});
await browser.close();fs.writeFileSync(path.join(ARTIFACTS,'results.json'),JSON.stringify(results,null,2));
console.log(`${results.filter(r=>r.status==='PASS').length}/${results.length} browser checks passed`);
if(results.some(r=>r.status==='FAIL')){console.log(JSON.stringify(results.filter(r=>r.status==='FAIL'),null,2));process.exitCode=1;}
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(cleanup);
