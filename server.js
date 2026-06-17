const https = require("https");
const http = require("http");
const url = require("url");

const PORT = process.env.PORT || 3000;
const BITPANDA_KEY = process.env.BITPANDA_API_KEY || "";

// Simple CORS helper
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-KEY");
}

// Fetch from Bitpanda API
function bitpandaFetch(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.bitpanda.com",
      path: path,
      method: "GET",
      headers: {
        "X-API-KEY": BITPANDA_KEY,
        "Content-Type": "application/json"
      }
    };
    const req = https.request(options, res => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, data: { error: data } }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  cors(res);

  // Handle preflight
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;

  // Health check
  if (path === "/" || path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", message: "Bitpanda Proxy läuft ✅", time: new Date().toISOString() }));
    return;
  }

  // Optional: allow per-request API key via header (if no server key set)
  const apiKey = req.headers["x-api-key"] || BITPANDA_KEY;
  if (!apiKey) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Kein Bitpanda API-Key konfiguriert." }));
    return;
  }

  // Override key for this request if passed via header
  if (req.headers["x-api-key"]) {
    // Use per-request key
    const options = {
      hostname: "api.bitpanda.com",
      path: path.replace("/proxy", ""),
      method: "GET",
      headers: { "X-API-KEY": req.headers["x-api-key"], "Content-Type": "application/json" }
    };
    const result = await new Promise((resolve, reject) => {
      const r = https.request(options, resp => {
        let d = "";
        resp.on("data", c => d += c);
        resp.on("end", () => {
          try { resolve({ status: resp.statusCode, data: JSON.parse(d) }); }
          catch(e) { resolve({ status: resp.statusCode, data: { raw: d } }); }
        });
      });
      r.on("error", reject);
      r.end();
    });
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.data));
    return;
  }

  // Proxy routes using server-side key
  try {
    let result;
    if (path === "/wallets" || path === "/proxy/v1/wallets") {
      result = await bitpandaFetch("/v1/wallets");
    } else if (path === "/trades" || path === "/proxy/v1/trades") {
      result = await bitpandaFetch("/v1/trades");
    } else if (path === "/transactions" || path === "/proxy/v1/transactions") {
      result = await bitpandaFetch("/v1/transactions");
    } else if (path === "/portfolio" || path === "/proxy/v1/portfolio") {
      // Fetch wallets + trades together
      const [wallets, trades] = await Promise.all([
        bitpandaFetch("/v1/wallets"),
        bitpandaFetch("/v1/trades")
      ]);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ wallets: wallets.data, trades: trades.data, updated: new Date().toISOString() }));
      return;
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Route nicht gefunden. Verfügbar: /wallets, /trades, /portfolio" }));
      return;
    }
    res.writeHead(result.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.data));
  } catch(e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => console.log(`Bitpanda Proxy läuft auf Port ${PORT}`));
