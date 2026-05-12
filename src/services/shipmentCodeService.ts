import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';

const sequenceName = 'accurate-shipment-code';

const formatCode = (value: number): string =>
  `${env.shipmentCodePrefix ?? ''}${String(value).padStart(7, '0')}`;

export const shipmentCodeService = {
  reserveForOrder: async (shopifyOrderId: string): Promise<string | undefined> => {
    if (!env.shipmentCodePrefix) {
      return undefined;
    }

    return await prisma.$transaction(async (transaction) => {
      const existingRecord = await transaction.shipmentRecord.findUnique({
        where: { shopifyOrderId }
      });

      if (existingRecord?.plannedShipmentCode) {
        return existingRecord.plannedShipmentCode;
      }

      await transaction.shipmentSequence.upsert({
        where: { name: sequenceName },
        update: {},
        create: {
          name: sequenceName,
          nextValue: env.shipmentCodeStart
        }
      });

      const updatedSequence = await transaction.shipmentSequence.update({
        where: { name: sequenceName },
        data: {
          nextValue: {
            increment: 1
          }
        }
      });

      const code = formatCode(updatedSequence.nextValue - 1);

      await transaction.shipmentRecord.update({
        where: { shopifyOrderId },
        data: { plannedShipmentCode: code }
      });

      return code;
    });
  },

  reserveFreshForOrder: async (shopifyOrderId: string): Promise<string | undefined> => {
    if (!env.shipmentCodePrefix) {
      return undefined;
    }

    return await prisma.$transaction(async (transaction) => {
      await transaction.shipmentSequence.upsert({
        where: { name: sequenceName },
        update: {},
        create: {
          name: sequenceName,
          nextValue: env.shipmentCodeStart
        }
      });

      const updatedSequence = await transaction.shipmentSequence.update({
        where: { name: sequenceName },
        data: {
          nextValue: {
            increment: 1
          }
        }
      });

      const code = formatCode(updatedSequence.nextValue - 1);

      await transaction.shipmentRecord.update({
        where: { shopifyOrderId },
        data: { plannedShipmentCode: code }
      });

      return code;
    });
  }
};
