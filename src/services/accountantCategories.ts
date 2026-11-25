/**
 * Accountant desk categories (owner, 2026-11-25). Pure display grouping of the
 * existing review cases: it never changes what a decision may do. Order matters:
 * the first matching category wins, and the most restrictive come first.
 */
export interface AccountantCategory { id: string; label: string; who: 'accountant' | 'bot' | 'technical' | 'held'; hint: string }

export const ACCOUNTANT_CATEGORIES: AccountantCategory[] = [
  { id: 'held', label: 'محجوز من فترة الاسترجاع', who: 'held', hint: 'متساب عن قصد. مافيش قرار مطلوب دلوقتي، ومافيش حاجة بتتعمل فيه لوحدها.' },
  { id: 'uncertain', label: 'محاولة سابقة مش مؤكدة', who: 'technical', hint: 'ممكن يكون فيه مستند اتعمل قبل كده. لازم مطابقة فنية قبل أي حاجة، ومافيش تكرار.' },
  { id: 'no_waybill', label: 'بوليصة مش في تليجراف', who: 'accountant', hint: 'البوليصة مش ظاهرة عند تليجراف. قولّنا الأوردر اتشحن إزاي واتحصّل ولا لأ.' },
  { id: 'clones', label: 'نسخ حادثة 4 نوفمبر', who: 'accountant', hint: 'نسخ اتعملت بعد الإلغاء بالغلط. لازم نتأكد إن مافيش أمر بيع قديم قبل التسجيل.' },
  { id: 'partial', label: 'استلام جزئي أو نقص كبير', who: 'accountant', hint: 'العميل دفع أقل بفرق كبير أو رجّع جزء. حدد القطعة اللي رجعت أو اعتمد الخصم.' },
  { id: 'money', label: 'فرق في الفلوس', who: 'accountant', hint: 'المبلغ المحصّل مختلف عن الأوردر، أو اتدفع مرتين، أو فيه مستند قديم مختلف.' },
  { id: 'return_money', label: 'مرتجع فيه فلوس', who: 'accountant', hint: 'الأوردر رجع وفيه مبلغ اتحصّل أو اتدفع. حدد هل هو رسوم شحن ولا فلوس ترجع للعميل.' },
  { id: 'changed', label: 'الأوردر اتغير بعد الشحن', who: 'accountant', hint: 'المنتج أو السعر اتغير بعد الشحن. اختار النسخة الصحيحة للحسابات.' },
  { id: 'auto', label: 'البوت هيكمّلها لوحده', who: 'bot', hint: 'أرقام تليجراف اتغيرت بعد أول قراية. البوت بيرجع يراجعها لوحده لما تستقر.' },
  { id: 'new', label: 'سيناريو جديد', who: 'accountant', hint: 'حالة البوت مايعرفش يتصرف فيها. قرارك هنا بيتحول لقاعدة جديدة.' },
];

const byId = new Map(ACCOUNTANT_CATEGORIES.map(c => [c.id, c]));
export const accountantCategory = (id: string): AccountantCategory => byId.get(id) ?? byId.get('new')!;

/** Map one review case (reason text + dashboard classification) to a category id. */
export function categorizeReviewCase(input: { reason?: unknown; classification?: unknown; lane?: unknown }): string {
  const reason = String(input.reason ?? '');
  const classification = String(input.classification ?? '');
  if (/Owner-excluded recovery case|restored-20261104/i.test(reason)) return 'clones';
  if (classification === 'durable-hold' || /PRIMARY_LINK_RECONCILIATION|PRIMARY_RECONCILIATION_READINESS_HOLD|OWNER_ODOO_ONLY_EXCEPTION|STATE_PARITY/.test(reason)) return 'held';
  if (classification === 'uncertain-claim' || /AUTOMATION_OUTCOME_REVIEW|may already exist|outcome unknown|independent review required/i.test(reason)) return 'uncertain';
  if (/not visible|Historical waybill/i.test(reason)) return 'no_waybill';
  if (/OWNER_PARTIAL_DELIVERY|partial delivery/i.test(reason)) return 'partial';
  if (/Collected\/unknown return money|Paid\/refunded Shopify return|Return stock\/invoice decision|Return Sales Order link/i.test(reason)) return 'return_money';
  if (/Current carrier (?:collection|payment|return) facts changed/.test(reason)) return 'auto';
  if (/Accounting money\/products\/address\/customization changed/.test(reason)) return 'changed';
  if (/Current Shopify payment\/collection differs|needs-discount|amount-exceeds-order-total|paid return charge|negative carrier customerDue|shopify-outstanding|Odoo-only invoice requires|Shopify payment status changed/i.test(reason)) return 'money';
  return 'new';
}

/** One primary category per order: the most restrictive of its review rows. */
export function primaryCategory(ids: string[]): string {
  for (const c of ACCOUNTANT_CATEGORIES) if (ids.includes(c.id)) return c.id;
  return 'new';
}
