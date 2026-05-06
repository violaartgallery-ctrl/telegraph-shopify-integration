import { env } from '../config/env.js';
import { LOGIN_MUTATION } from '../accurate/queries.js';

interface LoginResponse {
  login: {
    token: string;
    user: {
      id: number;
      username: string;
    };
  };
}

interface DropdownEntry {
  id?: number;
  code?: string;
  name?: string;
}

interface AccurateConfigResponse {
  services: DropdownEntry[];
  shipmentTypes: DropdownEntry[];
  paymentTypes: DropdownEntry[];
  zones: DropdownEntry[];
  subzones: DropdownEntry[];
}

const maskToken = (token: string): string => `${token.slice(0, 8)}...${token.slice(-4)}`;

const CONFIG_QUERY = `
  query AccurateConfigCheck($zoneId: Int) {
    services: listShippingServicesDropdown(input: { active: true }) {
      id
      code
      name
    }
    shipmentTypes: listShipmentTypesDropdown(mobileActive: true) {
      code
      name
    }
    paymentTypes: listPaymentTypesDropdown(input: {}) {
      code
      name
    }
    zones: listZonesDropdown(input: { active: true }) {
      id
      code
      name
    }
    subzones: listZonesDropdown(input: { active: true, parentId: $zoneId }) {
      id
      code
      name
    }
  }
`;

const requireMatch = (label: string, ok: boolean): void => {
  if (!ok) {
    throw new Error(`Accurate config check failed: ${label}`);
  }
};

const requestAccurate = async <T>(query: string, variables?: Record<string, unknown>, token?: string): Promise<T> => {
  const response = await fetch(env.accurate.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ query, variables })
  });
  const body = (await response.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (!response.ok || body.errors?.length || !body.data) {
    throw new Error(body.errors?.map((entry) => entry.message).join('; ') || `Accurate HTTP ${response.status}`);
  }
  return body.data;
};

const login = await requestAccurate<LoginResponse>(LOGIN_MUTATION, {
  input: {
    username: env.accurate.username,
    password: env.accurate.password,
    rememberMe: true
  }
});

const config = await requestAccurate<AccurateConfigResponse>(CONFIG_QUERY, {
  zoneId: env.accurate.senderZoneId ?? env.accurate.defaultRecipientZoneId
}, login.login.token);

requireMatch(
  `service ${env.accurate.defaultServiceId}`,
  config.services.some((entry) => entry.id === env.accurate.defaultServiceId)
);
requireMatch(
  `shipment type ${env.accurate.defaultShipmentType}`,
  config.shipmentTypes.some((entry) => entry.code === env.accurate.defaultShipmentType)
);
requireMatch(
  `payment type ${env.accurate.defaultPaymentType}`,
  config.paymentTypes.some((entry) => entry.code === env.accurate.defaultPaymentType)
);
requireMatch(
  `recipient zone ${env.accurate.defaultRecipientZoneId}`,
  config.zones.some((entry) => entry.id === env.accurate.defaultRecipientZoneId)
);
requireMatch(
  `recipient subzone ${env.accurate.defaultRecipientSubzoneId}`,
  config.subzones.some((entry) => entry.id === env.accurate.defaultRecipientSubzoneId)
);

console.log('Accurate config check succeeded');
console.log(`User: ${login.login.user.username} (${login.login.user.id})`);
console.log(`Token: ${maskToken(login.login.token)}`);
console.log(`Service: ${env.accurate.defaultServiceId}`);
console.log(`Shipment type: ${env.accurate.defaultShipmentType}`);
console.log(`Payment type: ${env.accurate.defaultPaymentType}`);
console.log(`Sender/default zone: ${env.accurate.defaultRecipientZoneId}/${env.accurate.defaultRecipientSubzoneId}`);
