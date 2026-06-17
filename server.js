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
        catch(e) { resolve({ status: res.statusCode, data: { raw: data.slice(0,200) } }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// Extract positions from asset-wallets response
function parseAssetWallets(d) {
  const positions = [];
  const attrs = d?.data?.attributes || {};

  // Crypto
  const cryptoWallets = attrs?.cryptocoin?.attributes?.wallets || [];
  cryptoWallets.forEach(w => {
    const a = w.attributes || {};
    const bal = parseFloat(a.balance || 0);
    const sym = (a.cryptocoin_symbol || "").toUpperCase();
    if (bal > 0.000001 && sym && sym !== "EUR") {
      positions.push({ symbol: sym, name: a.name || sym, amount: bal, type: "crypto" });
    }
  });

  // Securities (stocks, ETFs)
  const secWallets = attrs?.security?.attributes?.wallets ||
                     attrs?.equity?.attributes?.wallets ||
                     attrs?.stock?.attributes?.wallets || [];
  secWallets.forEach(w => {
    const a = w.attributes || {};
    const qty = parseFloat(a.quantity || a.balance || a.shares || 0);
    const sym = (a.symbol || a.asset_symbol || a.cryptocoin_symbol || "").toUpperCase();
    const assetType = (a.asset_group || a.type || "stock").toLowerCase();
    if (qty > 0 && sym) {
      positions.push({
        symbol: sym,
        name: a.name || a.asset_name || sym,
        amount: qty,
        type: assetType.includes("etf") ? "etf" : "stock",
        isin: a.isin || ""
      });
    }
  });

  // ETFs separately if grouped
  const etfWallets = attrs?.etf?.attributes?.wallets || [];
  etfWallets.forEach(w => {
    const a = w.attributes || {};
    const qty = parseFloat(a.quantity || a.balance || 0);
    const sym = (a.symbol || a.asset_symbol || "").toUpperCase();
    if (qty > 0 && sym) {
      positions.push({ symbol: sym, name: a.name || sym, amount: qty, type: "etf" });
    }
  });

  // Commodities/Metals
  const metWallets = attrs?.commodity?.attributes?.wallets || attrs?.metal?.attributes?.wallets || [];
  metWallets.forEach(w => {
    const a = w.attributes || {};
    const bal = parseFloat(a.balance || 0);
    const sym = (a.cryptocoin_symbol || a.symbol || "").toUpperCase();
    if (bal > 0 && sym) {
      positions.push({ symbol: sym, name: a.name || sym, amount: bal, type: "commodity" });
    }
  });

  return positions;
}

// Calculate avg buy prices from trades
function calcAvgPrices(trades) {
  const totals = {};
  const counts = {};
  trades.forEach(t => {
    const a = t.attributes || {};
    const type = (a.type || "").toLowerCase();
    if (type !== "buy") return;
    // Try to get symbol from wallet_id lookup or cryptocoin_id
    // Use amount_fiat / amount_cryptocoin = price
    const amtCrypto = parseFloat(a.amount_cryptocoin || 0);
    const amtFiat = parseFloat(a.amount_fiat || 0);
    const price = parseFloat(a.price || (amtCrypto > 0 ? amtFiat / amtCrypto : 0));
    // We need symbol – it comes from wallet mapping, use cryptocoin_id as key for now
    const key = a.wallet_id || a.cryptocoin_id || "";
    if (key && price > 0) {
      totals[key] = (totals[key] || 0) + price;
      counts[key] = (counts[key] || 0) + 1;
    }
  });
  const avg = {};
  Object.keys(totals).forEach(k => { avg[k] = totals[k] / counts[k]; });
  return avg;
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;
  const apiKey = req.headers["x-api-key"] || BITPANDA_KEY;

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
      // Use /asset-wallets which returns ALL asset types grouped
      const [awRes, tradeRes] = await Promise.all([
        bpFetch("/v1/asset-wallets", apiKey),
        bpFetch("/v1/trades?page_size=100", apiKey)
      ]);

      // Debug: include raw response structure
      const rawKeys = Object.keys(awRes.data?.data?.attributes || {});

      // Parse all positions
      const positions = parseAssetWallets(awRes.data);

      // Avg buy prices from trades
      const trades = tradeRes.data?.data || [];
      const avgPrices = calcAvgPrices(trades);

      // Add buy prices where available
      positions.forEach(p => {
        if (!p.buyPrice) p.buyPrice = 0; // will be filled from trades via wallet_id
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        positions,
        avgPrices,
        debug: {
          assetWalletStatus: awRes.status,
          assetGroups: rawKeys,
          tradeCount: trades.length,
          positionCount: positions.length
        },
        updated: new Date().toISOString()
      }));
      return;
    }

    // Debug: raw asset-wallets dump
    if (path === "/debug") {
      const r = await bpFetch("/v1/asset-wallets", apiKey);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: r.status, keys: Object.keys(r.data?.data?.attributes || {}), raw: r.data }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Route nicht gefunden. Verfügbar: /health, /portfolio, /debug" }));

  } catch(e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => console.log(`Bitpanda Proxy läuft auf Port ${PORT}`));
