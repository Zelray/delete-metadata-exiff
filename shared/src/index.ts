/**
 * MetaDesk shared API contract.
 *
 * This package is the single source of truth for every type that crosses the
 * HTTP/SSE boundary between the MetaDesk server and the MetaDesk UI. Both the
 * server routes and the browser client consume these types; changing them is a
 * contract change and must go through the orchestrator.
 */
export * from './api.js';
export * from './files.js';
export * from './metadata.js';
export * from './write.js';
export * from './engine.js';
