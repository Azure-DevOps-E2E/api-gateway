'use strict';

const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { join } = require('node:path');

const DEFAULTS = Object.freeze({
  version: '1.0.0',
  requestTimeoutMs: 10_000,
  healthTimeoutMs: 4_000,
  maxBodyBytes: 1024 * 1024,
  targets: Object.freeze({
    frontend: 'http://frontend:80',
    user: 'http://user-service:8081',
    catalog: 'http://catalog-service:8082',
    order: 'http://order-service:8083'
  })
});

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseTarget(value, name) {
  const target = new URL(value);
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    throw new Error(`${name} must use http or https`);
  }
  return target;
}

function loadConfig(env = process.env) {
  return {
    version: env.APP_VERSION || DEFAULTS.version,
    imageTag: env.APP_IMAGE_TAG || env.APP_VERSION || DEFAULTS.version,
    requestTimeoutMs: positiveInteger(env.REQUEST_TIMEOUT_MS, DEFAULTS.requestTimeoutMs, 'REQUEST_TIMEOUT_MS'),
    healthTimeoutMs: positiveInteger(env.HEALTH_TIMEOUT_MS, DEFAULTS.healthTimeoutMs, 'HEALTH_TIMEOUT_MS'),
    maxBodyBytes: positiveInteger(env.MAX_BODY_BYTES, DEFAULTS.maxBodyBytes, 'MAX_BODY_BYTES'),
    targets: {
      frontend: parseTarget(env.FRONTEND_URL || DEFAULTS.targets.frontend, 'FRONTEND_URL'),
      user: parseTarget(env.USER_SERVICE_URL || DEFAULTS.targets.user, 'USER_SERVICE_URL'),
      catalog: parseTarget(env.CATALOG_SERVICE_URL || DEFAULTS.targets.catalog, 'CATALOG_SERVICE_URL'),
      order: parseTarget(env.ORDER_SERVICE_URL || DEFAULTS.targets.order, 'ORDER_SERVICE_URL')
    }
  };
}

function normalizeConfig(input = {}) {
  const targets = input.targets || {};
  return {
    version: input.version || DEFAULTS.version,
    imageTag: input.imageTag || input.version || DEFAULTS.version,
    requestTimeoutMs: positiveInteger(input.requestTimeoutMs, DEFAULTS.requestTimeoutMs, 'requestTimeoutMs'),
    healthTimeoutMs: positiveInteger(input.healthTimeoutMs, DEFAULTS.healthTimeoutMs, 'healthTimeoutMs'),
    maxBodyBytes: positiveInteger(input.maxBodyBytes, DEFAULTS.maxBodyBytes, 'maxBodyBytes'),
    targets: {
      frontend: parseTarget(String(targets.frontend || DEFAULTS.targets.frontend), 'frontend target'),
      user: parseTarget(String(targets.user || DEFAULTS.targets.user), 'user target'),
      catalog: parseTarget(String(targets.catalog || DEFAULTS.targets.catalog), 'catalog target'),
      order: parseTarget(String(targets.order || DEFAULTS.targets.order), 'order target')
    }
  };
}

function requestIdFrom(request) {
  const candidate = Array.isArray(request.headers['x-request-id'])
    ? request.headers['x-request-id'][0]
    : request.headers['x-request-id'];
  return typeof candidate === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(candidate)
    ? candidate
    : randomUUID();
}

function safeRequestUrl(rawUrl) {
  const value = typeof rawUrl === 'string' ? rawUrl : '/';
  if (!value.startsWith('/') || value.startsWith('//')) {
    return null;
  }
  try {
    return new URL(value, 'http://gateway.local');
  } catch {
    return null;
  }
}

function selectRoute(pathname) {
  if (pathname === '/liveness') {
    return { kind: 'liveness', name: 'api-gateway' };
  }
  if (pathname === '/gateway-health' || pathname === '/health/api-gateway') {
    return { kind: 'self-health', name: 'api-gateway' };
  }
  if (pathname === '/health') {
    return { kind: 'dashboard', name: 'health-dashboard' };
  }
  if (pathname === '/api/v1/system/versions' || pathname === '/health/versions') {
    return { kind: 'versions', name: 'service-versions' };
  }
  if (pathname === '/health/frontend') {
    return { kind: 'health-proxy', target: 'frontend', name: 'frontend', path: '/health' };
  }
  if (pathname === '/health/user-service') {
    return { kind: 'health-proxy', target: 'user', name: 'user-service', path: '/health' };
  }
  if (pathname === '/health/catalog-service') {
    return { kind: 'health-proxy', target: 'catalog', name: 'catalog-service', path: '/health' };
  }
  if (pathname === '/health/order-service') {
    return { kind: 'health-proxy', target: 'order', name: 'order-service', path: '/health' };
  }
  if (/^\/api\/v1\/users(?:\/|$)/.test(pathname)) {
    return { kind: 'proxy', target: 'user', name: 'user-service' };
  }
  if (/^\/api\/v1\/products(?:\/|$)/.test(pathname)) {
    return { kind: 'proxy', target: 'catalog', name: 'catalog-service' };
  }
  if (/^\/api\/v1\/orders(?:\/|$)/.test(pathname)) {
    return { kind: 'proxy', target: 'order', name: 'order-service' };
  }
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return { kind: 'missing-api', name: 'unmatched-api' };
  }
  return { kind: 'proxy', target: 'frontend', name: 'frontend' };
}

function standardHeaders(requestId) {
  return {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'x-request-id': requestId
  };
}

function sendJson(response, statusCode, payload, requestId, extraHeaders = {}) {
  if (response.headersSent || response.destroyed) {
    return;
  }
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(statusCode, {
    ...standardHeaders(requestId),
    'content-length': body.length,
    ...extraHeaders
  });
  response.end(body);
}

function sendError(response, statusCode, code, message, requestId) {
  sendJson(response, statusCode, { error: { code, message, requestId } }, requestId);
}

function appendForwardedFor(request) {
  const current = request.headers['x-forwarded-for'];
  const remoteAddress = request.socket.remoteAddress || 'unknown';
  if (Array.isArray(current)) {
    return `${current.join(', ')}, ${remoteAddress}`;
  }
  return current ? `${current}, ${remoteAddress}` : remoteAddress;
}

function requestHeaders(request, target, requestId) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== 'host') {
      headers[name] = value;
    }
  }
  headers.host = target.host;
  headers['x-forwarded-for'] = appendForwardedFor(request);
  headers['x-forwarded-host'] = request.headers.host || '';
  headers['x-forwarded-proto'] = request.socket.encrypted ? 'https' : 'http';
  headers['x-real-ip'] = request.socket.remoteAddress || '';
  headers['x-request-id'] = requestId;
  return headers;
}

function responseHeaders(headers, requestId) {
  const result = {};
  for (const [name, value] of Object.entries(headers)) {
    const lowerName = name.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(lowerName) && lowerName !== 'x-request-id' && value !== undefined) {
      result[name] = value;
    }
  }
  result['x-request-id'] = requestId;
  result['x-content-type-options'] = 'nosniff';
  return result;
}

function healthRequestHeaders(requestId) {
  return {
    accept: 'application/json',
    'x-request-id': requestId
  };
}

function parseHealthSnapshot(service, result) {
  const payload = result.payload || {};
  const version = typeof payload.version === 'string' && payload.version.trim() ? payload.version : 'unknown';
  const imageTag = typeof payload.imageTag === 'string' && payload.imageTag.trim() ? payload.imageTag : version;
  return {
    service,
    status: result.ok ? 'UP' : 'DOWN',
    version,
    imageTag
  };
}

function fetchHealthSnapshot(target, requestId, timeoutMs) {
  return new Promise((resolve) => {
    const client = target.protocol === 'https:' ? https : http;
    let settled = false;
    const upstream = client.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: 'GET',
      path: upstreamPath(target, '/health'),
      headers: healthRequestHeaders(requestId)
    }, (upstreamResponse) => {
      const chunks = [];
      upstreamResponse.on('data', (chunk) => chunks.push(chunk));
      upstreamResponse.on('end', () => {
        settled = true;
        const body = Buffer.concat(chunks).toString('utf8');
        let payload = {};
        if (body) {
          try {
            payload = JSON.parse(body);
          } catch {
            payload = {};
          }
        }
        resolve({
          ok: (upstreamResponse.statusCode || 500) < 500,
          payload
        });
      });
    });

    upstream.setTimeout(timeoutMs, () => {
      const timeoutError = new Error('upstream timeout');
      timeoutError.code = 'ETIMEDOUT';
      upstream.destroy(timeoutError);
    });

    upstream.on('error', () => {
      if (!settled) {
        resolve({ ok: false, payload: {} });
      }
    });

    upstream.end();
  });
}

async function collectServiceVersions(config, requestId) {
  const services = [
    { name: 'frontend', target: config.targets.frontend },
    { name: 'user-service', target: config.targets.user },
    { name: 'catalog-service', target: config.targets.catalog },
    { name: 'order-service', target: config.targets.order }
  ];

  const snapshots = await Promise.all(
    services.map(async ({ name, target }) => {
      const result = await fetchHealthSnapshot(target, requestId, config.healthTimeoutMs);
      return parseHealthSnapshot(name, result);
    })
  );

  return {
    status: snapshots.some((service) => service.status !== 'UP') ? 'DEGRADED' : 'UP',
    service: 'api-gateway',
    version: config.version,
    imageTag: config.imageTag,
    generatedAt: new Date().toISOString(),
    services: snapshots
  };
}

function upstreamPath(target, incomingPath) {
  const prefix = target.pathname === '/' ? '' : target.pathname.replace(/\/$/, '');
  return `${prefix}${incomingPath}`;
}

function proxyRequest({ request, response, target, route, requestId, config }) {
  const client = target.protocol === 'https:' ? https : http;
  const isHealth = route.kind === 'health-proxy';
  const path = isHealth ? route.path : request.url;
  const timeoutMs = isHealth ? config.healthTimeoutMs : config.requestTimeoutMs;
  const contentLength = Number(request.headers['content-length'] || 0);

  if (Number.isFinite(contentLength) && contentLength > config.maxBodyBytes) {
    sendError(response, 413, 'PAYLOAD_TOO_LARGE', `Request body must not exceed ${config.maxBodyBytes} bytes`, requestId);
    request.resume();
    return;
  }

  let receivedBytes = 0;
  let completed = false;
  const upstream = client.request({
    protocol: target.protocol,
    hostname: target.hostname,
    port: target.port || undefined,
    method: request.method,
    path: upstreamPath(target, path),
    headers: requestHeaders(request, target, requestId)
  });

  upstream.setTimeout(timeoutMs, () => {
    const timeoutError = new Error('upstream timeout');
    timeoutError.code = 'ETIMEDOUT';
    upstream.destroy(timeoutError);
  });

  upstream.on('response', (upstreamResponse) => {
    completed = true;
    if (isHealth && (upstreamResponse.statusCode || 500) >= 500) {
      upstreamResponse.resume();
      sendJson(response, 503, { status: 'DOWN', service: route.name, version: 'unknown' }, requestId);
      return;
    }
    response.writeHead(upstreamResponse.statusCode || 502, responseHeaders(upstreamResponse.headers, requestId));
    upstreamResponse.pipe(response);
    upstreamResponse.on('error', () => response.destroy());
  });

  upstream.on('error', (error) => {
    if (error.code === 'PAYLOAD_TOO_LARGE') {
      return;
    }
    if (completed || response.headersSent) {
      response.destroy(error);
      return;
    }
    if (isHealth) {
      sendJson(response, 503, { status: 'DOWN', service: route.name, version: 'unknown' }, requestId);
      return;
    }
    const timedOut = error.code === 'ETIMEDOUT';
    sendError(
      response,
      timedOut ? 504 : 502,
      timedOut ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNAVAILABLE',
      timedOut ? `${route.name} did not respond in time` : `${route.name} is unavailable`,
      requestId
    );
  });

  request.on('data', (chunk) => {
    receivedBytes += chunk.length;
    if (receivedBytes > config.maxBodyBytes && !upstream.destroyed) {
      const limitError = new Error('request body too large');
      limitError.code = 'PAYLOAD_TOO_LARGE';
      upstream.destroy(limitError);
      sendError(response, 413, 'PAYLOAD_TOO_LARGE', `Request body must not exceed ${config.maxBodyBytes} bytes`, requestId);
    }
  });
  request.pipe(upstream);
}

function createGateway(options = {}) {
  const config = options.config ? normalizeConfig(options.config) : loadConfig(options.env);
  const logger = options.logger || console;
  const healthPage = options.healthPage || readFileSync(join(__dirname, '..', 'public', 'health.html'));

  const server = http.createServer((request, response) => {
    const startedAt = process.hrtime.bigint();
    const requestId = requestIdFrom(request);
    const parsedUrl = safeRequestUrl(request.url);

    response.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
      logger.info?.(JSON.stringify({
        timestamp: new Date().toISOString(),
        method: request.method,
        path: parsedUrl?.pathname || request.url,
        status: response.statusCode,
        durationMs: Number(durationMs.toFixed(2)),
        requestId
      }));
    });

    if (!parsedUrl) {
      sendError(response, 400, 'INVALID_REQUEST_URL', 'Request URL is invalid', requestId);
      return;
    }

    const route = selectRoute(parsedUrl.pathname);
    if (route.kind === 'liveness') {
      sendJson(response, 200, { status: 'UP', service: 'api-gateway' }, requestId);
      return;
    }

    if (route.kind === 'self-health') {
      sendJson(response, 200, { status: 'UP', service: 'api-gateway', version: config.version, imageTag: config.imageTag }, requestId);
      return;
    }

    if (route.kind === 'versions') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendError(response, 405, 'METHOD_NOT_ALLOWED', 'Only GET and HEAD are supported', requestId);
        return;
      }
      collectServiceVersions(config, requestId)
        .then((payload) => {
          if (response.headersSent || response.destroyed) {
            return;
          }
          if (request.method === 'HEAD') {
            response.writeHead(200, {
              ...standardHeaders(requestId),
              'content-length': 0
            });
            response.end();
            return;
          }
          sendJson(response, 200, payload, requestId);
        })
        .catch((error) => {
          logger.error?.(error);
          sendError(response, 503, 'UPSTREAM_UNAVAILABLE', 'Unable to collect service versions', requestId);
        });
      return;
    }

    if (route.kind === 'dashboard') {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendError(response, 405, 'METHOD_NOT_ALLOWED', 'Only GET and HEAD are supported', requestId);
        return;
      }
      response.writeHead(200, {
        'cache-control': 'no-store',
        'content-length': healthPage.length,
        'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
        'content-type': 'text/html; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'DENY',
        'x-request-id': requestId
      });
      response.end(request.method === 'HEAD' ? undefined : healthPage);
      return;
    }

    if (route.kind === 'missing-api') {
      sendError(response, 404, 'ROUTE_NOT_FOUND', 'API route does not exist', requestId);
      return;
    }

    proxyRequest({ request, response, target: config.targets[route.target], route, requestId, config });
  });

  server.requestTimeout = config.requestTimeoutMs + 2_000;
  server.headersTimeout = Math.min(server.requestTimeout, 15_000);
  return server;
}

module.exports = { createGateway, loadConfig, selectRoute };
