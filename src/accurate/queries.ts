export const LOGIN_MUTATION = `
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

export const SAVE_SHIPMENT_MUTATION = `
  mutation SaveShipment($input: ShipmentInput!) {
    saveShipment(input: $input) {
      id
      code
      refNumber
      notes
      price
      amount
      status {
        code
        name
      }
      recipientZone {
        id
        name
      }
      recipientSubzone {
        id
        name
      }
    }
  }
`;

export const LIST_ZONES_QUERY = `
  query ListZonesDropdown($input: ListZonesFilterInput) {
    listZonesDropdown(input: $input) {
      id
      name
      code
    }
  }
`;

export const GET_SHIPMENT_QUERY = `
  query Shipment($id: Int, $code: String) {
    shipment(id: $id, code: $code) {
      id
      code
      refNumber
      deliveredOrReturnedDate
      collected
      paidToCustomer
      paidToDeliveryAgent
      cancelled
      trackingUrl
      collectedAmount
      pendingCollectionAmount
      returnedValue
      status {
        code
        name
      }
      returnStatus {
        code
        name
      }
    }
  }
`;
