import { getStore } from '@netlify/blobs';

export default {
  async deploySucceeded(event: { deploy: { id: string; context: string } }) {
    if (event.deploy.context !== 'production') return;
    const checks: Record<string, unknown> = {};
    const attempt = async (name: string, run: () => Promise<unknown>) => {
      try { checks[name] = await run(); } catch { checks[name] = { ok: false }; }
    };
    await attempt('http', async () => {
      const r = await fetch(`${process.env.RECOVERY_PUBLIC_URL}/health`, { signal: AbortSignal.timeout(30000) });
      return { status: r.status, ok: r.ok && (await r.json()).ok === true };
    });
    await attempt('database', async () => {
      const { basePrisma } = await import('../src/lib/prisma.js');
      await basePrisma.$queryRaw`SELECT 1`;
      return { ok: true, shipments: await basePrisma.shipmentRecord.count() };
    });
    await attempt('bot', async () => {
      const r = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`, { signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      return { ok: j.ok === true, webhookHost: j.result?.url ? new URL(j.result.url).hostname : null, pending: j.result?.pending_update_count };
    });
    await attempt('agentAuthentication', async () => {
      const r = await fetch(`${process.env.AYMAN_AGENT_URL}/api/production`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000) });
      return { ok: r.status === 401, status: r.status };
    });
    await attempt('shopifyAndAgentPreview', async () => {
      const shop = process.env.SHOPIFY_SHOP_DOMAIN;
      const auth = await fetch(`https://${shop}/admin/oauth/access_token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ grant_type: 'client_credentials', client_id: process.env.SHOPIFY_CLIENT_ID, client_secret: process.env.SHOPIFY_CLIENT_SECRET }), signal: AbortSignal.timeout(20000) });
      const credentials = await auth.json();
      if (!credentials.access_token) return { ok: false, shopifyStatus: auth.status };
      const r = await fetch(`https://${shop}/admin/api/${process.env.SHOPIFY_API_VERSION}/graphql.json`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': credentials.access_token }, body: JSON.stringify({ query: '{shop{myshopifyDomain} orders(first:1,sortKey:CREATED_AT,reverse:true){nodes{name}}}' }), signal: AbortSignal.timeout(20000) });
      const j = await r.json();
      const order = j.data?.orders?.nodes?.[0]?.name;
      if (!order || j.data?.shop?.myshopifyDomain !== shop) return { ok: false, shopifyStatus: r.status };
      // "execute" in this agent only renders DOCX/ZIP in memory; its source
      // performs no Shopify, shipping, or accounting mutations.
      const preview = await fetch(`${process.env.AYMAN_AGENT_URL}/api/production`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Agent-Secret': process.env.AYMAN_AGENT_SECRET ?? '' }, body: JSON.stringify({ mode: 'execute', skipPhotos: true, orderNumbers: [order] }), signal: AbortSignal.timeout(55000) });
      const result = await preview.json();
      return { ok: preview.ok && !!result.wordBase64 && result.summary?.totalOrders === 1, shopifyStatus: r.status, agentStatus: preview.status, orders: result.summary?.totalOrders };
    });
    await attempt('odoo', async () => {
      const r = await fetch(`${process.env.ODOO_URL?.replace(/\/$/,'')}/jsonrpc`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',method:'call',params:{service:'common',method:'authenticate',args:[process.env.ODOO_DB,process.env.ODOO_USERNAME,process.env.ODOO_PASSWORD,{}]},id:1}),signal:AbortSignal.timeout(30000)});
      const j = await r.json(); return {ok:r.ok&&Number.isInteger(j.result)&&j.result>0,status:r.status};
    });
    await getStore('hosting-recovery-readiness').setJSON('latest', {
      service: 'viola-telegraph-integration', deployId: event.deploy.id,
      checkedAt: new Date().toISOString(), live: process.env.RECOVERY_LIVE === '1',
      metaTransportPaused: process.env.META_DELIVERED_TRANSPORT_PAUSED === 'true', checks,
    });
  },
};
