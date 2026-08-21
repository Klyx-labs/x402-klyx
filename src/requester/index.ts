/**
 * Requester-side helpers for calling paid providers. Currently
 * ships a fetch-shaped interceptor; axios/ky/other-client bridges
 * can add sibling modules without touching core.
 */
export * from "./fetch.js";
