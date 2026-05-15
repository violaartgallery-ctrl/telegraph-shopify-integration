export interface ShopifyAddress {
  first_name?: string | null;
  last_name?: string | null;
  name?: string | null;
  address1?: string | null;
  address2?: string | null;
  city?: string | null;
  province?: string | null;
  province_code?: string | null;
  zip?: string | null;
  country?: string | null;
  country_code?: string | null;
  phone?: string | null;
  company?: string | null;
}

export interface ShopifyLineItem {
  id: number;
  title: string;
  sku: string | null;
  quantity: number;
  current_quantity?: number | null;
  price: string;
  variant_title?: string | null;
  product_id?: number | null;
  discount_allocations?: Array<{
    amount: string;
  }>;
  properties?: Array<{ name: string; value: string }> | null;
}

export interface ShopifyNoteAttribute {
  name?: string | null;
  key?: string | null;
  value?: string | null;
}

export interface ShopifyOrder {
  id: number;
  admin_graphql_api_id?: string;
  name: string;
  order_number: number;
  financial_status?: string | null;
  fulfillment_status?: string | null;
  confirmed?: boolean | null;
  note?: string | null;
  tags?: string;
  total_price: string;
  total_outstanding?: string;
  current_total_price?: string;
  total_discounts?: string | null;
  currency?: string | null;
  discount_codes?: Array<{ code: string; amount: string; type: string }> | null;
  gateway?: string | null;
  payment_gateway_names?: string[];
  test?: boolean;
  email?: string | null;
  phone?: string | null;
  shipping_address?: ShopifyAddress | null;
  billing_address?: ShopifyAddress | null;
  customer?: {
    first_name?: string | null;
    last_name?: string | null;
    phone?: string | null;
    email?: string | null;
  } | null;
  line_items: ShopifyLineItem[];
  note_attributes?: ShopifyNoteAttribute[];
}

export interface AccurateShipmentStatusCallback {
  shipmentId?: number;
  shipmentCode?: string;
  refNumber?: string;
  externalReference?: string;
  status?: string | { code?: string; name?: string };
  [key: string]: unknown;
}
