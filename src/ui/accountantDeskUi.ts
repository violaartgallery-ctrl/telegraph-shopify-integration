/**
 * Accountant desk (owner, 2026-11-25). Display only: it reads the same
 * read-only operations snapshot event as the review list and filters that list
 * by category. Decisions are still made and executed through the existing
 * signed review flow. Never interpolates snapshot content as HTML.
 */
import { ACCOUNTANT_CATEGORIES } from '../services/accountantCategories.js';

/** Owner rule table, as agreed on 2026-11-25. Static text, no data. */
export const ACCOUNTANT_RULES: Array<{ n: number; when: string; action: string; state: 'on' | 'release' | 'later' | 'owner' }> = [
  { n: 1, when: 'اتسلم، وتليجراف حوّل لنا، والمبلغ = إجمالي الأوردر', action: 'فاتورة بالصافي + دفعة كاش + علامة مدفوع في Shopify', state: 'on' },
  { n: 2, when: 'اتحصّل وتليجراف لسه ماحوّلش', action: 'يستنى، ويسجل لوحده أول ما يحوّل', state: 'release' },
  { n: 3, when: 'العميل دفع أقل بفرق لحد 150 ج', action: 'خصم، والفاتورة باللي اتحصّل (المحاسب يعتمد «خصم» لحد ما تبقى أوتوماتيك)', state: 'later' },
  { n: 4, when: 'العميل دفع أقل بأكتر من 150 ج', action: 'يوقف ويظهر في «استلام جزئي أو نقص كبير»', state: 'on' },
  { n: 5, when: 'العميل دفع أكتر من الإجمالي', action: 'الفاتورة بالمبلغ الأكبر (المحاسب يعتمد «زيادة»)', state: 'later' },
  { n: 6, when: 'رجع ومفيش فلوس', action: 'إلغاء في Shopify + البضاعة ترجع المخزن', state: 'release' },
  { n: 7, when: 'رجع والعميل دفع الشحن كله أو جزء منه', action: 'يقفل الأوردر ويرجّع البضاعة، والشحن مايتسجلش إيراد', state: 'later' },
  { n: 8, when: 'استلم جزء ورجّع جزء', action: 'يطابق المبلغ بأسعار القطع، ولو مش واضح يسأل المحاسب', state: 'later' },
  { n: 9, when: 'رجع وبعدين اتسلم ودفع', action: 'يرجّع نفس أمر البيع في Odoo ويكمّله', state: 'on' },
  { n: 10, when: 'ملغي في Shopify، بس اتسلم ودفع', action: 'Odoo بس، وShopify يفضل ملغي', state: 'on' },
  { n: 11, when: 'مدفوع مقدم', action: 'أمر بيع + فاتورة وقت عمل الشحنة', state: 'on' },
  { n: 12, when: 'اتغيرت الملاحظات أو التاجات أو الاسم أو التخصيص بس', action: 'يتجاهلها ويكمّل', state: 'release' },
  { n: 13, when: 'المنتج أو اللون اتغير بعد الشحن', action: 'يظهر في «الأوردر اتغير بعد الشحن» لحد ما يبقى أوتوماتيك', state: 'later' },
  { n: 14, when: 'البوليصة مش موجودة في تليجراف', action: 'يظهر للمحاسب', state: 'owner' },
  { n: 15, when: 'الرسوم أكتر من اللي اتحصّل', action: 'الفرق مصروف', state: 'on' },
];
const STATE_LABEL = { on: 'شغالة', release: 'مع الإصدار ده', later: 'جاية', owner: 'قرار المحاسب' } as const;

/** Icon path data per category (24×24, stroke). Static, no data. */
const ICONS: Record<string, string[]> = {
  held: ['M6 11V8a6 6 0 0 1 12 0v3', 'M5 11h14v10H5z'],
  uncertain: ['M12 3l9 16H3z', 'M12 10v4', 'M12 17v.01'],
  no_waybill: ['M3 7h11v9H3z', 'M14 10h4l3 3v3h-7', 'M4 4l16 16'],
  clones: ['M8 8h12v12H8z', 'M16 8V4H4v12h4'],
  partial: ['M4 8l8-4 8 4v8l-8 4-8-4z', 'M12 12v8', 'M4 8l8 4 8-4'],
  money: ['M3 6h18v12H3z', 'M12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5'],
  return_money: ['M9 14L4 9l5-5', 'M4 9h11a5 5 0 0 1 0 10h-3'],
  changed: ['M4 20h4L19 9l-4-4L4 16z', 'M13 7l4 4'],
  auto: ['M4 12a8 8 0 0 1 14-5', 'M18 3v4h-4', 'M20 12a8 8 0 0 1-14 5', 'M6 21v-4h4'],
  new: ['M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18', 'M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5V14', 'M12 17v.01'],
};

export function renderAccountantDesk(): string {
  return `
<section id="accountant-desk" dir="rtl" lang="ar" aria-labelledby="ad-title">
<style>
#accountant-desk{--ad-ink:#1f2a24;--ad-muted:#5d6b63;--ad-line:#dde5e0;--ad-panel:#fff;--ad-bg:#f5f8f6;--ad-warn:#a15c00;--ad-ok:#16704f;--ad-bot:#2f6fb3;--ad-held:#98a39d;--ad-tech:#7a5ab8;color:var(--ad-ink);line-height:1.7;margin-bottom:28px}
#accountant-desk *{box-sizing:border-box}#accountant-desk [hidden]{display:none!important}
#accountant-desk h2{margin:0;font-size:24px}#accountant-desk h3{margin:22px 0 10px;font-size:17px}#accountant-desk p{margin:6px 0}
#accountant-desk .ad-muted{color:var(--ad-muted)}#accountant-desk .ad-head{display:flex;flex-wrap:wrap;gap:8px 18px;align-items:baseline;justify-content:space-between}
#accountant-desk .ad-summary{font-size:16px}#accountant-desk .ad-summary b{font-variant-numeric:tabular-nums}
#accountant-desk .ad-stack{display:flex;height:22px;border-radius:999px;overflow:hidden;background:var(--ad-bg);border:1px solid var(--ad-line);margin:12px 0}
#accountant-desk .ad-stack span{display:block;height:100%;min-width:3px}
#accountant-desk .ad-cats{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,210px),1fr));gap:10px}
#accountant-desk .ad-cat{font:inherit;text-align:start;cursor:pointer;background:var(--ad-panel);border:1px solid var(--ad-line);border-radius:10px;padding:12px;display:grid;grid-template-columns:auto 1fr auto;gap:4px 10px;align-items:center;color:var(--ad-ink)}
#accountant-desk .ad-cat[aria-pressed="true"]{border-color:var(--ad-ink);box-shadow:inset 0 0 0 1px var(--ad-ink)}
#accountant-desk .ad-cat svg{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
#accountant-desk .ad-cat .n{font-size:20px;font-weight:700;font-variant-numeric:tabular-nums}
#accountant-desk .ad-cat .who{grid-column:1/-1;font-size:13px;color:var(--ad-muted)}
#accountant-desk .ad-track{grid-column:1/-1;height:8px;border-radius:999px;background:var(--ad-bg);overflow:hidden}
#accountant-desk .ad-fill{height:100%;border-radius:999px;width:0}
#accountant-desk .ad-hint{padding:10px 14px;background:var(--ad-bg);border-radius:8px;margin-top:10px}
#accountant-desk .ad-all{font:inherit;cursor:pointer;background:none;border:1px solid var(--ad-line);border-radius:999px;padding:4px 14px;color:var(--ad-ink)}
#accountant-desk table{width:100%;border-collapse:collapse;font-size:14px}#accountant-desk th,#accountant-desk td{text-align:start;padding:8px;border-bottom:1px solid var(--ad-line);vertical-align:top}
#accountant-desk .ad-pill{display:inline-block;font-size:12px;padding:1px 9px;border-radius:999px;border:1px solid var(--ad-line);white-space:nowrap}
#accountant-desk .ad-pill.on{border-color:var(--ad-ok);color:var(--ad-ok)}#accountant-desk .ad-pill.release{border-color:var(--ad-bot);color:var(--ad-bot)}#accountant-desk .ad-pill.owner{border-color:var(--ad-warn);color:var(--ad-warn)}
#accountant-desk .ad-wrap{overflow-x:auto}
#accountant-desk :focus-visible{outline:3px solid #2563eb;outline-offset:2px}
@media (prefers-reduced-motion:no-preference){#accountant-desk .ad-fill{transition:width .7s ease-out}}
</style>
<div class="ad-head"><h2 id="ad-title">مكتب المحاسب</h2><span id="ad-time" class="ad-muted">لسه ما اتقريتش حالة الطوابير.</span></div>
<p id="ad-summary" class="ad-summary" role="status" aria-live="polite">جاري قراءة الأوردرات الواقفة…</p>
<div id="ad-stack" class="ad-stack" role="img" aria-label="الأوردرات الواقفة مقسومة حسب النوع"></div>
<h3>اختار نوع، وهتلاقي أوردراته تحت في «قراراتك»</h3>
<div id="ad-cats" class="ad-cats"></div>
<p id="ad-hint" class="ad-hint" hidden></p>
<p><button id="ad-all" class="ad-all" type="button" hidden>اعرض كل الأنواع</button></p>
<p class="ad-muted">البوت بيكمّل الحالات الواضحة لوحده. هنا بيظهر للمحاسب بس اللي محتاج قرار. القرار بيتحفظ ويتنفذ بعد ما البوت يتأكد من تليجراف وShopify وOdoo، ومافيش أي مستند بيتعمل مرتين.</p>
<details><summary>قواعد البوت</summary><div class="ad-wrap"><table><thead><tr><th>#</th><th>لو حصل</th><th>البوت يعمل</th><th>الحالة</th></tr></thead><tbody id="ad-rules"></tbody></table></div></details>
</section>`;
}

export function renderAccountantDeskScript(): string {
  const categories = JSON.stringify(ACCOUNTANT_CATEGORIES.map(c => ({ id: c.id, label: c.label, who: c.who, hint: c.hint })));
  const rules = JSON.stringify(ACCOUNTANT_RULES.map(r => ({ ...r, stateLabel: STATE_LABEL[r.state] })));
  const icons = JSON.stringify(ICONS);
  return String.raw`
(()=>{
 const root=document.getElementById('accountant-desk');if(!root||root.dataset.ready)return;root.dataset.ready='1';
 const CATS=${categories},RULES=${rules},ICONS=${icons};
 const ORDER=CATS.map(c=>c.id),WHO={accountant:'محتاج قرار المحاسب',bot:'البوت هيكمّلها لوحده',technical:'مراجعة فنية',held:'محجوز، مفيش قرار دلوقتي'};
 const COLOR={accountant:'var(--ad-warn)',bot:'var(--ad-bot)',technical:'var(--ad-tech)',held:'var(--ad-held)'};
 const get=id=>document.getElementById('ad-'+id);
 const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=String(text);if(cls)n.className=cls;return n;};
 const num=v=>Number.isSafeInteger(v)&&v>=0?v.toLocaleString('ar-EG'):'غير متاح';
 const icon=id=>{const ns='http://www.w3.org/2000/svg',svg=document.createElementNS(ns,'svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');for(const d of ICONS[id]??ICONS.new){const p=document.createElementNS(ns,'path');p.setAttribute('d',d);svg.appendChild(p);}return svg;};
 let selected='';
 for(const r of RULES){const tr=el('tr');tr.append(el('td',r.n),el('td',r.when),el('td',r.action));const td=el('td');td.append(el('span',r.stateLabel,'ad-pill '+r.state));tr.append(td);get('rules').append(tr);}
 function select(id){selected=id;for(const b of get('cats').querySelectorAll('.ad-cat'))b.setAttribute('aria-pressed',String(b.dataset.cat===id));const c=CATS.find(x=>x.id===id);get('hint').hidden=!c;get('hint').textContent=c?c.label+': '+c.hint:'';get('all').hidden=!id;window.dispatchEvent(new CustomEvent('viola-desk-category',{detail:id}));if(id)document.getElementById('ops-review-app')?.scrollIntoView({behavior:'smooth',block:'start'});}
 get('all').addEventListener('click',()=>select(''));
 function render(data){
  if(!data||data.ok!==true||!Array.isArray(data.reviewCases)){get('summary').textContent='تعذر تأكيد الأعداد؛ دي مش أصفار.';return;}
  const per=new Map();for(const r of data.reviewCases){if(!r||!/^\d+$/.test(String(r.orderId)))continue;const s=per.get(r.orderId)??[];s.push(String(r.category??'new'));per.set(r.orderId,s);}
  const counts=Object.fromEntries(ORDER.map(id=>[id,0]));for(const ids of per.values()){const p=ORDER.find(id=>ids.includes(id))??'new';counts[p]++;}
  const total=per.size,forAccountant=CATS.filter(c=>c.who==='accountant').reduce((a,c)=>a+counts[c.id],0),bot=CATS.filter(c=>c.who==='bot').reduce((a,c)=>a+counts[c.id],0);
  const s=get('summary');s.replaceChildren();s.append('فيه ',el('b',num(total)),' أوردر واقف. منهم ',el('b',num(forAccountant)),' محتاجين قرار المحاسب، و',el('b',num(bot)),' البوت هيكمّلهم لوحده.');
  const fin=(data.scheduler??[]).find(x=>x&&x.lane==='financial'),fmt=v=>{const d=new Date(v);return Number.isFinite(d.getTime())?new Intl.DateTimeFormat('ar-EG',{timeZone:'Africa/Cairo',hour:'2-digit',minute:'2-digit'}).format(d):null;};
  const at=fmt(data.generatedAt),next=fin?fmt(fin.nextAt):null;get('time').textContent=(at?'آخر قراية '+at:'')+(next?' — دورة الحسابات الجاية '+next:'');
  const stack=get('stack');stack.replaceChildren();const max=Math.max(1,...Object.values(counts));
  for(const c of CATS){if(!counts[c.id])continue;const seg=el('span');seg.style.width=(counts[c.id]/Math.max(1,total)*100)+'%';seg.style.background=COLOR[c.who];seg.title=c.label+': '+counts[c.id];stack.append(seg);}
  const box=get('cats');box.replaceChildren();
  for(const c of CATS){if(!counts[c.id]&&c.id!=='new')continue;const b=el('button',undefined,'ad-cat');b.type='button';b.dataset.cat=c.id;b.setAttribute('aria-pressed',String(selected===c.id));const ic=icon(c.id);ic.style.color=COLOR[c.who];
   b.append(ic,el('span',c.label),el('span',num(counts[c.id]),'n'),el('span',WHO[c.who],'who'));const tr=el('span',undefined,'ad-track'),f=el('span',undefined,'ad-fill');f.style.display='block';f.style.background=COLOR[c.who];tr.append(f);b.append(tr);
   requestAnimationFrame(()=>requestAnimationFrame(()=>{f.style.width=Math.max(2,counts[c.id]/max*100)+'%';}));
   b.addEventListener('click',()=>select(selected===c.id?'':c.id));box.append(b);}
 }
 window.addEventListener('viola-operations-snapshot',event=>render(event.detail));
 window.addEventListener('viola-operations-unavailable',()=>{get('summary').textContent='تعذر تحديث المصدر. الأعداد اللي ظاهرة مش حالة مؤكدة.';});
})();
`;
}
