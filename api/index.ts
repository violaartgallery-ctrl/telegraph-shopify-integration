// Vercel entrypoint for the Express app (admin dashboard + Shopify/Accurate
// webhooks + the public /api/accurate/* governorate endpoints). All non-function
// paths are rewritten here by vercel.json. Reuses the same createApp() as Netlify
// so there is a single source of truth for routing.
import { createApp } from '../dist/app.js';

const { app } = createApp();

export default app;
