import type { ShopifyOrder } from '../types/shopify.js';

export const telegraphLocationKeys = {
  governorateId: 'Telegraph Governorate ID',
  governorate: 'Telegraph Governorate',
  areaId: 'Telegraph Area ID',
  area: 'Telegraph Area'
} as const;

const normalizeKey = (value?: string | null): string => (value ?? '').trim().toLowerCase();

export interface TelegraphLocationSelection {
  governorateId: number;
  governorate?: string;
  areaId: number;
  area?: string;
}

export const getOrderAttribute = (order: ShopifyOrder, key: string): string | undefined => {
  const wanted = normalizeKey(key);
  const entry = order.note_attributes?.find((attribute) =>
    normalizeKey(attribute.name ?? attribute.key) === wanted
  );
  return entry?.value?.trim() || undefined;
};

export const getTelegraphLocationSelection = (order: ShopifyOrder): TelegraphLocationSelection | undefined => {
  const governorateId = Number.parseInt(getOrderAttribute(order, telegraphLocationKeys.governorateId) ?? '', 10);
  const areaId = Number.parseInt(getOrderAttribute(order, telegraphLocationKeys.areaId) ?? '', 10);

  if (Number.isNaN(governorateId) || Number.isNaN(areaId)) {
    return undefined;
  }

  return {
    governorateId,
    governorate: getOrderAttribute(order, telegraphLocationKeys.governorate),
    areaId,
    area: getOrderAttribute(order, telegraphLocationKeys.area)
  };
};

export const withTelegraphLocationSelection = (
  order: ShopifyOrder,
  selection: TelegraphLocationSelection
): ShopifyOrder => ({
  ...order,
  note_attributes: [
    ...(order.note_attributes ?? []).filter((attribute) => {
      const key = normalizeKey(attribute.name ?? attribute.key);
      return !Object.values(telegraphLocationKeys).some((known) => normalizeKey(known) === key);
    }),
    { name: telegraphLocationKeys.governorateId, value: String(selection.governorateId) },
    { name: telegraphLocationKeys.governorate, value: selection.governorate ?? '' },
    { name: telegraphLocationKeys.areaId, value: String(selection.areaId) },
    { name: telegraphLocationKeys.area, value: selection.area ?? '' }
  ]
});
