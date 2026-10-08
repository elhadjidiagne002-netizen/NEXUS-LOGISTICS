// Cloudflare Pages Functions : toutes les routes /api/* passent par le routeur de server/app.js.
import { handle } from '../../server/app.js';

export const onRequest = (context) => handle(context.request, context.env, context);
