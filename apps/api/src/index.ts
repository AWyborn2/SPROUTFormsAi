import { createApp } from './app.js';
import { env } from './env.js';

const app = createApp();

app.listen(env.API_PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[formai-api] listening on http://localhost:${env.API_PORT}`);
});
