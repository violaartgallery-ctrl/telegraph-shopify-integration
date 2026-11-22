/** Read-only shell fragment. No provider imports or operational entrypoints. */
export function renderOperationsDashboard(): string {
  return `
    <section id="operations-dashboard" dir="rtl" lang="ar" aria-labelledby="ops-title">
      <style>
        #operations-dashboard { --ops-ink:#202223; --ops-muted:#59646b; --ops-line:#dfe3e8; color:var(--ops-ink); }
        #operations-dashboard * { box-sizing:border-box; }
        #operations-dashboard .ops-heading { display:flex; flex-wrap:wrap; align-items:start; justify-content:space-between; gap:14px; margin-bottom:16px; }
        #operations-dashboard h2 { font-size:22px; margin:0 0 8px; }
        #operations-dashboard h3 { font-size:17px; margin:24px 0 10px; }
        #operations-dashboard h4 { font-size:15px; margin:0 0 12px; }
        #operations-dashboard p { line-height:1.8; margin:6px 0; }
        #operations-dashboard .ops-muted { color:var(--ops-muted); }
        #operations-dashboard .ops-notice { padding:12px 14px; background:#f3f7f6; border-inline-start:4px solid #0b6b5d; border-radius:6px; }
        #operations-dashboard .ops-warning { background:#fff8e8; border-inline-start-color:#9a6700; }
        #operations-dashboard .ops-error { background:#fff1f0; border-inline-start-color:#b42318; }
        #operations-dashboard [hidden] { display:none !important; }
        #operations-dashboard .ops-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr)); gap:12px; }
        #operations-dashboard .ops-card { min-width:0; padding:16px; border:1px solid var(--ops-line); border-radius:8px; background:#fff; }
        #operations-dashboard dl { margin:0; }
        #operations-dashboard .ops-metric { display:flex; justify-content:space-between; align-items:baseline; gap:12px; padding:6px 0; border-bottom:1px solid #f1f3f5; }
        #operations-dashboard dt { color:var(--ops-muted); }
        #operations-dashboard dd { margin:0; text-align:end; font-weight:600; overflow-wrap:anywhere; }
        #operations-dashboard .ops-table-wrap { width:100%; overflow-x:auto; border:1px solid var(--ops-line); border-radius:8px; }
        #operations-dashboard table { min-width:740px; width:100%; border-collapse:collapse; }
        #operations-dashboard caption { text-align:start; padding:12px; font-weight:600; }
        #operations-dashboard th,#operations-dashboard td { text-align:start; padding:10px 12px; border-bottom:1px solid var(--ops-line); vertical-align:top; line-height:1.7; }
        #operations-dashboard th { background:#f6f7f8; white-space:nowrap; }
        #operations-dashboard td { max-width:320px; overflow-wrap:anywhere; }
        #operations-dashboard .ops-links { display:flex; flex-wrap:wrap; gap:10px; }
        #operations-dashboard a { color:#075e52; text-underline-offset:3px; }
        #operations-dashboard :focus-visible { outline:3px solid #2563eb; outline-offset:3px; }
        #operations-dashboard .ops-totals { display:flex; flex-wrap:wrap; gap:8px 24px; margin:12px 0; }
        #operations-dashboard .ops-historical { border-top:2px dashed #b6bfc8; margin-top:24px; padding-top:2px; }
        @media(max-width:600px) { #operations-dashboard { padding:14px; } #operations-dashboard .ops-heading button { width:100%; } }
      </style>
      <div class="ops-heading">
        <div><h2 id="ops-title">لوحة متابعة عمليات VIOLA</h2><p class="ops-muted">عرض فقط — تحميل واحد عند الفتح، ثم تحديث يدوي فقط. لا تشغيل أو تعديل من هذه اللوحة.</p></div>
        <button id="ops-refresh" type="button">تحديث لقطة العمليات</button>
      </div>
      <p id="ops-status" role="status" aria-live="polite">لم تُحمّل لقطة العمليات بعد.</p>
      <p id="ops-unavailable" class="ops-notice ops-error" role="alert" hidden></p>
      <div class="ops-totals"><span id="ops-generated">وقت المصدر بتوقيت القاهرة: غير متاح</span><span id="ops-freshness">حداثة المصدر: غير معروفة</span></div>
      <p class="ops-muted">الحداثة تُقيّم عند عرض اللقطة فقط، ولا تتغير تلقائيًا. وقت اللقطة لا يضمن حداثة كل مزوّد.</p>
      <p id="ops-controller" class="ops-notice ops-warning">حالة متحكم الجدولة غير متاحة؛ لا يُفترض أنه يعمل.</p>
      <p id="ops-partial" class="ops-notice ops-warning" role="status" hidden></p>
      <h3>مسارات الجدولة الثلاثة</h3><div id="ops-scheduler" class="ops-grid">بيانات الجدولة غير متاحة.</div>
      <h3>طوابير الأعمال</h3><div id="ops-queues" class="ops-grid">عدادات الطوابير غير متاحة، وليست أصفارًا مؤكدة.</div>
      <h3>المرشحون القادمون — ترتيب مستقل لكل مسار</h3>
      <p class="ops-notice">الترتيب داخل كل مسار وقت اللقطة فقط، وليس ترتيبًا عامًا أو حجزًا أو وعدًا بالتنفيذ. تُعرض حتى ٨ حالات لكل مسار؛ الأهلية قد تتغير قبل المعالجة.</p>
      <div id="ops-candidates">بيانات المرشحين غير متاحة.</div>
      <h3>المطالبات النشطة</h3><div id="ops-claims">بيانات المطالبات غير متاحة.</div>
      <h3>حالات القرار والمراجعة</h3><p id="ops-review-total" class="ops-muted">إجمالي المراجعة: غير متاح</p><div id="ops-reviews">بيانات المراجعة غير متاحة.</div>
      <details class="ops-historical"><summary>افتح الحالات الموقوفة والتشخيصات القديمة — منفصلة</summary>
        <p class="ops-notice ops-warning">الحالات الموقوفة لا تعطل العمل الجديد المستقل؛ لا تتيح هذه اللوحة رفع أي إيقاف.</p>
        <p id="ops-holds-total" class="ops-muted">إجمالي الإيقافات: غير متاح</p><div id="ops-held">بيانات الإيقافات غير متاحة.</div>
      </details>
      <h3>ملاحظات اللقطة</h3><div id="ops-notes">الملاحظات غير متاحة.</div>
      <p class="ops-notice">هذه حالة لقطة فقط، وليست ضمانًا بأن كامل الأعمال المتراكمة انتهى. أي مصدر ناقص أو غير متاح لا يُعرض كصفر سليم.</p>
    </section>`;
}

/** JS body only; insert after the shell's html, adminHeaders and adminUrl helpers. */
export function renderOperationsDashboardScript(): string {
  return String.raw`
    (() => {
      const root = document.getElementById('operations-dashboard');
      if (!root || root.dataset.operationsInitialized === 'true') return;
      root.dataset.operationsInitialized = 'true';
      const get = (id) => document.getElementById('ops-' + id);
      const refresh = get('refresh');
      const unknown = 'غير متاح';
      const maxRows = 1000;
      let busy = false;
      let lastSnapshot = null;
      const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
      const count = (value) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
      const number = (value) => count(value) ? value.toLocaleString('ar-EG') : unknown;
      // Whitelisted scalar fields only. Never stringify raw objects or expose diagnostics.
      const text = (value, fallback = unknown) => {
        if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) return fallback;
        const s = String(value).trim();
        if (!s) return fallback;
        if (/:\/\/|[{}]|\b(?:bearer|basic)\s+\S+|\b(?:password|passwd|secret|token|api[_ -]?key|dsn|connection[_ -]?string|authorization)\s*[:=]|-----BEGIN|^\s*\[/i.test(s)) return 'تفاصيل حساسة أو خام محجوبة';
        return s.length > 400 ? s.slice(0, 400) + '…' : s;
      };
      const el = (tag, value, className) => {
        const node = document.createElement(tag);
        if (value !== undefined) node.textContent = text(value);
        if (className) node.className = className;
        return node;
      };
      const date = (value) => {
        if (typeof value !== 'number' && typeof value !== 'string') return null;
        if (typeof value === 'string' && !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) return null;
        if (typeof value === 'number' && (!Number.isFinite(value) || value <= 0)) return null;
        const parsed = new Date(typeof value === 'number' && value < 100000000000 ? value * 1000 : value);
        return Number.isFinite(parsed.getTime()) ? parsed : null;
      };
      const formatter = new Intl.DateTimeFormat('ar-EG', {
        timeZone:'Africa/Cairo', year:'numeric', month:'2-digit', day:'2-digit',
        hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23'
      });
      const time = (value) => {
        const d = date(value);
        if (!d) return el('span', unknown);
        const node = el('time', formatter.format(d) + ' — القاهرة');
        node.dateTime = d.toISOString();
        return node;
      };
      const metric = (list, label, value) => {
        const row = el('div', undefined, 'ops-metric');
        const detail = el('dd');
        detail.append(value && typeof value === 'object' ? value : el('span', value));
        row.append(el('dt', label), detail);
        list.append(row);
      };
      // Only known read-only display paths. Never link API, legacy executor or arbitrary JSON paths.
      const safeHref = (value) => {
        if (typeof value !== 'string' || value.length > 2000 || /[\s\\\u0000-\u001f\u007f]/.test(value)) return null;
        if (!value.startsWith('/') && !value.startsWith('https://')) return null;
        try {
          const url = new URL(value, window.location.origin);
          if (url.username || url.password || url.hash) return null;
          if (url.origin === window.location.origin) {
            if (!['/orders', '/orders/make-telegraph'].includes(url.pathname)) return null;
            const seen = new Set();
            for (const [key, val] of url.searchParams) {
              if (!['id', 'orderId', 'orderGid'].includes(key) || seen.has(key) || !/^(?:\d+|gid:\/\/shopify\/Order\/\d+)$/.test(val)) return null;
              seen.add(key);
            }
            return adminUrl(url.pathname + url.search);
          }
          if (url.protocol !== 'https:' || url.hostname !== 'admin.shopify.com' || url.port || url.search) return null;
          return /^\/store\/[a-z0-9][a-z0-9_-]*\/orders\/\d+\/?$/i.test(url.pathname) ? url.href : null;
        } catch { return null; }
      };
      const links = (row) => {
        const wrap = el('div', undefined, 'ops-links');
        for (const [key, label] of [['orderUrl', 'عرض الأوردر'], ['reviewUrl', 'فتح المراجعة فقط']]) {
          const href = safeHref(row[key]);
          if (!href) continue;
          const anchor = el('a', label);
          anchor.href = href;
          anchor.target = '_blank';
          anchor.rel = 'noopener noreferrer';
          anchor.referrerPolicy = 'no-referrer';
          wrap.append(anchor);
        }
        if (!wrap.childNodes.length) wrap.textContent = 'لا يوجد رابط عرض موثوق';
        return wrap;
      };
      const rows = (value) => Array.isArray(value) ? value.filter(record) : null;
      const table = (title, headers, data, cells) => {
        if (data === null) return el('p', 'المصدر غير متاح لهذا القسم؛ لا توجد أصفار مفترضة.', 'ops-notice ops-warning');
        if (!data.length) return el('p', 'لا توجد صفوف في هذه اللقطة فقط؛ هذا لا يثبت انتهاء كامل المتراكم.', 'ops-muted');
        const wrap = el('div', undefined, 'ops-table-wrap');
        wrap.tabIndex = 0;
        wrap.setAttribute('role', 'region');
        wrap.setAttribute('aria-label', title);
        const grid = el('table');
        grid.append(el('caption', title + (data.length > maxRows ? ' — عرض أول ١٠٠٠ صف فقط' : '')));
        const head = el('thead');
        const heading = el('tr');
        for (const label of headers) { const th = el('th', label); th.setAttribute('scope', 'col'); heading.append(th); }
        head.append(heading);
        const body = el('tbody');
        for (const row of data.slice(0, maxRows)) {
          const tr = el('tr');
          for (const value of cells(row)) {
            const td = el('td');
            td.append(value && typeof value === 'object' ? value : el('span', value));
            tr.append(td);
          }
          body.append(tr);
        }
        grid.append(head, body);
        wrap.append(grid);
        return wrap;
      };
      const historical = (row) => [
        'held', 'historical', 'historical-held', 'held-historical', 'historical_held',
        'held_historical', 'owner-held', 'legacy-held', 'durable-hold', 'owner_hold', 'diagnostic-hold'
      ].includes(typeof row.classification === 'string' ? row.classification.toLowerCase() : '');
      const classification = (value) => {
        const labels = {
          dependency:'بانتظار متطلب سابق',
          'uncertain-claim':'مطالبة غير محسومة — يلزم تحقق مستقل',
          'durable-hold':'إيقاف محفوظ — ليس تراكمًا قابلًا للتنفيذ؛ يحتاج قرارًا موثقًا',
          'diagnostic-hold':'تشخيص بوليصة قديم / مستبعد من التحديث — ليس قرار شحن',
          'needs-review':'تحتاج مراجعة'
        };
        return typeof value === 'string' && Object.hasOwn(labels, value) ? labels[value] : text(value);
      };
      function render(data) {
        const scheduler = rows(data.scheduler);
        const queues = rows(data.queues);
        const candidates = rows(data.nextCandidates);
        const claims = rows(data.activeClaims);
        const reviews = rows(data.reviewCases);
        const notes = Array.isArray(data.notes) ? data.notes : null;
        let partial = !record(data.controller) || typeof data.controller.active !== 'boolean' ||
          !date(data.generatedAt) || !count(data.cacheTtlSeconds) || data.cacheTtlSeconds === 0 ||
          !count(data.reviewTotal) || !count(data.holdsTotal) || typeof data.truncatedReview !== 'boolean' ||
          [scheduler, queues, candidates, claims, reviews, notes].some((v) => v === null);
        for (const key of ['scheduler','queues','nextCandidates','activeClaims','reviewCases']) {
          if (Array.isArray(data[key]) && (data[key].some((r) => !record(r)) || data[key].length > maxRows)) partial = true;
        }
        const scheduled = el('div', undefined, 'ops-grid');
        for (const [lane, label] of [['status','متابعة الحالة'], ['discovery','اكتشاف الأعمال'], ['financial','المحاسبة']]) {
          const matches = (scheduler || []).filter((r) => r.lane === lane);
          const item = matches.length === 1 ? matches[0] : {};
          if (matches.length !== 1 || typeof item.enabled !== 'boolean' || typeof item.state !== 'string' || !item.state.trim()) partial = true;
          const card = el('article', undefined, 'ops-card');
          card.append(el('h4', label));
          const list = el('dl');
          metric(list, 'اسم المصدر', text(item.label, label));
          metric(list, 'التفعيل', item.enabled === true ? 'مفعّل' : item.enabled === false ? 'معطّل' : unknown);
          metric(list, 'الحالة', ({held:'موقوف',running:'قيد التنفيذ',error:'خطأ مسجل',unscheduled:'لا يوجد موعد مسجل',overdue:'تأخر الموعد المسجل',waiting:'منتظر الموعد','awaiting-first-cycle':'منتظر أول دورة'})[item.state] || text(item.state));
          metric(list, 'الموعد القادم', time(item.nextAt));
          metric(list, 'آخر نجاح', time(item.lastSuccessAt));
          metric(list, 'آخر بداية', time(item.lastStartedAt));
          metric(list, 'انتهاء المهلة الحصرية', time(item.leaseUntil));
          metric(list, 'آخر خطأ', item.lastError === null || item.lastError === '' ? 'لا يوجد خطأ مسجل في اللقطة' : text(item.lastError));
          card.append(list);
          scheduled.append(card);
        }
        const queued = el('div', undefined, 'ops-grid');
        if (queues && queues.length) {
          for (const item of queues.slice(0, maxRows)) {
            const card = el('article', undefined, 'ops-card');
            card.append(el('h4', text(item.label, text(item.lane, 'مسار غير معرّف'))));
            const list = el('dl');
            for (const [key, label] of [['pending','في الانتظار'],['retryable','قابل لإعادة المحاولة'],['processing','قيد المعالجة'],['waitingDependency','بانتظار متطلب سابق'],['review','للمراجعة'],['held','موقوف — ليس تراكمًا قابلًا للتنفيذ'],['completedExcluded','مكتمل / مستبعد من التنفيذ'],['eligibleNow','مؤهل الآن في اللقطة']]) {
              if (!count(item[key])) partial = true;
              metric(list, label, number(item[key]));
            }
            card.append(list); queued.append(card);
          }
        } else queued.append(el('p', queues ? 'لا توجد مسارات مُبلّغ عنها في اللقطة؛ لا تُفترض أصفار للمسارات الغائبة.' : 'عدادات الطوابير غير متاحة، وليست أصفارًا مؤكدة.', 'ops-notice ops-warning'));
        const rank = (r) => count(r.rank) && r.rank > 0 ? r.rank : Infinity;
        const order = (r) => text(r.orderName, text(r.orderId));
        const reviewTable = (title, items) => table(title, ['الحالة','الأوردر','البوليصة','السبب','المطلوب من المسؤول','التصنيف','روابط عرض'], items,
          (r) => [text(r.caseId), order(r), text(r.shipmentCode), text(r.reason), text(r.requiredAction), classification(r.classification), links(r)]);
        const candidatePanel = el('div');
        if (candidates === null || !candidates.length) candidatePanel.append(table('المرشحون حسب المسار', [], candidates, () => []));
        else {
          const groups = new Map();
          for (const row of candidates) {
            const lane = typeof row.lane === 'string' && row.lane.trim() ? row.lane : unknown;
            if (lane === unknown) partial = true;
            if (!groups.has(lane)) groups.set(lane, []);
            groups.get(lane).push(row);
          }
          for (const [lane, items] of groups) {
            const sorted = items.map((r, i) => ({r, i})).sort((a, b) => {
              if (rank(a.r) !== rank(b.r)) return rank(a.r) < rank(b.r) ? -1 : 1;
              return a.i - b.i;
            }).slice(0, 8).map((entry) => entry.r);
            if (items.length > 8) { partial = true; candidatePanel.append(el('p', 'عُرض أول ٨ مرشحين لهذا المسار فقط.', 'ops-notice ops-warning')); }
            candidatePanel.append(table('المسار: ' + text(items[0].label, text(lane)) + ' — ترتيب داخل المسار فقط',
              ['الترتيب داخل المسار','الأوردر','البوليصة','المرحلة','سبب الترتيب / الانتظار','ليس قبل','روابط عرض'], sorted,
              (r) => [rank(r) === Infinity ? unknown : number(r.rank), order(r), text(r.shipmentCode), text(r.stage), text(r.reason), time(r.notBefore), links(r)]));
          }
        }
        const visibleReviews = reviews === null ? null : reviews.slice(0, maxRows);
        // Build detached DOM before replacing any part of the last successful snapshot.
        const next = {
          scheduler: scheduled, queues: queued,
          candidates: candidatePanel,
          claims: table('المطالبات النشطة كما وردت في اللقطة', ['المسار','الأوردر','البوليصة','المرحلة','الحالة','بدأت في'], claims,
            (r) => [text(r.lane), order(r), text(r.shipmentCode), text(r.stage), text(r.status), time(r.startedAt)]),
          reviews: reviewTable('حالات القرار والمراجعة', visibleReviews === null ? null : visibleReviews.filter((r) => !historical(r))),
          held: reviewTable('حالات تاريخية أو موقوفة بقرار — ليست طابور تنفيذ', visibleReviews === null ? null : visibleReviews.filter(historical)),
          notes: el('ul', undefined, 'ops-muted')
        };
        if (!notes) next.notes.append(el('li', 'الملاحظات غير متاحة.'));
        else if (!notes.length) next.notes.append(el('li', 'لا توجد ملاحظات مرفقة باللقطة.'));
        else for (const note of notes.slice(0, 25)) { if (typeof note !== 'string') partial = true; next.notes.append(el('li', text(note))); }
        if (notes && notes.length > 25) { partial = true; next.notes.append(el('li', 'عُرضت أول ٢٥ ملاحظة فقط.')); }
        for (const [key, node] of Object.entries(next)) get(key).replaceChildren(node);
        get('generated').replaceChildren(el('span', 'وقت المصدر: '), time(data.generatedAt));
        const generated = date(data.generatedAt);
        const age = generated ? Date.now() - generated.getTime() : NaN;
        const ttl = count(data.cacheTtlSeconds) && data.cacheTtlSeconds > 0 ? data.cacheTtlSeconds : null;
        get('freshness').textContent = !Number.isFinite(age) || !ttl ? 'حداثة المصدر غير معروفة.' :
          age < -5000 ? 'وقت المصدر في المستقبل؛ الحداثة غير موثوقة.' :
          age > ttl * 1000 ? 'لقطة قديمة عند العرض؛ تجاوزت حد الحداثة (' + number(ttl) + ' ثانية).' :
          'ضمن حد حداثة اللقطة عند العرض فقط (' + number(ttl) + ' ثانية).';
        get('controller').textContent = 'متحكم الجدولة: ' + (record(data.controller) && data.controller.active === true ? 'نشط بحسب اللقطة' : record(data.controller) && data.controller.active === false ? 'غير نشط بحسب اللقطة' : unknown) +
          (record(data.controller) && data.controller.reason ? ' — ' + text(data.controller.reason) : '');
        get('review-total').textContent = 'إجمالي المراجعة المُبلّغ عنه: ' + number(data.reviewTotal) + '؛ الصفوف المستلمة: ' + (reviews ? number(reviews.length) : unknown) +
          (reviews && reviews.length > maxRows ? ' — عرض أول ١٠٠٠ صف فقط.' : '') +
          (data.truncatedReview === true ? ' — القائمة مختصرة؛ توجد حالات غير معروضة.' : data.truncatedReview === false ? ' — بحسب نطاق اللقطة فقط.' : ' — اكتمال القائمة غير معروف.');
        get('holds-total').textContent = 'إجمالي الإيقافات المُبلّغ عنه: ' + number(data.holdsTotal) + '؛ لا يعني عدد الصفوف الظاهرة أو عدد الأعمال القابلة للتنفيذ.';
        get('partial').hidden = !partial;
        get('partial').textContent = partial ? 'لقطة جزئية: بعض المصادر أو الحقول ناقصة / غير صالحة أو العرض محدود. «غير متاح» لا يعني صفرًا ولا حالة سليمة.' : '';
        get('unavailable').hidden = true;
        get('status').textContent = 'عُرضت لقطة العمليات. لا تحديث تلقائي؛ استخدم زر التحديث اليدوي لقراءة جديدة فقط.';
      }
      async function loadSnapshot() {
        if (busy) return;
        busy = true;
        refresh.disabled = true;
        root.setAttribute('aria-busy', 'true');
        get('status').textContent = 'جاري قراءة لقطة العمليات فقط…';
        let timeout;
        let timedOut = false;
        try {
          const controller = new AbortController();
          const deadline = new Promise((_, reject) => {
            // Sole timer: one request deadline, never a refresh / polling / retry timer.
            timeout = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('request-timeout')); }, 12000);
          });
          const request = (async () => {
            const response = await fetch(adminUrl('/api/operations/dashboard'), {
              method:'GET', headers:adminHeaders, signal:controller.signal,
              cache:'no-store', credentials:'same-origin', redirect:'error'
            });
            if (!response.ok) throw new Error('snapshot-unavailable');
            const payload = await response.json();
            if (!record(payload) || payload.ok !== true) throw new Error('snapshot-invalid');
            return payload;
          })();
          const payload = await Promise.race([request, deadline]);
          render(payload);
          lastSnapshot = payload;
          if(typeof window.dispatchEvent==='function'&&typeof CustomEvent!=='undefined')window.dispatchEvent(new CustomEvent('viola-operations-snapshot',{detail:payload}));
        } catch {
          if(typeof window.dispatchEvent==='function'&&typeof CustomEvent!=='undefined')window.dispatchEvent(new CustomEvent('viola-operations-unavailable'));
          get('unavailable').hidden = false;
          get('unavailable').textContent = (timedOut ? 'انتهت مهلة قراءة المصدر. ' : 'مصدر العمليات غير متاح أو أعاد لقطة غير صالحة. ') +
            (lastSnapshot ? 'تظل آخر لقطة ناجحة معروضة، لكنها ليست قراءة حالية مؤكدة. ' : 'لم تُحمّل أي لقطة ناجحة؛ لا توجد أصفار أو حالة سليمة مفترضة. ') +
            'لا توجد إعادة محاولة تلقائية أو أي عملية تنفيذ.';
          get('freshness').textContent = lastSnapshot ? 'آخر لقطة محفوظة؛ تعذر التأكد من حداثة المصدر.' : 'حداثة المصدر: غير معروفة';
          get('status').textContent = 'تعذر تحديث اللقطة. يمكنك طلب قراءة جديدة يدويًا فقط.';
        } finally {
          if (timeout !== undefined) clearTimeout(timeout);
          busy = false;
          refresh.disabled = false;
          root.setAttribute('aria-busy', 'false');
        }
      }
      refresh.addEventListener('click', loadSnapshot);
      void loadSnapshot();
    })();
  `;
}
