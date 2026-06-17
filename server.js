const https = require("https");
const http = require("http");
const url = require("url");

const PORT = process.env.PORT || 3000;
const BITPANDA_KEY = process.env.BITPANDA_API_KEY || "";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-KEY");
}

function bpFetch(path, key) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: "api.bitpanda.com",
      path: path,
      method: "GET",
      headers: { "X-API-KEY": key, "Content-Type": "application/json" }
    };
    const req = https.request(opts, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, data: { raw: data } }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;
  const apiKey = req.headers["x-api-key"] || BITPANDA_KEY;

  // Health check
  if (path === "/" || path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", message: "Bitpanda Proxy läuft ✅", time: new Date().toISOString() }));
    return;
  }

  if (!apiKey) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Kein API-Key." }));
    return;
  }

  try {
    if (path === "/portfolio" || path === "/wallets") {
      // Fetch crypto wallets AND stock/ETF positions in parallel
      const [cryptoRes, stockRes, tradeRes] = await Promise.all([
        bpFetch("/v1/wallets", apiKey),
        bpFetch("/v1/securities", apiKey),           // stocks & ETFs
        bpFetch("/v1/trades?page_size=100", apiKey)  // trade history for avg buy price
      ]);

      // Process crypto wallets
      const cryptoWallets = (cryptoRes.data.data || [])
        .filter(w => parseFloat(w.attributes?.balance || 0) > 0)
        .map(w => ({
          symbol: (w.attributes?.cryptocoin_symbol || "").toUpperCase(),
          name: w.attributes?.name || "",
          amount: parseFloat(w.attributes?.balance || 0),
          type: "crypto",
          source: "bitpanda_wallet"
        }));

      // Process stock/ETF securities
      const stockPositions = (stockRes.data.data || [])
        .filter(s => parseFloat(s.attributes?.quantity || s.attributes?.amount || 0) > 0)
        .map(s => {
          const attrs = s.attributes || {};
          return {
            symbol: (attrs.symbol || attrs.isin || attrs.asset_symbol || "").toUpperCase(),
            name: attrs.name || attrs.asset_name || attrs.symbol || "",
            amount: parseFloat(attrs.quantity || attrs.amount || attrs.shares || 0),
            type: attrs.asset_group?.includes("etf") ? "etf" : "stock",
            isin: attrs.isin || "",
            source: "bitpanda_securities"
          };
        });

      // Calculate average buy prices from trade history
      const trades = (tradeRes.data.data || []);
      const avgPrices = {};
      const tradeCount = {};
      trades.forEach(t => {
        const sym = (t.attributes?.cryptocoin_symbol || t.attributes?.symbol || "").toUpperCase();
        const price = parseFloat(t.attributes?.price || t.attributes?.executed_price || 0);
        const type = (t.attributes?.type || t.attributes?.side || "").toLowerCase();
        if (sym && price > 0 && (type.includes("buy") || type === "buy")) {
          if (!avgPrices[sym]) { avgPrices[sym] = 0; tradeCount[sym] = 0; }
          avgPrices[sym] += price;
          tradeCount[sym]++;
        }
      });
      Object.keys(avgPrices).forEach(sym => {
        avgPrices[sym] = avgPrices[sym] / tradeCount[sym];
      });

      // Combine all positions
      const allPositions = [...cryptoWallets, ...stockPositions].map(p => ({
        ...p,
        buyPrice: avgPrices[p.symbol] || 0
      }));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        positions: allPositions,
        crypto: cryptoWallets,
        stocks: stockPositions,
        avgPrices: avgPrices,
        updated: new Date().toISOString()
      }));
      return;
    }

    // Individual endpoints
    if (path === "/securities") {
      const r = await bpFetch("/v1/securities", apiKey);
      res.writeHead(r.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(r.data));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Route nicht gefunden. Verfügbar: /health, /portfolio, /securities, /wallets" }));

  } catch(e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => console.log(`Bitpanda Proxy läuft auf Port ${PORT}`));
