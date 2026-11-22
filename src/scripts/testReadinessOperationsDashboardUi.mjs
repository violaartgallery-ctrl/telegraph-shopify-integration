// Synthetic DOM/VM + AST only. No app imports, configuration, DB, server, or network.
// If this source-only freeze has no dependencies, run from an existing checkout
// whose read-only node_modules already contains TypeScript. Never install for QA.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';

let ts;
try { ts = createRequire(import.meta.url)('typescript'); }
catch { ts = createRequire(resolve(process.cwd(), 'package.json'))('typescript'); }
let checks = 0;
const check = (value, message) => { assert.ok(value, message); checks++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };
const source = readFileSync(new URL('../ui/operationsDashboard.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('operationsDashboard.ts', source, ts.ScriptTarget.ES2022, true);
check(ast.parseDiagnostics.length === 0, 'UI TypeScript parses');
const exportsFound = ast.statements.filter(ts.isFunctionDeclaration).map((node) => node.name?.text);
equal(exportsFound, ['renderOperationsDashboard', 'renderOperationsDashboardScript'], 'Exactly two render exports');
for (const node of ast.statements) {
  check(ts.isFunctionDeclaration(node), 'UI has no imports or module-level operational work');
  check(node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword), 'Both functions exported');
  equal(node.type?.getText(ast), 'string', 'Public renderer return type is string');
}
const moduleBox = { exports:{} };
vm.runInNewContext(ts.transpileModule(source, {
  compilerOptions:{ module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022 }
}).outputText, { module:moduleBox, exports:moduleBox.exports }, { timeout:1000 });
const panel = moduleBox.exports.renderOperationsDashboard();
const script = moduleBox.exports.renderOperationsDashboardScript();
check(panel.includes('dir="rtl"') && panel.includes('lang="ar"'), 'Arabic RTL fragment');
check(!/<script\b/i.test(panel) && !/<\/?script\b/i.test(script), 'Fragments contain no script wrapper');
equal((panel.match(/<button\b/g) || []).length, 1, 'Only manual snapshot-refresh button');
check(panel.includes('id="ops-refresh" type="button"'), 'Refresh cannot submit a form');
check(!/<(?:form|input|iframe|img)\b|\son\w+=|https?:\/\//i.test(panel), 'No actions, external assets or inline listeners');
for (const notice of ['ليس ترتيبًا عامًا', 'ليس', 'حجزًا', 'الموقوفة لا تعطل العمل الجديد المستقل', 'كامل الأعمال المتراكمة', 'مصدر ناقص', 'تحميل واحد', '٨ حالات لكل مسار']) {
  check(panel.includes(notice), 'Safety/availability notice: ' + notice);
}
check(panel.includes('repeat(auto-fit') && panel.includes('@media(max-width:600px)'), 'Responsive card layout');
check(panel.includes('overflow-x:auto') && panel.includes(':focus-visible'), 'Narrow-screen tables and keyboard focus');
check(panel.includes('role="alert"') && panel.includes('aria-live="polite"'), 'Accessible availability updates');

const scriptAst = ts.createSourceFile('dashboard.js', script, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
check(scriptAst.parseDiagnostics.length === 0, 'Actual returned JS parses');
new vm.Script(script);
const calls = [];
const properties = [];
const identifiers = [];
function walk(node) {
  if (ts.isCallExpression(node)) calls.push(node);
  if (ts.isPropertyAccessExpression(node)) properties.push(node.name.text);
  if (ts.isIdentifier(node)) identifiers.push(node.text);
  ts.forEachChild(node, walk);
}
walk(scriptAst);
const namedCalls = (name) => calls.filter((c) => c.expression.getText(scriptAst) === name);
equal(namedCalls('fetch').length, 1, 'Exactly one fetch call site');
check(namedCalls('fetch')[0].arguments[0].getText(scriptAst) === "adminUrl('/api/operations/dashboard')", 'Only fixed authenticated snapshot endpoint');
equal(namedCalls('loadSnapshot').length, 1, 'Exactly one automatic initial load');
equal(namedCalls('setTimeout').length, 1, 'Only one timeout call site');
equal(namedCalls('clearTimeout').length, 1, 'Request deadline cleaned up');
equal(calls.filter((c) => ts.isPropertyAccessExpression(c.expression) && c.expression.name.text === 'addEventListener').length, 1, 'Only manual refresh listener');
for (const forbidden of ['setInterval','requestAnimationFrame','XMLHttpRequest','WebSocket','EventSource','localStorage','sessionStorage','require','process','eval','Function','location.assign','location.replace']) {
  check(!identifiers.includes(forbidden) && !namedCalls(forbidden).length, 'No automatic/external/privileged API: ' + forbidden);
}
for (const forbidden of ['innerHTML','outerHTML','insertAdjacentHTML','sendBeacon','cookie']) check(!properties.includes(forbidden), 'No unsafe HTML/egress sink: ' + forbidden);
const fetchOptions = namedCalls('fetch')[0].arguments[1].getText(scriptAst);
check(fetchOptions.includes("method:'GET'") && fetchOptions.includes('headers:adminHeaders'), 'GET only with existing authentication');
check(fetchOptions.includes("redirect:'error'") && fetchOptions.includes("cache:'no-store'"), 'No redirected auth or stale HTTP cache');
check(fetchOptions.includes('signal:controller.signal'), 'AbortController signal bound to fetch');
check(script.includes("timeZone:'Africa/Cairo'"), 'Explicit Cairo timezone');

class Element {
  constructor(tag, id = '') {
    this.tag = tag; this.id = id; this.childNodes = []; this.dataset = {};
    this.attributes = {}; this.listeners = new Map(); this.hidden = false;
    this.disabled = false; this._text = ''; this.className = '';
  }
  set textContent(value) { this._text = String(value); this.childNodes = []; }
  get textContent() { return this._text + this.childNodes.map((node) => node.textContent).join(' '); }
  set innerHTML(_) { throw new Error('HTML sink forbidden'); }
  append(...nodes) {
    for (const node of nodes) {
      assert.ok(node instanceof Element, 'Only DOM elements may be appended');
      this.childNodes.push(node);
    }
  }
  replaceChildren(...nodes) { this._text = ''; this.childNodes = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  addEventListener(type, listener) {
    assert.equal(type, 'click', 'Only explicit refresh clicks');
    this.listeners.set(type, [...(this.listeners.get(type) || []), listener]);
  }
  click() { if (!this.disabled) for (const listener of this.listeners.get('click') || []) void listener(); }
}
const NOW = Date.parse('2026-11-02T16:00:00Z');
class FrozenDate extends Date { static now() { return NOW; } }
const origin = 'https://synthetic-viola.invalid';
const dummyHeaders = Object.freeze({ 'x-admin-secret':'SYNTHETIC-NOT-A-CREDENTIAL' });
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const response = (payload, ok = true) => ({ ok, async json() { return payload; } });
const descendants = (node, tag) => [node, ...node.childNodes.flatMap((child) => descendants(child))].filter((item) => !tag || item.tag === tag);
const textOf = (h, id) => h.elements.get('ops-' + id).textContent;
function harness(plans = [], { missingRoot = false, abortAvailable = true } = {}) {
  const elements = new Map();
  const root = new Element('section', 'operations-dashboard');
  for (const [, id] of panel.matchAll(/\bid="([^"]+)"/g)) {
    if (id === 'operations-dashboard') continue;
    const node = new Element(id === 'ops-refresh' ? 'button' : 'div', id);
    node.textContent = 'غير متاح';
    elements.set(id, node); root.append(node);
  }
  elements.get('ops-unavailable').hidden = true;
  elements.get('ops-partial').hidden = true;
  if (!missingRoot) elements.set('operations-dashboard', root);
  const requests = [], timers = new Map(), allNodes = [];
  let timerId = 0, aborted = 0;
  class Abort extends AbortController { abort() { aborted++; super.abort(); } }
  const context = vm.createContext({
    document:{
      getElementById(id) { return elements.get(id) || null; },
      createElement(tag) {
        assert.ok(['span','time','div','article','h4','dl','dt','dd','p','ul','li','table','caption','thead','tr','th','tbody','td','a'].includes(tag), 'Only safe display DOM tags');
        const node = new Element(tag); allNodes.push(node); return node;
      }
    },
    window:{ location:{ origin } }, URL, Intl, Date:FrozenDate,
    AbortController:abortAvailable ? Abort : undefined,
    html() { throw new Error('No dynamic HTML rendering needed'); },
    adminHeaders:dummyHeaders,
    adminUrl(path) {
      assert.ok(path.startsWith('/') && !path.startsWith('//'), 'Only local paths get synthetic auth');
      return path + (path.includes('?') ? '&' : '?') + 'adminToken=SYNTHETIC-NOT-A-CREDENTIAL';
    },
    fetch(url, options) {
      assert.equal(url, '/api/operations/dashboard?adminToken=SYNTHETIC-NOT-A-CREDENTIAL');
      assert.equal(options.method, 'GET'); assert.equal(options.headers, dummyHeaders);
      assert.equal(options.credentials, 'same-origin'); assert.equal(options.redirect, 'error');
      assert.equal(options.cache, 'no-store'); assert.ok(options.signal instanceof AbortSignal);
      requests.push({url, options});
      assert.ok(plans.length, 'Unexpected automatic fetch or retry');
      return plans.shift()();
    },
    setTimeout(fn, delay) { assert.equal(delay, 12000, 'Only request timeout permitted'); const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    setInterval() { throw new Error('Polling forbidden'); },
    console:{ log() { throw new Error('No data logging'); }, error() { throw new Error('No diagnostics logging'); } }
  });
  const run = () => vm.runInContext(script, context, {timeout:1000});
  run();
  return {
    root, elements, requests, timers, allNodes, plans, run,
    get aborted() { return aborted; },
    refresh() { elements.get('ops-refresh').click(); },
    expire() { for (const fn of [...timers.values()]) fn(); }
  };
}
function fixture() {
  const generatedAt = new Date(NOW - 10000).toISOString();
  return {
    ok:true, generatedAt, cacheTtlSeconds:60, controller:{active:true, reason:'verified synthetic controller'},
    scheduler:['status','discovery','financial'].map((lane) => ({
      lane, label:lane, enabled:true, state:'scheduled', nextAt:NOW + 30000,
      lastSuccessAt:Math.floor((NOW - 60000) / 1000), lastStartedAt:'2026-11-02T15:58:00Z',
      lastError:null, leaseUntil:null
    })),
    queues:[{lane:'production',label:'إنتاج تجريبي',pending:4,retryable:2,processing:1,review:3,held:84,eligibleNow:2,waitingDependency:6,completedExcluded:440}],
    nextCandidates:[
      {rank:2,lane:'production',label:'إنتاج',orderId:'102',orderName:'#P2',shipmentCode:'VI000102',stage:'stock',reason:'ثاني الإنتاج',notBefore:NOW,orderUrl:'https://admin.shopify.com/store/viola/orders/102',reviewUrl:'/orders/make-telegraph?id=gid%3A%2F%2Fshopify%2FOrder%2F102'},
      {rank:1,lane:'collection',label:'تحصيل',orderId:'201',orderName:'#C1',shipmentCode:'VI000201',stage:'collect',reason:'أول التحصيل',notBefore:null},
      {rank:1,lane:'production',label:'إنتاج',orderId:'101',orderName:'#P1',shipmentCode:'VI000101',stage:'sale',reason:'أول الإنتاج',notBefore:null,orderUrl:origin + '/orders?id=101'}
    ],
    activeClaims:[{lane:'production',orderName:'#CLAIM',shipmentCode:'VI000300',stage:'stock',status:'processing',startedAt:NOW - 1000}],
    reviewCases:[
      {caseId:'D1',orderId:'401',orderName:'#DEPENDENCY',shipmentCode:'VI000401',reason:'متطلب سابق',requiredAction:'انتظار اكتمال المتطلب',classification:'dependency'},
      {caseId:'U1',orderId:'402',orderName:'#UNCERTAIN',shipmentCode:'VI000402',reason:'نتيجة غير معروفة',requiredAction:'تحقق مستقل',classification:'uncertain-claim'},
      {caseId:'H1',orderId:'403',orderName:'#HISTORICAL',shipmentCode:'VI000403',reason:'قرار محفوظ',requiredAction:'قرار مستقل من المالك',classification:'durable-hold'},
      {caseId:'R1',orderId:'404',orderName:'#REVIEW',shipmentCode:'VI000404',reason:'يحتاج توضيحًا',requiredAction:'مراجعة بشرية',classification:'needs-review'}
    ],
    reviewTotal:4, truncatedReview:false, holdsTotal:84, notes:['بيانات اختبار اصطناعية فقط']
  };
}
const okPlan = (payload) => () => Promise.resolve(response(payload));
const h = harness([okPlan(fixture())]);
equal(h.requests.length, 1, 'Initial fetch happens exactly once');
check(h.elements.get('ops-refresh').disabled, 'Manual double click fenced while loading');
h.refresh(); h.run();
equal(h.requests.length, 1, 'Busy click and duplicate script do not duplicate initial fetch');
await flush();
equal(h.timers.size, 0, 'Successful request clears sole timeout');
check(!h.elements.get('ops-refresh').disabled && h.root.attributes['aria-busy'] === 'false', 'Loading state released');
check(h.elements.get('ops-unavailable').hidden && h.elements.get('ops-partial').hidden, 'Complete snapshot available');
equal(descendants(h.elements.get('ops-scheduler'), 'article').length, 3, 'Three scheduler lane cards');
for (const label of ['الموعد القادم','آخر نجاح','آخر بداية','آخر خطأ','انتهاء المهلة الحصرية']) check(textOf(h,'scheduler').includes(label), 'Scheduler detail: ' + label);
for (const label of ['في الانتظار','قابل لإعادة المحاولة','قيد المعالجة','للمراجعة','موقوف','مؤهل الآن','بانتظار متطلب سابق','مكتمل / مستبعد']) check(textOf(h,'queues').includes(label), 'Queue detail: ' + label);
check(textOf(h,'queues').includes('ليس تراكمًا قابلًا للتنفيذ'), 'Held count never called executable backlog');
check(textOf(h,'freshness').includes('عند العرض فقط'), 'Freshness is a snapshot observation');
check(textOf(h,'generated').includes('القاهرة'), 'Cairo timestamp label');
const times = descendants(h.elements.get('ops-scheduler'), 'time');
check(times.some((t) => t.dateTime === '2026-11-02T16:00:30.000Z'), 'Milliseconds accepted');
check(times.some((t) => t.dateTime === '2026-11-02T15:59:00.000Z'), 'Unix seconds accepted');
check(times.some((t) => t.dateTime === '2026-11-02T15:58:00.000Z'), 'ISO timestamps accepted');
const expectedCairo = new Intl.DateTimeFormat('ar-EG',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(NOW - 10000));
check(textOf(h,'generated').includes(expectedCairo), 'Actual formatted value uses Cairo timezone');
const candidateTables = descendants(h.elements.get('ops-candidates'), 'table');
equal(candidateTables.length, 2, 'Candidates grouped by lane, never global rank');
check(candidateTables[0].textContent.indexOf('#P1') < candidateTables[0].textContent.indexOf('#P2'), 'Rank sorted within production lane');
check(!candidateTables[0].textContent.includes('#C1') && candidateTables[1].textContent.includes('#C1'), 'Independent rank 1 remains in independent lane');
check(textOf(h,'claims').includes('#CLAIM') && textOf(h,'claims').includes('processing'), 'Active claims shown independently');
for (const name of ['#DEPENDENCY','#UNCERTAIN','#REVIEW']) check(textOf(h,'reviews').includes(name), 'Review classification retained: ' + name);
check(!textOf(h,'reviews').includes('#HISTORICAL') && textOf(h,'held').includes('#HISTORICAL'), 'Durable holds partitioned away from ordinary review');
check(textOf(h,'held').includes('ليس تراكمًا قابلًا للتنفيذ'), 'Historical classification is explicitly non-executable');
check(textOf(h,'reviews').includes('يلزم تحقق مستقل'), 'Unknown claim outcome never implied retryable');
const anchors = descendants(h.elements.get('ops-candidates'), 'a');
equal(anchors.length, 3, 'Approved order and read-only review links shown');
for (const anchor of anchors) {
  equal(anchor.rel, 'noopener noreferrer', 'Links isolated from opener');
  equal(anchor.referrerPolicy, 'no-referrer', 'No auth referrer leakage');
  equal(anchor.target, '_blank', 'Display links do not replace current snapshot');
  if (anchor.href.startsWith('https://admin.shopify.com')) check(!anchor.href.includes('adminToken'), 'No local auth forwarded to Shopify');
  else check(anchor.href.startsWith('/orders') && anchor.href.includes('adminToken=SYNTHETIC'), 'Local display link uses existing adminUrl');
}
await flush();
equal(h.requests.length, 1, 'No polling after success');

// Failure keeps the successful DOM and never prints raw error bodies/messages.
const beforeCandidates = h.elements.get('ops-candidates').childNodes[0];
h.plans.push(() => Promise.resolve({ok:false,json() { throw new Error('Failure body must not be read'); }}));
h.refresh(); await flush();
equal(h.requests.length, 2, 'Only explicit manual click fetches again');
equal(h.elements.get('ops-candidates').childNodes[0], beforeCandidates, '503 keeps exact last successful candidate DOM');
check(!h.elements.get('ops-unavailable').hidden && textOf(h,'unavailable').includes('آخر لقطة ناجحة'), 'Explicit unavailable/stale notice');
check(textOf(h,'freshness').includes('تعذر التأكد'), 'Previous freshness never remains falsely current after failure');
equal(h.timers.size, 0, 'HTTP failure clears timeout');
await flush(); equal(h.requests.length, 2, 'No automatic retry on HTTP failure');
h.plans.push(okPlan({...fixture(),notes:['تحديث يدوي جديد']})); h.refresh(); await flush();
check(h.elements.get('ops-unavailable').hidden && textOf(h,'notes').includes('تحديث يدوي جديد'), 'Manual recovery replaces stale snapshot');

for (const bad of [null,[],{}, {ok:false}, {ok:'true'}]) {
  const f = harness([okPlan(bad)]); await flush();
  check(!f.elements.get('ops-unavailable').hidden && textOf(f,'unavailable').includes('لم تُحمّل أي لقطة ناجحة'), 'Invalid envelope never appears healthy');
  equal(f.requests.length, 1, 'Invalid envelope not retried'); equal(f.timers.size,0,'Invalid envelope clears deadline');
}
for (const plan of [() => Promise.reject(new Error('postgres://synthetic:synthetic@db.invalid/db')), () => Promise.resolve({ok:true,json:async () => {throw new Error('raw synthetic body');}})]) {
  const f = harness([plan]); await flush();
  check(!f.elements.get('ops-unavailable').hidden, 'Network/JSON failure reported');
  check(!f.root.textContent.includes('postgres:') && !f.root.textContent.includes('raw synthetic body'), 'No error diagnostics leak');
  equal(f.requests.length,1,'Network/JSON failure never automatically retried');
}
const partial = harness([okPlan({ok:true})]); await flush();
check(!partial.elements.get('ops-partial').hidden, 'Missing sources explicitly partial');
for (const id of ['queues','candidates','claims','reviews','held']) check(textOf(partial,id).includes('غير متاح') || textOf(partial,id).includes('غير متاحة'), 'Missing ' + id + ' is unknown, not zero');
check(textOf(partial,'controller').includes('غير متاح'), 'Missing controller not active');
equal(descendants(partial.elements.get('ops-scheduler'),'article').length,3,'Missing scheduler retains three unknown cards');
check(!textOf(partial,'queues').includes('٠'), 'Missing queue counts never rendered zero');

const emptyData = fixture();
Object.assign(emptyData,{queues:[],nextCandidates:[],activeClaims:[],reviewCases:[],reviewTotal:0,holdsTotal:0,notes:[]});
const empty = harness([okPlan(emptyData)]); await flush();
check(textOf(empty,'candidates').includes('لا توجد صفوف في هذه اللقطة فقط'), 'Known empty candidates distinct from missing');
check(textOf(empty,'queues').includes('لا تُفترض أصفار'), 'Empty queue list does not invent absent lane metrics');
check(textOf(empty,'review-total').includes('٠'), 'Explicit known zero is preserved');
check(textOf(empty,'notes').includes('لا توجد ملاحظات'), 'Known empty notes handled');

for (const invalid of [undefined,null,-1,0.5,Infinity,NaN,Number.MAX_SAFE_INTEGER+1,'0',{},[]]) {
  const data = fixture(); data.queues[0].pending = invalid;
  const f = harness([okPlan(data)]); await flush();
  const metrics = descendants(f.elements.get('ops-queues'),'dd');
  equal(metrics[0].textContent,'غير متاح','Invalid count cannot become healthy zero: ' + String(invalid));
  check(!f.elements.get('ops-partial').hidden,'Invalid count marks snapshot partial');
}
for (const [generatedAt,ttl,expected] of [[NOW-61000,60,'قديمة'],[NOW+60000,60,'في المستقبل'],[null,60,'غير معروفة'],['bad-time',60,'غير معروفة'],[NOW,'60','غير معروفة'],[NOW,0,'غير معروفة']]) {
  const f = harness([okPlan({...fixture(),generatedAt,cacheTtlSeconds:ttl})]); await flush();
  check(textOf(f,'freshness').includes(expected),'Freshness validation: ' + String(generatedAt) + '/' + ttl);
}

// DOM textContent handles every provider scalar. Unknown extra payload fields are ignored.
const attack = '<img src=x onerror=alert(1)><script>synthetic</script> & "quoted"';
const hostile = fixture();
hostile.controller.reason = attack;
Object.assign(hostile.scheduler[0],{label:attack,state:attack,lastError:attack});
hostile.queues[0].label = attack;
Object.assign(hostile.nextCandidates[0],{label:attack,orderName:attack,shipmentCode:attack,stage:attack,reason:attack});
Object.assign(hostile.activeClaims[0],{lane:attack,orderName:attack,shipmentCode:attack,stage:attack,status:attack});
Object.assign(hostile.reviewCases[0],{caseId:attack,orderName:attack,shipmentCode:attack,reason:attack,requiredAction:attack,classification:attack});
hostile.notes = [attack]; hostile.rawPayload = {private:'MUST-NOT-RENDER'}; hostile.credentials = 'MUST-NOT-RENDER';
const xss = harness([okPlan(hostile)]); await flush();
for (const id of ['controller','scheduler','queues','candidates','claims','reviews','notes']) check(textOf(xss,id).includes(attack),'Provider string handled as literal text: ' + id);
check(!xss.allNodes.some((node) => ['script','img'].includes(node.tag)), 'No executable DOM created from data');
check(!xss.root.textContent.includes('MUST-NOT-RENDER'), 'No generic payload/credential dumps');
for (const secret of ['postgresql://synthetic:secret@db.invalid/db','password=synthetic','Authorization: Bearer synthetic','token:synthetic','api_key=synthetic','{"rawPayload":"synthetic"}','["synthetic","raw"]','-----BEGIN PRIVATE KEY-----']) {
  const data = fixture(); data.notes = [secret]; data.scheduler[0].lastError = secret;
  const f = harness([okPlan(data)]); await flush();
  check(!f.root.textContent.includes(secret),'Sensitive/DSN/raw text suppressed');
  check(textOf(f,'notes').includes('محجوبة'),'Redaction stated explicitly');
}

const rejectedUrls = [
  'javascript:alert(1)','data:text/html,synthetic','http://admin.shopify.com/store/viola/orders/1',
  'https://admin.shopify.com.evil.invalid/store/viola/orders/1','https://evil.invalid/orders',
  'https://synthetic:synthetic@admin.shopify.com/store/viola/orders/1','https://admin.shopify.com:444/store/viola/orders/1',
  'https://admin.shopify.com/store/viola/orders/1?token=synthetic','https://admin.shopify.com/store/viola/orders/1#fragment',
  '/api/orders/create-shipment','/ops/scheduler/run','/orders/execute','/orders/make-odoo','/orders/bulk',
  '/orders?next=https://evil.invalid','/orders?adminToken=synthetic','/orders?id=1&id=2',
  '/orders?id=javascript:synthetic','/orders#execute','//evil.invalid/orders','/\\evil.invalid/orders',' /orders','/orders\n',
  {},null,1,'orders'
];
for (const url of rejectedUrls) {
  const data = fixture(); data.nextCandidates = [{rank:1,lane:'production',orderName:'#URL',orderUrl:url,reviewUrl:url}]; data.reviewCases=[];
  const f = harness([okPlan(data)]); await flush();
  equal(descendants(f.elements.get('ops-candidates'),'a').length,0,'Reject untrusted/action link: ' + String(url));
}
for (const url of ['/orders','/orders?id=1','/orders/make-telegraph?id=gid%3A%2F%2Fshopify%2FOrder%2F1',origin+'/orders?id=1','https://admin.shopify.com/store/viola/orders/1']) {
  const data = fixture(); data.nextCandidates=[{rank:1,lane:'production',orderUrl:url}];
  const f = harness([okPlan(data)]); await flush();
  equal(descendants(f.elements.get('ops-candidates'),'a').length,1,'Allow only validated display link: ' + url);
}

// Deadline abort, late response suppression, and a subsequent manually requested snapshot.
let resolveLate;
const timeout = harness([() => new Promise((resolve) => {resolveLate=resolve;})]);
timeout.expire(); await flush();
equal(timeout.aborted,1,'Deadline aborts underlying request');
check(timeout.requests[0].options.signal.aborted,'Fetch signal actually aborted');
check(textOf(timeout,'unavailable').includes('انتهت مهلة'),'Timeout explicitly unavailable');
equal(timeout.requests.length,1,'Timeout never schedules retry'); equal(timeout.timers.size,0,'Timeout cleaned up');
timeout.plans.push(okPlan({...fixture(),notes:['AFTER-TIMEOUT']})); timeout.refresh(); await flush();
resolveLate(response({...fixture(),notes:['LATE-RESPONSE-MUST-NOT-WIN']})); await flush();
check(textOf(timeout,'notes').includes('AFTER-TIMEOUT') && !timeout.root.textContent.includes('LATE-RESPONSE-MUST-NOT-WIN'),'Late timed-out response cannot overwrite newer snapshot');
const absentAbort = harness([], {abortAvailable:false}); await flush();
equal(absentAbort.requests.length,0,'No unbounded fetch without AbortController');
check(!absentAbort.elements.get('ops-unavailable').hidden,'Unsupported timeout capability fails visibly closed');
const noRoot = harness([], {missingRoot:true}); await flush(); equal(noRoot.requests.length,0,'No mount means no fetch');

const capped = fixture();
capped.nextCandidates = Array.from({length:10},(_,i)=>({lane:'production',rank:10-i,orderName:'#CAPPED-'+(10-i)}));
capped.reviewCases = Array.from({length:250},(_,i)=>({caseId:'CASE-'+i,orderName:'#REVIEW-'+i,classification:i%2?'durable-hold':'needs-review'}));
capped.reviewTotal=1000; capped.truncatedReview=true;
const cap = harness([okPlan(capped)]); await flush();
equal(descendants(cap.elements.get('ops-candidates'),'tbody')[0].childNodes.length,8,'Per-lane candidate cap is eight');
check(!textOf(cap,'candidates').includes('#CAPPED-9') && textOf(cap,'candidates').includes('#CAPPED-1'),'Cap applied after within-lane sorting');
equal(descendants(cap.elements.get('ops-reviews'),'tbody')[0].childNodes.length+descendants(cap.elements.get('ops-held'),'tbody')[0].childNodes.length,250,'All 250 backend review rows supported');
check(textOf(cap,'review-total').includes('القائمة مختصرة'),'Backend truncation explicitly stated');
check(!cap.elements.get('ops-partial').hidden,'Unexpected candidate over-cap is marked partial');

for (const field of ['scheduler','queues','nextCandidates','activeClaims','reviewCases']) {
  const data=fixture(); data[field]=[null,7,'not-an-object',[]];
  const f=harness([okPlan(data)]); await flush();
  check(!f.elements.get('ops-partial').hidden && f.elements.get('ops-unavailable').hidden,'Malformed '+field+' rows remain an explicit partial snapshot');
}
const prototypeData=fixture(); prototypeData.reviewCases[0].classification='__proto__';
const prototype=harness([okPlan(prototypeData)]); await flush();
check(prototype.elements.get('ops-unavailable').hidden,'Prototype-like classification remains safe text, not DOM');
console.log(JSON.stringify({ok:true,checks,realNetworkCalls:0,realDatabaseCalls:0,realBusinessWrites:0,realPreviewRun:0}));
