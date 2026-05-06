import { env } from '../config/env.js';
import type { ShopifyLineItem, ShopifyOrder } from '../types/shopify.js';
import type { AccurateShipmentInput } from '../accurate/accurateClient.js';
import { AccurateZoneResolver } from '../accurate/zoneResolver.js';
import { getTelegraphLocationSelection } from './telegraphLocation.js';

const buildOrderReference = (order: ShopifyOrder): string => `${env.orderReferencePrefix}-${order.order_number}`;

const buildCustomerName = (order: ShopifyOrder): string => {
  const shippingName = order.shipping_address?.name;
  if (shippingName) return `${shippingName} | ${buildOrderReference(order)}`;
  const shippingParts = [order.shipping_address?.first_name, order.shipping_address?.last_name].filter(Boolean);
  if (shippingParts.length > 0) return `${shippingParts.join(' ')} | ${buildOrderReference(order)}`;
  const customerParts = [order.customer?.first_name, order.customer?.last_name].filter(Boolean);
  if (customerParts.length > 0) return `${customerParts.join(' ')} | ${buildOrderReference(order)}`;
  return `${order.email ?? `Shopify Order ${order.name}`} | ${buildOrderReference(order)}`;
};

const buildPhone = (order: ShopifyOrder): string => {
  return (
    order.shipping_address?.phone ??
    order.phone ??
    order.customer?.phone ??
    order.billing_address?.phone ??
    ''
  ).trim();
};

const isCashOnDelivery = (order: ShopifyOrder): boolean => {
  const gateways = order.payment_gateway_names?.join(' ').toLowerCase() ?? '';
  return /cash|cod/.test(gateways) || order.gateway?.toLowerCase() === 'cash_on_delivery';
};

const itemQuantity = (item: ShopifyLineItem): number =>
  item.current_quantity ?? item.quantity;

const activeLineItems = (lineItems: ShopifyLineItem[]): ShopifyLineItem[] =>
  lineItems.filter((item) => itemQuantity(item) > 0);

const buildAddress = (order: ShopifyOrder): string => {
  const address = order.shipping_address ?? order.billing_address;
  const parts = [
    address?.address1,
    address?.address2
  ].filter(Boolean);
  return parts.join(', ');
};

const buildProductsSummary = (lineItems: ShopifyLineItem[]): string =>
  lineItems
    .map((item) => {
      const variant = item.variant_title ? ` - ${item.variant_title}` : '';
      return `${item.title}${variant} x${itemQuantity(item)} - Price: ${item.price}`;
    })
    .join('\n');

const buildShipmentDescription = (order: ShopifyOrder): string =>
  buildProductsSummary(activeLineItems(order.line_items));

const buildPiecesCount = (order: ShopifyOrder): number =>
  activeLineItems(order.line_items).reduce((total, item) => total + itemQuantity(item), 0);

const buildShipmentProducts = (lineItems: ShopifyLineItem[]) => {
  const entries = activeLineItems(lineItems).flatMap((item) => {
    const sku = item.sku?.trim();
    const accurateProductId = sku ? env.accurate.productIdMap[sku] : undefined;
    if (!accurateProductId) return [];

    return [
      {
        productId: accurateProductId,
        quantity: itemQuantity(item),
        price: Number.parseFloat(item.price),
        typeCode: env.accurate.defaultProductTypeCode
      }
    ];
  });

  if (entries.length === 0) {
    return undefined;
  }

  return entries;
};

export class AccurateMapper {
  constructor(private readonly zoneResolver: AccurateZoneResolver) {}

  async mapOrderToShipment(
    order: ShopifyOrder,
    options?: { requireTelegraphLocation?: boolean; shipmentCode?: string }
  ): Promise<AccurateShipmentInput> {
    const phone = buildPhone(order);
    if (!phone) {
      throw new Error(`Order ${order.name} has no customer phone number`);
    }

    const recipientAddress = buildAddress(order);
    if (!recipientAddress) {
      throw new Error(`Order ${order.name} has no shipping/billing address`);
    }

    const telegraphLocation = getTelegraphLocationSelection(order);
    if (options?.requireTelegraphLocation && !telegraphLocation) {
      throw new Error(`Order ${order.name} is missing Telegraph governorate/area selection`);
    }

    const zones = await this.zoneResolver.resolve({
      zoneId: telegraphLocation?.governorateId,
      subzoneId: telegraphLocation?.areaId,
      city: order.shipping_address?.city,
      area: order.shipping_address?.address2,
      province: order.shipping_address?.province
    });

    const shipmentProducts = buildShipmentProducts(order.line_items);
    const cod = isCashOnDelivery(order);
    const totalPrice = Number.parseFloat(order.total_outstanding ?? order.current_total_price ?? order.total_price);
    const orderReference = buildOrderReference(order);
    const productDescription = buildShipmentDescription(order);
    const piecesCount = buildPiecesCount(order);

    if (piecesCount <= 0) {
      throw new Error(`Order ${order.name} has no active line items to ship`);
    }

    return {
      code: options?.shipmentCode,
      recipientName: buildCustomerName(order),
      recipientAddress,
      recipientPhone: phone,
      recipientMobile: phone,
      recipientZoneId: zones.zoneId,
      recipientSubzoneId: zones.subzoneId,
      serviceId: env.accurate.defaultServiceId ?? 1,
      refNumber: orderReference,
      notes: undefined,
      description: productDescription || `Shopify order ${order.name}`,
      piecesCount,
      typeCode: env.accurate.defaultShipmentType,
      paymentTypeCode: env.accurate.defaultPaymentType,
      priceTypeCode: env.accurate.defaultPriceType,
      price: cod ? totalPrice : 0,
      weight: env.accurate.defaultWeight,
      openableCode: env.accurate.defaultOpenableCode,
      senderName: env.accurate.senderName,
      senderPhone: env.accurate.senderPhone,
      senderMobile: env.accurate.senderMobile,
      senderAddress: env.accurate.senderAddress,
      senderPostalCode: env.accurate.senderPostalCode,
      senderZoneId: env.accurate.senderZoneId,
      senderSubzoneId: env.accurate.senderSubzoneId,
      shipmentProducts
      // TODO: Accurate's schema only documents ShipmentProductInput.productId, quantity, price, and typeCode.
      // TODO: The docs do not document a product lookup query or a title/SKU field on ShipmentProductInput.
      // TODO: This mapper supports SKU -> Accurate product id via ACCURATE_PRODUCT_ID_MAP_JSON; otherwise items are preserved in notes/description.
      // TODO: Accurate product details require an Accurate product id; Shopify title/SKU text is preserved in notes/description when no product id map is configured.
      // TODO: customerId, branchId, and originBranchId exist in the schema but are forbidden for the current customer account token.
    };
  }
}
