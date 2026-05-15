#!/usr/bin/env node
/* eslint-disable no-console */

const http = require("node:http");
const { randomUUID } = require("node:crypto");
const { Transaction, keccak256, isHexString } = require("ethers");

const DEFAULT_UPSTREAM_RPC_URL = "https://mainnet.base.org";

function positiveIntEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function maskUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    for (const [key] of url.searchParams) {
      if (/key|token|secret|apikey|api_key|access/i.test(key)) {
        url.searchParams.set(key, "***");
      }
    }
    const pathParts = url.pathname.split("/");
    url.pathname = pathParts
      .map((part, index) => {
        if (index === pathParts.length - 1 && part.length >= 24) return "***";
        return part;
      })
      .join("/");
    return url.toString();
  } catch {
    return "invalid-url";
  }
}

function log(event, details = {}, level = "info") {
  const payload = {
    event,
    timestamp: Math.floor(Date.now() / 1000),
    ...details,
  };
  const line = `[RPC_RELAY] ${JSON.stringify(payload)}`;
  if (level === "error") {
    console.error(line);
  } else {
    console.log(line);
  }
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;

    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error(`request body exceeded ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function extractCalls(payload) {
  const calls = Array.isArray(payload) ? payload : [payload];
  return calls
    .filter((call) => call && typeof call === "object")
    .map((call) => ({
      id: call.id,
      method: call.method,
      params: Array.isArray(call.params) ? call.params : [],
    }));
}

function summarizeRawTx(rawTx) {
  if (typeof rawTx !== "string" || !isHexString(rawTx)) {
    return {
      rawTxValidHex: false,
      rawTxBytes: 0,
    };
  }

  const summary = {
    rawTxValidHex: true,
    rawTxBytes: Math.max(0, (rawTx.length - 2) / 2),
    rawTxHash: keccak256(rawTx),
    rawTxPrefix: rawTx.slice(0, 18),
  };

  try {
    const tx = Transaction.from(rawTx);
    const data = tx.data || "0x";
    return {
      ...summary,
      decoded: true,
      type: tx.type,
      chainId: tx.chainId?.toString(),
      nonce: tx.nonce,
      from: tx.from,
      to: tx.to,
      value: tx.value?.toString(),
      gasLimit: tx.gasLimit?.toString(),
      gasPrice: tx.gasPrice?.toString(),
      maxFeePerGas: tx.maxFeePerGas?.toString(),
      maxPriorityFeePerGas: tx.maxPriorityFeePerGas?.toString(),
      dataBytes: Math.max(0, (data.length - 2) / 2),
      selector: data.slice(0, 10),
      signatureR: tx.signature?.r,
      signatureS: tx.signature?.s,
      signatureYParity: tx.signature?.yParity,
      signatureNetworkV: tx.signature?.networkV?.toString(),
    };
  } catch (error) {
    return {
      ...summary,
      decoded: false,
      decodeError: error?.message || String(error),
    };
  }
}

function safeJsonParse(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error };
  }
}

function sanitizeRpcResponseBody(text, limit = 4000) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}...<truncated ${text.length - limit} chars>`;
}

function requestAuthorized(req, token) {
  if (!token) return true;

  const auth = req.headers.authorization;
  if (auth === `Bearer ${token}`) return true;

  try {
    const url = new URL(req.url || "/", "http://localhost");
    if (url.searchParams.get("token") === token) return true;
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.includes(token);
  } catch {
    return false;
  }
}

function writeJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    "content-type": "application/json",
  });
  res.end(JSON.stringify(body));
}

const upstreamRpcUrl = process.env.RPC_RELAY_UPSTREAM_URL || process.env.UPSTREAM_RPC_URL || DEFAULT_UPSTREAM_RPC_URL;
const port = positiveIntEnv("RPC_RELAY_PORT", positiveIntEnv("PORT", 8787));
const requestTimeoutMs = positiveIntEnv("RPC_RELAY_TIMEOUT_MS", 15_000);
const maxBodyBytes = positiveIntEnv("RPC_RELAY_MAX_BODY_BYTES", 2_000_000);
const token = process.env.RPC_RELAY_TOKEN || "";

const server = http.createServer(async (req, res) => {
  const requestId = randomUUID();
  const startedAt = Date.now();

  if (req.method === "GET") {
    writeJson(res, 200, {
      ok: true,
      service: "yieldsense-rpc-relay",
      upstream: maskUrl(upstreamRpcUrl),
      authRequired: Boolean(token),
    });
    return;
  }

  if (req.method !== "POST") {
    writeJson(res, 405, { error: "method_not_allowed" });
    return;
  }

  if (!requestAuthorized(req, token)) {
    log("request_rejected", {
      requestId,
      reason: "unauthorized",
      remoteAddress: req.socket.remoteAddress,
    }, "error");
    writeJson(res, 401, { error: "unauthorized" });
    return;
  }

  let bodyText;
  try {
    bodyText = await readRequestBody(req, maxBodyBytes);
  } catch (error) {
    log("request_rejected", {
      requestId,
      reason: "invalid_body",
      message: error?.message || String(error),
    }, "error");
    writeJson(res, 413, { error: "invalid_body", message: error?.message || String(error) });
    return;
  }

  const parsed = safeJsonParse(bodyText);
  if (!parsed.ok) {
    log("request_rejected", {
      requestId,
      reason: "invalid_json",
      message: parsed.error?.message || String(parsed.error),
      bodyBytes: Buffer.byteLength(bodyText),
    }, "error");
    writeJson(res, 400, { error: "invalid_json" });
    return;
  }

  const calls = extractCalls(parsed.value);
  const sendRawCalls = calls.filter((call) => call.method === "eth_sendRawTransaction");
  const methodCounts = calls.reduce((counts, call) => {
    counts[call.method || "unknown"] = (counts[call.method || "unknown"] || 0) + 1;
    return counts;
  }, {});

  log("request_received", {
    requestId,
    methods: methodCounts,
    bodyBytes: Buffer.byteLength(bodyText),
    remoteAddress: req.socket.remoteAddress,
    upstream: maskUrl(upstreamRpcUrl),
    sendRawTransactions: sendRawCalls.map((call) => ({
      jsonRpcId: call.id,
      ...summarizeRawTx(call.params[0]),
    })),
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), requestTimeoutMs);

  let upstreamResponse;
  let responseText;
  try {
    upstreamResponse = await fetch(upstreamRpcUrl, {
      method: "POST",
      headers: {
        "content-type": req.headers["content-type"] || "application/json",
        accept: "application/json",
      },
      body: bodyText,
      signal: controller.signal,
    });
    responseText = await upstreamResponse.text();
  } catch (error) {
    clearTimeout(timeoutId);
    log("upstream_error", {
      requestId,
      elapsedMs: Date.now() - startedAt,
      methods: methodCounts,
      message: error?.message || String(error),
      name: error?.name,
      sendRawTransactions: sendRawCalls.map((call) => ({
        jsonRpcId: call.id,
        ...summarizeRawTx(call.params[0]),
      })),
    }, "error");
    writeJson(res, 502, {
      jsonrpc: "2.0",
      id: calls.length === 1 ? calls[0].id : null,
      error: {
        code: -32098,
        message: error?.message || String(error),
      },
    });
    return;
  } finally {
    clearTimeout(timeoutId);
  }

  const upstreamLog = {
    requestId,
    elapsedMs: Date.now() - startedAt,
    methods: methodCounts,
    upstreamStatus: upstreamResponse.status,
    upstreamOk: upstreamResponse.ok,
    responseBody: sendRawCalls.length > 0 ? sanitizeRpcResponseBody(responseText) : undefined,
    sendRawTransactions: sendRawCalls.map((call) => ({
      jsonRpcId: call.id,
      ...summarizeRawTx(call.params[0]),
    })),
  };

  log(upstreamResponse.ok ? "upstream_response" : "upstream_http_error", upstreamLog, upstreamResponse.ok ? "info" : "error");

  res.writeHead(upstreamResponse.status, {
    "content-type": upstreamResponse.headers.get("content-type") || "application/json",
  });
  res.end(responseText);
});

server.listen(port, () => {
  log("relay_started", {
    port,
    upstream: maskUrl(upstreamRpcUrl),
    timeoutMs: requestTimeoutMs,
    maxBodyBytes,
    authRequired: Boolean(token),
  });
});

function shutdown(signal) {
  log("relay_shutdown", { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
