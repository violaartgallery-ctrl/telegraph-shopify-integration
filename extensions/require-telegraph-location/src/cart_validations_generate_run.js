// @ts-check

/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

/**
 * Blocks checkout completion unless the Telegraph governorate + area are set on
 * the cart (the storefront picker writes them as cart attributes). Runs
 * server-side at checkout, so it can't be bypassed by express/dynamic checkout,
 * a direct /checkout URL, or disabled JavaScript — no order can be placed
 * without a real shipping zone.
 *
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  const governorate = (input.cart.governorateId?.value ?? "").trim();
  const area = (input.cart.areaId?.value ?? "").trim();

  const errors = [];
  if (!governorate || !area) {
    errors.push({
      // Shown to the buyer at checkout; keep it actionable in Arabic.
      message:
        "لازم تختار المحافظة والمنطقة (شركة الشحن) قبل إتمام الطلب. ارجع لصفحة السلة (Cart)، اختار المحافظة والمنطقة، وبعدين كمّل الطلب.",
      target: "$.cart",
    });
  }

  return {
    operations: [
      {
        validationAdd: {
          errors,
        },
      },
    ],
  };
}
