#!/usr/bin/env node
/**
 * Local, self-contained MCP kernel for THIS module only.
 *
 * Everything-as-Code: no id, name, capability, host, port or NATS subject is
 * a literal in this file — everything comes from this module's own
 * `configs/core.yml`, read exclusively via packages/Tools/UbiQonfig. This
 * file is identical, byte-for-byte, across every MyChappie.Digital module —
 * each module owns its own copy (no shared runtime directory, no
 * cross-module coupling) — only configs/core.yml differs. See
 * ../../docs/MCP-STANDARD.md for the full pattern.
 *
 * Every dispatched JSON-RPC method ("route", e.g. `tools/call`) is also
 * emitted as a local event and published as a NATS event, with the same
 * name but "/" replaced by ".": `tools/call` -> `tools.call`.
 */
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import readline from 'node:readline';
import { loadYaml, loadJson, loadEnv } from '../../../Tools/UbiQonfig/src/index.js';
import { restTransport } from './transports/rest.mjs';
import { webSocketTransport } from './transports/websocket.mjs';
import { natsTransport } from './transports/nats.mjs';

const moduleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const networkMode = process.argv.includes('--network') || process.env.MCP_NETWORK === '1';

export const events = new EventEmitter();

/* ------------------------------------------------------------------ *
 * Config: read only this module's own configs/core.yml (+ optional      *
 * core.local.json overlay / .env), via UbiQonfig only.                  *
 * ------------------------------------------------------------------ */

const module_ = loadModuleConfig(moduleDir);

function loadModuleConfig(dir) {
  const base = loadYaml('configs/core.yml', { baseDir: dir });
  if (!base || !base.module || !base.module.id) {
    throw new Error(`Invalid configs/core.yml in ${dir}: missing module.id`);
  }
  const local = loadJson('configs/core.local.json', { baseDir: dir });
  const merged = local ? deepMerge(base, local) : base;
  loadEnv('configs/.env', { baseDir: dir }); // optional, applies to process.env
  resolveEnvPlaceholders(merged);

  const transports = merged.mcp?.transports || {};
  return {
    id: merged.module.id,
    name: merged.module.name || merged.module.id,
    capabilities: merged.module.capabilities || [],
    api: merged.module.api || { status: 'unknown' },
    transports: {
      stdio: { enabled: transports.stdio?.enabled !== false },
      rest: {
        enabled: transports.rest?.enabled === true,
        host: transports.rest?.host || '127.0.0.1',
        port: transports.rest?.port,
      },
      websocket: {
        enabled: transports.websocket?.enabled === true,
        host: transports.websocket?.host || '127.0.0.1',
        port: transports.websocket?.port,
      },
      nats: {
        enabled: transports.nats?.enabled === true,
        url: transports.nats?.url || 'nats://127.0.0.1:4222',
        subject: transports.nats?.subject || `${merged.module.id}.rpc`,
        queue: transports.nats?.queue || merged.module.id,
      },
    },
  };
}

function deepMerge(target, source) {
  if (Array.isArray(target) || Array.isArray(source) || typeof source !== 'object' || source === null) {
    return source;
  }
  const out = { ...target };
  for (const key of Object.keys(source)) {
    out[key] = key in target ? deepMerge(target[key], source[key]) : source[key];
  }
  return out;
}

/** Replaces exact-string `"${VAR}"` scalars with `process.env.VAR`, recursively. */
function resolveEnvPlaceholders(node) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) node[i] = resolveScalar(node[i]);
    return;
  }
  if (node && typeof node === 'object') {
    for (const key of Object.keys(node)) node[key] = resolveScalar(node[key]);
  }
}

function resolveScalar(value) {
  if (typeof value === 'string') {
    const match = /^\$\{([A-Z0-9_]+)\}$/.exec(value);
    if (match && process.env[match[1]] !== undefined) return process.env[match[1]];
    return value;
  }
  if (value && typeof value === 'object') resolveEnvPlaceholders(value);
  return value;
}

/* ------------------------------------------------------------------ *
 * Tool contract: 3 discovery tools for this module.                    *
 * ------------------------------------------------------------------ */

const toolDefinitions = [
  {
    name: `${module_.id}_status`,
    description: `Health and implementation status for ${module_.name}.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => ({ module: module_.id, name: module_.name, status: 'ready', api: module_.api, mcp: 'ready' }),
  },
  {
    name: `${module_.id}_capabilities`,
    description: `Declared domain capabilities for ${module_.name}.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => ({ module: module_.id, capabilities: module_.capabilities }),
  },
  {
    name: `${module_.id}_api_contract`,
    description: `Stable MCP/API contract metadata for ${module_.name}.`,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: () => ({
      module: module_.id,
      transport: 'MCP stdio / REST / WebSocket / NATS, JSON-RPC 2.0',
      toolNamespace: `${module_.id}_*`,
      legacyApi: module_.api,
    }),
  },
];

/* ------------------------------------------------------------------ *
 * JSON-RPC 2.0 dispatcher — shared by every transport. Every route      *
 * (JSON-RPC method) is mirrored as an event, "/" -> ".".                *
 * ------------------------------------------------------------------ */

const result = (id, value) => ({ jsonrpc: '2.0', id, result: value });
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

let natsHandle = null; // set once the NATS transport is started, for event publish

async function dispatch(request) {
  const response = await route(request);
  if (request?.method) {
    const eventName = request.method.replace(/\//g, '.');
    const payload = { module: module_.id, method: request.method, request, response };
    events.emit(eventName, payload);
    natsHandle?.publish(`${module_.id}.${eventName}`, payload);
  }
  return response;
}

async function route(request) {
  if (request.method === 'initialize') {
    return result(request.id, {
      protocolVersion: request.params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: module_.id, version: '3.0.0' },
    });
  }
  if (request.method === 'notifications/initialized' || request.method === 'ping') return null;
  if (request.method === 'tools/list') {
    return result(request.id, { tools: toolDefinitions.map(({ handler, ...tool }) => tool) });
  }
  if (request.method === 'resources/list') {
    return result(request.id, {
      resources: [{ uri: `mychappie://modules/${module_.id}`, name: module_.name, mimeType: 'application/json' }],
    });
  }
  if (request.method === 'resources/read') {
    const id = String(request.params?.uri || '').split('/').pop();
    if (id !== module_.id) return error(request.id, -32602, 'Unknown module resource');
    return result(request.id, { contents: [{ uri: request.params.uri, mimeType: 'application/json', text: JSON.stringify(module_) }] });
  }
  if (request.method === 'tools/call') {
    const tool = toolDefinitions.find((item) => item.name === request.params?.name);
    if (!tool) return error(request.id, -32602, `Unknown tool: ${request.params?.name}`);
    const text = JSON.stringify(tool.handler(request.params?.arguments || {}));
    return result(request.id, { content: [{ type: 'text', text }], structuredContent: JSON.parse(text) });
  }
  return error(request.id, -32601, `Method not found: ${request.method}`);
}

/* ------------------------------------------------------------------ *
 * Transports.                                                          *
 * ------------------------------------------------------------------ */

const runningTransports = [];

// REST / WebSocket / NATS: opt-in per process (`--network`), and each still
// gated by its own `mcp.transports.<name>.enabled` in this module's
// core.yml. Started before the stdio loop below, since that loop blocks
// until stdin closes.
if (networkMode) {
  if (module_.transports.rest.enabled) {
    if (!module_.transports.rest.port) {
      process.stderr.write(`${module_.id}: rest.enabled but no rest.port configured, skipping\n`);
    } else {
      const transport = restTransport({ host: module_.transports.rest.host, port: module_.transports.rest.port, moduleId: module_.id });
      await transport.start(dispatch);
      runningTransports.push(transport);
      process.stderr.write(`${module_.id}: ${transport.name} ready\n`);
    }
  }
  if (module_.transports.websocket.enabled) {
    if (!module_.transports.websocket.port) {
      process.stderr.write(`${module_.id}: websocket.enabled but no websocket.port configured, skipping\n`);
    } else {
      const transport = webSocketTransport({ host: module_.transports.websocket.host, port: module_.transports.websocket.port });
      await transport.start(dispatch);
      runningTransports.push(transport);
      process.stderr.write(`${module_.id}: ${transport.name} ready\n`);
    }
  }
  if (module_.transports.nats.enabled) {
    const transport = natsTransport({
      url: module_.transports.nats.url,
      rpcSubject: module_.transports.nats.subject,
      queue: module_.transports.nats.queue,
    });
    await transport.start(dispatch);
    natsHandle = transport;
    runningTransports.push(transport);
    process.stderr.write(`${module_.id}: ${transport.name} connecting...\n`);
  }
}

async function shutdown() {
  await Promise.all(runningTransports.map((t) => t.stop()));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// stdio: always on by default. This is the transport `.mcp.json` launches,
// so it must stay side-effect-free (no network listeners/connections)
// unless --network is set.
if (module_.transports.stdio.enabled) {
  const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    try {
      const response = await dispatch(JSON.parse(line));
      if (response) write(response);
    } catch (cause) {
      write(error(null, -32700, cause instanceof Error ? cause.message : String(cause)));
    }
  }
}
