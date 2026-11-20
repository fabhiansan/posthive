// The routes a stranger can call with nothing but guesses (log in, the code of the second step, reset, register) are limited by
// the address the request came from, and by nothing the request itself says. The app-wide limiter keys on the Authorization
// header or the access cookie when there is one, so a client that sends a different made-up one each time would never reach the
// limit: `Authorization: Bearer <random>` gave it a fresh allowance on every request.
import type { FastifyRequest } from "fastify";

/**
 * Whose X-Forwarded-For the API believes: a proxy on a private address (Caddy in Docker is 172.x, a platform proxy such as
 * Railway's is 100.64.x), never an address on the internet. Without this `req.ip` is the proxy's address for every visitor, so
 * every person shares one allowance (10 logins per 15 minutes for the whole site). The API's port is also open directly, so
 * "trust every proxy" would let anybody write their own address into the header and get a fresh allowance on each request.
 */
export const TRUSTED_PROXIES = ["loopback", "linklocal", "uniquelocal", "100.64.0.0/10"];

export const byIp = (req: FastifyRequest): string => req.ip;

/** `config.rateLimit` for an anonymous guessing route: `max` tries per 15 minutes from one address. */
export const guessLimit = (max: number) => ({ rateLimit: { max, timeWindow: "15 minutes", keyGenerator: byIp } });
