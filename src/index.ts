import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { prisma } from './lib/prisma.js';
import { createApp } from './app.js';

const bootstrap = async (): Promise<void> => {
  const { app, services } = createApp();

  app.listen(env.port, () => {
    logger.info(`Accurate Shopify integration listening on port ${env.port}`);
  });

  setInterval(() => {
    void services.shipmentStatusSyncService.syncOpenShipments();
  }, env.syncOpenShipmentsIntervalMs);
};

bootstrap().catch(async (error) => {
  logger.error('Fatal bootstrap error', error);
  await prisma.$disconnect();
  process.exit(1);
});
