import {
  addInternationalPhoneToShipmentNotes,
  isNonEgyptianInternationalPhone,
  normalizeRecipientPhone
} from '../services/recipientPhone.js';

const assertEqual = (actual: unknown, expected: unknown, name: string): void => {
  if (actual !== expected) {
    throw new Error(`${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
};

const cases = [
  ['Egypt local', '01123490784', 'EG', '+201123490784'],
  ['Egypt without trunk zero', '1123490784', 'EG', '+201123490784'],
  ['Egypt E.164', '+20 11 2349 0784', 'EG', '+201123490784'],
  ['Egypt duplicated trunk zero', '+20 011 2349 0784', 'EG', '+201123490784'],
  ['Saudi explicit E.164 on Egypt delivery', '+966 53 812 3456', 'EG', '+966538123456'],
  ['Saudi 00 prefix on Egypt delivery', '00966 53 812 3456', 'EG', '+966538123456'],
  ['Saudi bare country code on Egypt delivery', '966538123456', 'EG', '+966538123456'],
  ['Saudi local on Saudi delivery', '053 812 3456', 'SA', '+966538123456'],
  ['UAE local on UAE delivery', '050 123 4567', 'AE', '+971501234567'],
  ['Kuwait local on Kuwait delivery', '5509 1234', 'KW', '+96555091234'],
  ['Qatar local on Qatar delivery', '5512 3456', 'QA', '+97455123456'],
  ['Arabic digits', '+٩٦٦ ٥٣ ٨١٢ ٣٤٥٦', 'EG', '+966538123456'],
  ['Ambiguous foreign local number on Egypt delivery', '0538123456', 'EG', '0538123456']
] as const;

for (const [name, input, country, expected] of cases) {
  assertEqual(normalizeRecipientPhone(input, country), expected, name);
}

assertEqual(
  isNonEgyptianInternationalPhone('+966538123456'),
  true,
  'Saudi number is international for an Egypt shipment'
);
assertEqual(
  isNonEgyptianInternationalPhone('+201123490784'),
  false,
  'Egypt number does not need an international note fallback'
);
assertEqual(
  addInternationalPhoneToShipmentNotes('اتصل قبل الوصول', '+966538123456'),
  'Intl phone: +966538123456 | اتصل قبل الوصول',
  'International phone must be first in Telegraph printable notes'
);
assertEqual(
  addInternationalPhoneToShipmentNotes('اتصل قبل الوصول', '+201123490784'),
  'اتصل قبل الوصول',
  'Egypt phone must not change Shopify notes'
);
assertEqual(
  addInternationalPhoneToShipmentNotes(undefined, '+966538123456'),
  'Intl phone: +966538123456',
  'International phone must remain visible even without Shopify notes'
);

console.log(JSON.stringify({
  ok: true,
  phoneScenarios: cases.length,
  internationalWaybillFallback: true,
  senderFieldsTouched: false
}, null, 2));
