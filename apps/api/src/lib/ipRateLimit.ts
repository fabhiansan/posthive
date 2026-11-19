// The routes a stranger can call with nothing but guesses (log in, the code of the second step, reset, register) are limited by
// the address the request came from, and by nothing the request itself says. The app-wide limiter keys on the Authorization
// header or the access cookie when there is one, so a client that sends a different made-up one each time would never reach the
// limit: `Authorization: Bearer <random>` gave it a fresh allowance on every request.
import type { FastifyRequest } from "fastify";

export const byIp = (req: FastifyRequest): string => req.ip;

/** `config.rateLimit` for an anonymous guessing route: `max` tries per 15 minutes from one address. */
export const guessLimit = (max: number) => ({ rateLimit: { max, timeWindow: "15 minutes", keyGenerator: byIp } });
