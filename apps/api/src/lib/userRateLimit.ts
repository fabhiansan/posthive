import type { FastifyRequest } from "fastify";

/**
 * A per-minute limit for ONE PERSON IN ONE WORKSPACE, used by every Canvas route.
 *
 * The app-wide limiter keys on a header the client chooses, or on req.ip, which behind the production proxy is the proxy's
 * address shared by everybody (unless `trustProxy` makes it the visitor's, see TRUSTED_PROXIES in ipRateLimit.ts), so a per-route limit
 * declared the usual way is really one bucket for every user. This one is keyed on the signed-in person, which the server decides.
 *
 * It must run AFTER the auth hook, because it reads req.user and req.workspaceId: the plugin's default hook is onRequest,
 * which is before auth, so `hook: "preHandler"` is required. The plugin appends its handler to the route's own preHandler
 * list, so list `withAuth` there first. A request that auth refuses (401) never reaches it and is not counted here: on the Canvas
 * routes that case is bounded by the authentication gate instead (lib/canvasAuthGate.ts). If it ever ran without a person it would
 * fall back to the address, never to one shared key.
 *
 * Known limits (read from the plugin source, accepted with decision B3):
 *  - A route-level `rateLimit` object REPLACES the app-wide limiter for that route, and the plugin runs only one limiter per
 *    request (its `rateLimitRan` guard), so a second, address-keyed limiter cannot be stacked in front. A request that never
 *    gets past auth is therefore not limited by THIS limiter; on the Canvas routes the authentication gate counts it.
 *  - The limiter is the LAST preHandler, so a request that the role gate (403), the id guard (404) or the JSON guard (415)
 *    refuses is not counted either. Only requests that reach the handler use up the allowance.
 */
export const userKey = (req: FastifyRequest): string => (req.user && req.workspaceId ? `${req.workspaceId}:${req.user.id}` : req.ip);

export const userLimit = (max: number) => ({ rateLimit: { max, timeWindow: "1 minute", hook: "preHandler" as const, keyGenerator: userKey } });
