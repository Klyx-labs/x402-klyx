/**
 * Provider-side helpers for accepting paid HTTP invocations.
 * Currently ships an express middleware; other frameworks (hono,
 * next.js, fastify) can add sibling modules alongside `express.ts`
 * without touching the core primitives.
 */
export * from "./express.js";
