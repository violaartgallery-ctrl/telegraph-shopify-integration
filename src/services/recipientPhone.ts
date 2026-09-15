const ARABIC_INDIC_ZERO = '٠'.charCodeAt(0);
const EASTERN_ARABIC_INDIC_ZERO = '۰'.charCodeAt(0);

interface CountryPhonePlan {
  callingCode: string;
  nationalLengths: readonly number[];
}

// These are the storefront's active Egypt/Gulf markets. Explicit +/00
// international numbers are handled generically for every other country too.
const COUNTRY_PHONE_PLANS: Readonly<Record<string, CountryPhonePlan>> = {
  EG: { callingCode: '20', nationalLengths: [10] },
  SA: { callingCode: '966', nationalLengths: [9] },
  AE: { callingCode: '971', nationalLengths: [9] },
  KW: { callingCode: '965', nationalLengths: [8] },
  QA: { callingCode: '974', nationalLengths: [8] },
  BH: { callingCode: '973', nationalLengths: [8] },
  OM: { callingCode: '968', nationalLengths: [8] }
};

const KNOWN_CALLING_CODES = [...new Set(Object.values(COUNTRY_PHONE_PLANS).map((plan) => plan.callingCode))]
  .sort((left, right) => right.length - left.length);

const toAsciiDigits = (value: string): string =>
  [...value].map((character) => {
    const code = character.charCodeAt(0);
    if (code >= ARABIC_INDIC_ZERO && code <= ARABIC_INDIC_ZERO + 9) {
      return String(code - ARABIC_INDIC_ZERO);
    }
    if (code >= EASTERN_ARABIC_INDIC_ZERO && code <= EASTERN_ARABIC_INDIC_ZERO + 9) {
      return String(code - EASTERN_ARABIC_INDIC_ZERO);
    }
    return character;
  }).join('');

const digitsOnly = (value: string): string => value.replace(/\D/g, '');

const canonicalInternational = (digits: string): string => {
  const callingCode = KNOWN_CALLING_CODES.find((candidate) => digits.startsWith(candidate));
  if (!callingCode) return `+${digits}`;

  // Some customers write the domestic trunk zero after the country code
  // (for example +20 010... or +966 05...). E.164 omits that zero.
  const national = digits.slice(callingCode.length);
  return `+${callingCode}${national.startsWith('0') ? national.slice(1) : national}`;
};

/**
 * Produce the phone value sent to Telegraph without guessing a foreign country.
 *
 * - Explicit +CC and 00CC inputs keep their real country code.
 * - Egypt/Gulf local formats use the Shopify address country when it is known.
 * - A Gulf code written without + (for example 9665...) is still preserved.
 * - Ambiguous domestic-looking values on an Egypt address are left unchanged.
 */
export const normalizeRecipientPhone = (
  rawPhone: string,
  addressCountryCode?: string | null
): string => {
  const raw = toAsciiDigits(rawPhone).trim();
  if (!raw) return '';

  const digits = digitsOnly(raw);
  if (!digits) return raw;

  if (raw.startsWith('+')) {
    return canonicalInternational(digits);
  }

  if (digits.startsWith('00') && digits.length > 2) {
    return canonicalInternational(digits.slice(2));
  }

  const bareCallingCode = KNOWN_CALLING_CODES.find((candidate) =>
    digits.startsWith(candidate) && digits.length >= candidate.length + 7
  );
  if (bareCallingCode) {
    return canonicalInternational(digits);
  }

  const countryCode = addressCountryCode?.trim().toUpperCase();
  const plan = countryCode ? COUNTRY_PHONE_PLANS[countryCode] : undefined;
  if (plan) {
    const national = digits.startsWith('0') ? digits.slice(1) : digits;
    if (plan.nationalLengths.includes(national.length)) {
      return `+${plan.callingCode}${national}`;
    }
  }

  // Shopify webhooks can occasionally omit the address country even though
  // the domestic Egyptian mobile pattern is still unambiguous.
  const egyptNational = digits.startsWith('0') ? digits.slice(1) : digits;
  if (/^1[0125]\d{8}$/.test(egyptNational)) {
    return `+20${egyptNational}`;
  }

  // Keep an ambiguous number unchanged instead of inventing a country code.
  return raw.replace(/\s+/g, ' ');
};

export const isNonEgyptianInternationalPhone = (phone: string): boolean =>
  /^\+[1-9]\d{7,14}$/.test(phone) && !phone.startsWith('+20');

/**
 * Telegraph currently rewrites an international recipient phone to a domestic
 * display format. Put the E.164 number first in the printable one-line notes as
 * a lossless fallback, while keeping the original Shopify note intact.
 */
export const addInternationalPhoneToShipmentNotes = (
  flattenedShopifyNote: string | undefined,
  recipientPhone: string
): string | undefined => {
  const phonePrefix = isNonEgyptianInternationalPhone(recipientPhone)
    ? `Intl phone: ${recipientPhone}`
    : undefined;

  return [phonePrefix, flattenedShopifyNote].filter(Boolean).join(' | ') || undefined;
};
