export interface ShopifyShipmentProjection {
  shipmentStatus: string;
  collectionStatus: string;
  tags: string[];
  isTerminal: boolean;
}

const terminalStatusCodes = new Set([
  'RTRN',
  'RTS',
  'RJCT',
  'PRPD'
]);

const deliveredStatusCodes = new Set(['DTR']);
const returnedStatusCodes = new Set(['RTRN', 'RTS', 'RJCT']);
const receivedStatusCodes = new Set(['RCV', 'RITS']);
const branchMovementStatusCodes = new Set(['BMR', 'BMT', 'STD']);
const pickupStatusCodes = new Set(['PKR', 'PKM', 'PKH', 'PKD', 'PRP']);
const deliveryExceptionStatusCodes = new Set(['DEX', 'HTR']);
const returnInProgressStatusCodes = new Set(['OTR']);

export const projectAccurateStatusToShopify = (input: {
  statusCode?: string | null;
  statusName?: string | null;
  returnStatusCode?: string | null;
  returnStatusName?: string | null;
  collected?: boolean;
  paidToCustomer?: boolean;
  cancelled?: boolean;
  customerDue?: number | null;
}): ShopifyShipmentProjection => {
  const statusCode = input.statusCode?.toUpperCase() ?? '';
  const returnStatusCode = input.returnStatusCode?.toUpperCase() ?? '';
  const customerDue = Number(input.customerDue ?? 0);
  const shipmentStatus =
    input.statusName ??
    input.returnStatusName ??
    input.statusCode ??
    input.returnStatusCode ??
    'UNKNOWN';

  let collectionStatus = 'pending';
  const tags = ['accurate'];

  // Explicit carrier return truth wins over both an older DTR status and a
  // cancelled flag. Telegraph can legitimately report RTRN + cancelled after
  // the parcel has travelled back; treating that as a plain cancellation would
  // skip the return charge and Shopify return action.
  if (returnedStatusCodes.has(statusCode) || returnedStatusCodes.has(returnStatusCode)) {
    tags.push('accurate-returned');
    if (input.cancelled) tags.push('accurate-cancelled');
    collectionStatus = input.paidToCustomer ? 'returned-settled' : 'returned';
    tags.push(input.paidToCustomer ? 'accurate-returned-settled' : 'accurate-returned-unsettled');
  } else if (input.cancelled) {
    tags.push('accurate-cancelled');
    collectionStatus = 'cancelled';
  } else if (deliveredStatusCodes.has(statusCode) && customerDue < 0) {
    tags.push('accurate-delivered', 'accurate-payment-review');
    collectionStatus = 'payment-review';
  } else if (deliveredStatusCodes.has(statusCode)) {
    tags.push('accurate-delivered');
    collectionStatus = input.collected ? 'collected' : 'delivered-not-collected';
    tags.push(input.collected ? 'accurate-collected' : 'accurate-delivered-not-collected');
  } else if (statusCode === 'OTD') {
    tags.push('accurate-out-for-delivery');
  } else if (deliveryExceptionStatusCodes.has(statusCode)) {
    tags.push(statusCode === 'HTR' ? 'accurate-redelivery-pending' : 'accurate-delivery-exception');
  } else if (returnInProgressStatusCodes.has(statusCode)) {
    tags.push('accurate-return-in-transit');
  } else if (receivedStatusCodes.has(statusCode)) {
    tags.push('accurate-received');
  } else if (branchMovementStatusCodes.has(statusCode)) {
    tags.push('accurate-scheduled');
  } else if (pickupStatusCodes.has(statusCode)) {
    tags.push(`accurate-${statusCode.toLowerCase()}`);
  } else {
    tags.push(`accurate-${(statusCode || 'unknown').toLowerCase()}`);
  }

  const isTerminal =
    collectionStatus === 'cancelled' ||
    collectionStatus === 'collected' ||
    collectionStatus === 'payment-review' ||
    collectionStatus === 'returned' ||
    collectionStatus === 'returned-settled' ||
    terminalStatusCodes.has(statusCode) ||
    terminalStatusCodes.has(returnStatusCode);

  return {
    shipmentStatus,
    collectionStatus,
    tags,
    isTerminal
  };
};

export const isTerminalAccurateStatus = (input: {
  statusCode?: string | null;
  returnStatusCode?: string | null;
  collected?: boolean;
  paidToCustomer?: boolean;
  cancelled?: boolean;
}): boolean =>
  projectAccurateStatusToShopify(input).isTerminal;
