import assert from 'node:assert/strict';
import { prisma } from '../lib/prisma.js';
import { MetaDeliveryService } from '../meta/metaDeliveryService.js';
import { metaDeliveryOutboxRepository } from '../meta/metaDeliveryOutboxRepository.js';
import type { ShopifyOrder } from '../types/shopify.js';

const main = async (): Promise<void> => {
  if (process.env.ALLOW_META_DB_TEST !== 'true') {
    throw new Error('Refusing database-writing test without ALLOW_META_DB_TEST=true');
  }
  const runId = `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  const prefix = `codex-meta-db-${runId}`;
  const now = new Date();
  const cutoverAt = new Date(now.getTime() - 60_000);
  const service = new MetaDeliveryService({
    enabled: true,
    mode: 'test',
    pixelId: '1612387453338865',
    accessToken: 'database-test-does-not-send',
    apiVersion: 'v25.0',
    testEventCode: 'TEST_DATABASE_ONLY',
    cutoverAt,
    eventSourceUrl: 'https://violaleather.com',
    batchSize: 10,
    leaseMs: 120_000,
    requestTimeoutMs: 1_000,
    maxAttempts: 3
  });

  const createdIds: number[] = [];
  try {
    const dueBeforeTest = await prisma.metaDeliveryOutbox.count({
      where: {
        mode: 'test',
        OR: [
          {
            status: { in: ['pending', 'retry'] },
            OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }]
          },
          { status: 'processing', leaseExpiresAt: { lte: new Date() } }
        ]
      }
    });
    if (dueBeforeTest > 0) {
      throw new Error(`Refusing shared DB test while ${dueBeforeTest} unrelated test-mode rows are due`);
    }

    for (let index = 0; index < 6; index += 1) {
      const shopifyOrderId = `${prefix}-${index}`;
      const order: ShopifyOrder = {
        id: 90_000_000 + index,
        name: `#META-DB-${index}`,
        order_number: 90_000 + index,
        created_at: now.toISOString(),
        total_price: '1200.00',
        current_total_price: '1200.00',
        currency: 'EGP',
        test: false,
        email: `meta-db-${runId}-${index}@example.com`,
        phone: '01012345678',
        shipping_address: {
          first_name: 'Test',
          last_name: 'Customer',
          city: 'Cairo',
          country_code: 'EG',
          phone: '01012345678'
        },
        customer: { id: `customer-${runId}-${index}` },
        line_items: [{
          id: 70_000 + index,
          title: 'Database test item',
          sku: `DB-${index}`,
          quantity: 1,
          price: '1200.00'
        }]
      };
      const record = await prisma.shipmentRecord.create({
        data: {
          shopifyOrderId,
          shopifyOrderNumber: String(order.order_number),
          shopifyOrderName: order.name,
          shopifyCreatedAt: now,
          rawOrderJson: JSON.stringify(order),
          accurateStatus: 'PENDING'
        }
      });
      createdIds.push(record.id);
    }

    const deliveredAt = new Date(now.getTime() + 1_000);
    const snapshot = {
      accurateStatus: 'Delivered',
      accurateStatusCode: 'DTR',
      accurateIsTerminal: true,
      collectionStatus: 'collected',
      collectedAmount: 1200,
      customerDue: 1200,
      deliveredAt
    } as const;

    // Repeated webhook/poller/report observations converge on one durable event.
    // Stay below the production pool's five-connection limit while still
    // exercising simultaneous duplicate observations in three race waves.
    for (let wave = 0; wave < 3; wave += 1) {
      await Promise.all(
        Array.from({ length: 4 }, () =>
          service.observeSnapshot(createdIds[0], snapshot, 'accurate-status')
        )
      );
    }
    const firstEvents = await prisma.metaDeliveryOutbox.findMany({
      where: { shipmentRecordId: createdIds[0] }
    });
    assert.equal(firstEvents.length, 1);
    assert.equal(firstEvents[0].eventId, `viola:delivered:${prefix}-0`);

    // A later duplicate timestamp cannot mutate the original event time.
    await service.observeSnapshot(createdIds[0], {
      ...snapshot,
      deliveredAt: new Date(deliveredAt.getTime() + 86_400_000)
    }, 'accurate-report');
    const firstRecord = await prisma.shipmentRecord.findUniqueOrThrow({ where: { id: createdIds[0] } });
    assert.equal(firstRecord.deliveredAt?.getTime(), deliveredAt.getTime());

    // An older ordinary lookup must not downgrade the newer collection report.
    await service.observeSnapshot(createdIds[0], {
      accurateStatus: 'Out for delivery',
      accurateStatusCode: 'OTD',
      accurateIsTerminal: false,
      collectionStatus: 'pending',
      collectedAmount: 0
    }, 'accurate-status');
    const afterStaleLookup = await prisma.shipmentRecord.findUniqueOrThrow({ where: { id: createdIds[0] } });
    assert.equal(afterStaleLookup.accurateStatusCode, 'DTR');
    assert.equal(afterStaleLookup.collectionStatus, 'collected');

    await Promise.all(
      createdIds.slice(1).map((id) => service.observeSnapshot(id, snapshot, 'accurate-payment'))
    );
    const totalEvents = await prisma.metaDeliveryOutbox.count({
      where: { shipmentRecordId: { in: createdIds } }
    });
    assert.equal(totalEvents, 6);

    // Concurrent workers lease disjoint IDs; none can double-send the same row.
    const claims = await Promise.all([
      metaDeliveryOutboxRepository.claimDue(2, 120_000, 'test'),
      metaDeliveryOutboxRepository.claimDue(2, 120_000, 'test'),
      metaDeliveryOutboxRepository.claimDue(2, 120_000, 'test')
    ]);
    const claimed = claims.flat().filter((row) => createdIds.includes(row.shipmentRecordId));
    assert.equal(claimed.length, 6);
    assert.equal(new Set(claimed.map((row) => row.id)).size, 6);

    process.stdout.write(`${JSON.stringify({
      ok: true,
      concurrentObservations: 12,
      uniqueEvents: totalEvents,
      disjointClaims: claimed.length,
      immutableDeliveredAt: true,
      staleSnapshotDowngradeBlocked: true
    }, null, 2)}\n`);
  } finally {
    if (createdIds.length > 0) {
      await prisma.shipmentRecord.deleteMany({ where: { id: { in: createdIds } } });
    }
    await prisma.$disconnect();
  }
};

void main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  await prisma.$disconnect();
  process.exitCode = 1;
});
