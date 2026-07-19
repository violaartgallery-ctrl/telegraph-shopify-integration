// @ts-check

import { VALID_TELEGRAPH_LOCATION_PAIRS } from "./generated_location_pairs.js";

/**
 * @typedef {import("../generated/api").CartValidationsGenerateRunInput} CartValidationsGenerateRunInput
 * @typedef {import("../generated/api").CartValidationsGenerateRunResult} CartValidationsGenerateRunResult
 */

/**
 * Blocks checkout unless the Telegraph governorate + area form a valid pair.
 * The storefront picker writes the IDs as cart attributes, while this Function
 * enforces the same location catalogue server-side for every checkout path.
 *
 * @param {CartValidationsGenerateRunInput} input
 * @returns {CartValidationsGenerateRunResult}
 */
export function cartValidationsGenerateRun(input) {
  const step = input.buyerJourney.step;
  if (step !== "CHECKOUT_INTERACTION" && step !== "CHECKOUT_COMPLETION") {
    return { operations: [] };
  }

  const governorate = (input.cart.governorateId?.value ?? "").trim();
  const area = (input.cart.areaId?.value ?? "").trim();
  const pair = `${governorate}:${area}`;
  const isValidPair =
    /^\d+$/.test(governorate) &&
    /^\d+$/.test(area) &&
    VALID_TELEGRAPH_LOCATION_PAIRS.includes(pair);

  const errors = [];
  if (!isValidPair) {
    errors.push({
      message:
        "لازم تختار المحافظة والمنطقة الصحيحتين قبل إتمام الطلب. ارجع إلى السلة، اختار بيانات الشحن، ثم كمّل الطلب.",
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
