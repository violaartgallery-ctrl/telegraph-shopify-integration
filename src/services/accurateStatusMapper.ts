export interface ShopifyShipmentProjection {
  shipmentStatus: string;
  collectionStatus: string;
  tags: string[];
  isTerminal: boolean;
}

const terminalStatusCodes = new Set([
  'DTR',
  'RTRN',
  'RTS',
  'RJCT',
  'DEX',
  'PRPD'
]);

const deliveredStatusCodes = new Set(['DTR']);
const returnedStatusCodes = new Set(['RTRN', 'RTS', 'RJCT']);

export const projectAccurateStatusToShopify = (input: {
  statusCode?: string | null;
  statusName?: string | null;
  returnStatusCode?: string | null;
  returnStatusName?: string | null;
  collected?: boolean;
  paidToCustomer?: boolean;
  cancelled?: boolean;
}): ShopifyShipmentProjection => {
  const statusCode = input.statusCode?.toUpperCase() ?? '';
  const returnStatusCode = input.returnStatusCode?.toUpperCase() ?? '';
  const shipmentStatus =
    input.statusName ??
    input.returnStatusName ??
    input.statusCode ??
    input.returnStatusCode ??
    'UNKNOWN';

  let collectionStatus = 'pending';
  const tags = ['accurate'];

  if (input.cancelled || statusCode === 'DEX') {
    tags.push('accurate-cancelled');
    collectionStatus = 'cancelled';
  } else if (deliveredStatusCodes.has(statusCode)) {
    tags.push('accurate-delivered');
    collectionStatus = input.collected ? 'collected' : 'delivered-not-collected';
    tags.push(input.collected ? 'accurate-collected' : 'accurate-delivered-not-collected');
  } else if (returnedStatusCodes.has(statusCode) || returnedStatusCodes.has(returnStatusCode)) {
    tags.push('accurate-returned');
    collectionStatus = input.paidToCustomer ? 'returned-settled' : 'returned';
    tags.push(input.paidToCustomer ? 'accurate-returned-settled' : 'accurate-returned-unsettled');
  } else if (statusCode === 'OTD') {
    tags.push('accurate-out-for-delivery');
  } else if (statusCode === 'RCV') {
    tags.push('accurate-received');
  } else if (statusCode === 'STD') {
    tags.push('accurate-scheduled');
  } else {
    tags.push(`accurate-${(statusCode || 'unknown').toLowerCase()}`);
  }

  return {
    shipmentStatus,
    collectionStatus,
    tags,
    isTerminal: terminalStatusCodes.has(statusCode) || terminalStatusCodes.has(returnStatusCode)
  };
};

export const isTerminalAccurateStatus = (statusCode?: string | null, returnStatusCode?: string | null): boolean =>
  terminalStatusCodes.has(statusCode?.toUpperCase() ?? '') || terminalStatusCodes.has(returnStatusCode?.toUpperCase() ?? '');
