/**
 * DEBUG: Show raw Telegraph API response for login + getShipment
 */
import { env } from '../config/env.js';

const ENDPOINT = env.accurate.endpoint;

console.log('Endpoint:', ENDPOINT);
console.log('Username:', env.accurate.username);

// Step 1: Login
const loginMutation = `
  mutation AccurateLogin($input: LoginInput!) {
    login(input: $input) {
      token
      user {
        id
        username
      }
    }
  }
`;

const loginResp = await fetch(ENDPOINT, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: loginMutation,
    variables: {
      input: {
        username: env.accurate.username,
        password: env.accurate.password,
        rememberMe: true
      }
    }
  })
});

const loginBody = await loginResp.json() as any;
console.log('\n=== LOGIN RESPONSE ===');
console.log('Status:', loginResp.status, loginResp.statusText);
console.log('Body:', JSON.stringify(loginBody, null, 2));

const token = loginBody?.data?.login?.token;
if (!token) {
  console.log('❌ No token received — login failed');
  process.exit(1);
}
console.log('\n✅ Got token:', token.slice(0, 20) + '...');

// Step 2: getShipment with token
const getShipmentQuery = `
  query Shipment($id: Int, $code: String) {
    shipment(id: $id, code: $code) {
      id
      code
      status { code name }
    }
  }
`;

const shipmentResp = await fetch(ENDPOINT, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`
  },
  body: JSON.stringify({
    query: getShipmentQuery,
    variables: { id: 8946227 }
  })
});

const shipmentBody = await shipmentResp.json() as any;
console.log('\n=== GET SHIPMENT RESPONSE ===');
console.log('Status:', shipmentResp.status, shipmentResp.statusText);
console.log('Body:', JSON.stringify(shipmentBody, null, 2));
