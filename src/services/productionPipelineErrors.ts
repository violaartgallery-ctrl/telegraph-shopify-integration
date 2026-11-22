export class SoftDeadlineError extends Error {
  constructor(public readonly progress: string) {
    super(progress);
    this.name = 'SoftDeadlineError';
  }
}

export class PermanentProductionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentProductionError';
  }
}

export interface PrintPhotoSource {
  orderName?: string;
  product?: string;
  photoNumber?: number;
}

/** A decoded source defect, never permission to omit the customer's image. */
export class PrintPhotoDecodeError extends PermanentProductionError {
  readonly code = 'PRINT_PHOTO_DECODE_ERROR';
  readonly source: Readonly<PrintPhotoSource>;
  readonly diagnostics: Readonly<{ primary: string; fallback: string }>;

  constructor(source: PrintPhotoSource = {}, diagnostics = { primary: '', fallback: '' }) {
    const clean = (value?: string) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 120);
    const order = clean(source.orderName), product = clean(source.product);
    const number = Number.isSafeInteger(source.photoNumber) && Number(source.photoNumber) > 0
      ? ` رقم ${source.photoNumber}` : '';
    super(`تعذّر قراءة صورة الطباعة${number}${order ? ` للأوردر ${order}` : ''}` +
      `${product ? ` (${product})` : ''}. الملف تالف أو غير مكتمل؛ مطلوب نسخة سليمة من نفس الصورة. ` +
      'لن يتم تخطّي الصورة أو السماح بـRun قبل المراجعة. [PRINT_PHOTO_DECODE_ERROR]');
    this.name = 'PrintPhotoDecodeError';
    this.source = Object.freeze({ ...source });
    this.diagnostics = Object.freeze({ primary: diagnostics.primary.slice(0, 500), fallback: diagnostics.fallback.slice(0, 500) });
  }
}

export function isTransientProductionError(error: unknown): boolean {
  if (error instanceof PermanentProductionError) return false;
  const message = String(error);
  return /timeout|timed out|abort|econn|socket|network|fetch failed|http 429|http 5\d\d|temporar|rate.?limit|p1001|p1002|p1008|p1017|connection/i.test(message);
}

export function isOrderDataReviewError(error: unknown): boolean {
  const message = String(error);
  return /missing telegraph|governorate|area selection|no customer phone|no shipping\/billing address|no active line items|not eligible|invalid.*(?:zone|area)|validation/i.test(message);
}
