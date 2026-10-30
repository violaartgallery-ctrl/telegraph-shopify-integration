import serverless from 'serverless-http';
import { createApp } from '../src/app.js';

const handle = serverless(createApp().app);
export default async (request: Request) => {
  const url = new URL(request.url);
  if (process.env.RECOVERY_LIVE !== '1' && url.pathname !== '/health') {
    return Response.json({ ok: false, reason: 'Recovery cutover not activated' }, { status: 503 });
  }
  const result = await handle({
    httpMethod: request.method, path: url.pathname, rawUrl: request.url,
    headers: Object.fromEntries(request.headers),
    queryStringParameters: Object.fromEntries(url.searchParams),
    body: ['GET', 'HEAD'].includes(request.method) ? null : Buffer.from(await request.arrayBuffer()).toString('base64'),
    isBase64Encoded: true,
    requestContext: { identity: { sourceIp: request.headers.get('x-nf-client-connection-ip') ?? '' } },
  }, {}) as {statusCode:number;body:string;headers:Record<string,string>;multiValueHeaders?:Record<string,string[]>;isBase64Encoded?:boolean};
  const headers = new Headers(result.headers as Record<string, string>);
  for (const [key, values] of Object.entries(result.multiValueHeaders ?? {})) {
    headers.delete(key); for (const value of values as string[]) headers.append(key, value);
  }
  const noBody = request.method === 'HEAD' || [204, 205, 304].includes(result.statusCode);
  return new Response(noBody ? null : result.isBase64Encoded ? Buffer.from(result.body, 'base64') : result.body, { status: result.statusCode, headers });
};
export const config = { path: '/*', preferStatic: true, excludedPath: ['/.netlify/functions/*'] };
