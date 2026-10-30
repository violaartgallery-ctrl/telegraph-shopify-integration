// @ts-check

/**
 * @typedef {import("../generated/api").CartPaymentMethodsTransformRunInput} CartPaymentMethodsTransformRunInput
 * @typedef {import("../generated/api").CartPaymentMethodsTransformRunResult} CartPaymentMethodsTransformRunResult
 */

/**
 * @type {CartPaymentMethodsTransformRunResult}
 */
const NO_CHANGES = {
  operations: [],
};

const COD_ENABLED_COUNTRY_CODES = new Set([
  "EG", // Egypt
]);
const COD_NAME_PATTERNS = [
  /cash\s*on\s*delivery/i,
  /\bcod\b/i,
  /الدفع\s+(?:نقد[ًاا]?\s+)?عند\s+(?:الاستلام|التوصيل)/i,
  /نقد[ًاا]?\s+عند\s+(?:الاستلام|التوصيل)/i,
];

/**
 * @param {string} name
 * @returns {boolean}
 */
function isCashOnDelivery(name) {
  return COD_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

/**
 * @param {CartPaymentMethodsTransformRunInput} input
 * @returns {CartPaymentMethodsTransformRunResult}
 */
export function cartPaymentMethodsTransformRun(input) {
  const countryCodes = new Set(
    (input.cart?.deliveryGroups ?? [])
      .map((group) => group.deliveryAddress?.countryCode)
      .filter(Boolean)
      .map((countryCode) => String(countryCode).toUpperCase())
  );

  // Multiple delivery countries are ambiguous, so leave checkout untouched.
  if (countryCodes.size > 1) {
    return NO_CHANGES;
  }

  // Before the buyer finishes the address, use the active Shopify Market so
  // the preferred method is ordered before Shopify chooses a default. Once a
  // delivery country exists, it is authoritative.
  const [deliveryCountryCode] = countryCodes;
  const shippingCountryCode = deliveryCountryCode
    ?? String(input.localization?.country?.isoCode ?? "").toUpperCase();

  if (!shippingCountryCode) {
    return NO_CHANGES;
  }

  if (COD_ENABLED_COUNTRY_CODES.has(shippingCountryCode)) {
    const codIndex = (input.paymentMethods ?? []).findIndex((method) =>
      isCashOnDelivery(method.name ?? "")
    );

    // Shopify preselects the first payment method. Put COD first for Egyptian
    // checkouts so card payment does not look mandatory to COD buyers.
    if (codIndex <= 0) {
      return NO_CHANGES;
    }

    return {
      operations: [
        {
          paymentMethodMove: {
            paymentMethodId: input.paymentMethods[codIndex].id,
            index: 0,
          },
        },
      ],
    };
  }

  return {
    operations: (input.paymentMethods ?? [])
      .filter((method) => isCashOnDelivery(method.name ?? ""))
      .map((method) => ({
        paymentMethodHide: {
          paymentMethodId: method.id,
        },
      })),
  };
}
