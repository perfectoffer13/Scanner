import { getStore } from "@netlify/blobs";

const STORE_NAME = "diagnostics";
const MAX_BODY_CHARS = 120000;
const MAX_EVENTS = 200;
const MAX_EVENT_CHARS = 5000;
const ALLOWED_ORIGIN = "https://backbar-product-scanner.netlify.app";

function truncate(value, maxLength) {
  return String(value ?? "").slice(0, maxLength);
}

function cleanValue(value, depth = 0) {
  if (depth > 5) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncate(value, MAX_EVENT_CHARS);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => cleanValue(item, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 60)
        .map(([key, item]) => [
          truncate(key, 100),
          cleanValue(item, depth + 1),
        ]),
    );
  }
  return truncate(value, 100);
}

function response(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export default async function diagnostics(request) {
  const store = getStore(STORE_NAME);

  if (request.method === "GET") {
    const url = new URL(request.url);
    const suppliedKey =
      request.headers.get("x-diagnostics-key") || url.searchParams.get("key") || "";
    const expectedKey = process.env.DIAGNOSTICS_READ_KEY || "";

    if (!expectedKey || suppliedKey !== expectedKey) {
      return response(401, { ok: false, error: "Diagnostic read key required" });
    }

    try {
      const latest = await store.get("latest.json", {
        consistency: "strong",
        type: "text",
      });
      if (!latest) {
        return response(404, { ok: false, error: "No diagnostic snapshot stored" });
      }
      return new Response(latest, {
        status: 200,
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    } catch (error) {
      return response(500, {
        ok: false,
        error: "Could not read diagnostic payload",
        detail: truncate(error?.message || error, 300),
      });
    }
  }

  if (request.method !== "POST") {
    return response(405, { ok: false, error: "POST required" });
  }

  const origin = request.headers.get("origin");
  if (origin && origin !== ALLOWED_ORIGIN) {
    return response(403, { ok: false, error: "Origin not allowed" });
  }

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return response(415, { ok: false, error: "application/json required" });
  }

  const rawBody = await request.text();
  if (rawBody.length > MAX_BODY_CHARS) {
    return response(413, { ok: false, error: "Diagnostic payload too large" });
  }

  let incoming;
  try {
    incoming = JSON.parse(rawBody);
  } catch {
    return response(400, { ok: false, error: "Invalid JSON" });
  }

  if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
    return response(400, { ok: false, error: "Diagnostic object required" });
  }

  const sessionId =
    truncate(incoming.sessionId || "unknown-session", 120)
      .replace(/[^a-zA-Z0-9._-]/g, "_") || "unknown-session";
  const savedAt = new Date().toISOString();
  const events = Array.isArray(incoming.events)
    ? incoming.events.slice(-MAX_EVENTS).map((event) => cleanValue(event))
    : [];

  const payload = {
    diagnosticSchemaVersion: Number(incoming.diagnosticSchemaVersion) || 1,
    app: truncate(incoming.app || "backbar-product-identification", 120),
    sessionId,
    exportedAt: truncate(incoming.exportedAt || "", 80),
    uploadedAt: savedAt,
    uploadReason: truncate(incoming.uploadReason || "scheduled", 120),
    clientPath: truncate(incoming.clientPath || "", 300),
    environment: cleanValue(incoming.environment || {}),
    events,
  };

  const serialized = JSON.stringify(payload);
  if (serialized.length > MAX_BODY_CHARS) {
    return response(413, { ok: false, error: "Sanitized diagnostic payload too large" });
  }

  try {
    const sessionKey = `sessions/${sessionId}.json`;
    await store.set(sessionKey, serialized);
    await store.set("latest.json", serialized);

    return response(201, {
      ok: true,
      stored: true,
      sessionId,
      key: sessionKey,
      savedAt,
    });
  } catch (error) {
    return response(500, {
      ok: false,
      error: "Could not store diagnostic payload",
      detail: truncate(error?.message || error, 300),
    });
  }
}

export const config = {
  path: "/.netlify/functions/diagnostics",
};
