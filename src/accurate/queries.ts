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
      deliveryFees
      returnFees
      returningDueFees
      customerDue
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

export const LIST_PAYMENTS_QUERY = `
  query ListPayments($input: ListPaymentFilterInput!, $first: Int!, $page: Int) {
    listPayments(input: $input, first: $first, page: $page) {
      paginatorInfo {
        total
        count
        currentPage
        lastPage
        hasMorePages
      }
      data {
        id
        code
        date
        approved
        glApproved
        paymentAmount
        deliveredAmount
        collectedFees
        customer {
          id
          name
          code
        }
      }
    }
  }
`;

// Lists ALL shipments (works even when getShipment is unauthorized for this account).
// Used by the collection-from-reports sync to detect collected shipments reliably.
export const LIST_SHIPMENTS_QUERY = `
  query ListShipments($input: ListShipmentsFilterInput, $first: Int!, $page: Int) {
    listShipments(input: $input, first: $first, page: $page) {
      paginatorInfo {
        hasMorePages
        currentPage
        lastPage
        total
      }
      data {
        id
        code
        refNumber
        deliveredOrReturnedDate
        collected
        paidToCustomer
        cancelled
        trackingUrl
        collectedAmount
        pendingCollectionAmount
        returnedValue
        deliveryFees
        returnFees
        returningDueFees
        customerDue
        status { code name }
        returnStatus { code name }
      }
    }
  }
`;

export const LIST_SHIPMENTS_FOR_PAYMENT_QUERY = `
  query ListShipmentsForPayment($id: Int!, $first: Int!, $page: Int) {
    listShipmentsForPayment(id: $id, first: $first, page: $page) {
      paginatorInfo {
        total
        count
        currentPage
        lastPage
        hasMorePages
      }
      data {
        amount
        shipment {
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
          deliveryFees
          returnFees
          returningDueFees
          customerDue
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
    }
  }
`;
