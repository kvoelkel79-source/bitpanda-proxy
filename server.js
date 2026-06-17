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
        catch(e) { resolve({ status: res.statusCode, data: { raw: data.slice(0,500) } }); }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

// Recursively find all wallets in any nested structure
function findAllWallets(obj, results = []) {
  if (!obj || typeof obj !== "object") return results;
  if (Array.isArray(obj)) {
    obj.forEach(item => findAllWallets(item, results));
    return results;
  }
  // If this looks like a wallet (has balance or quantity and a symbol)
  if (obj.type === "wallet" && obj.attributes) {
    results.push(obj);
    return results;
  }
  // Recurse into all keys
  Object.values(obj).forEach(v => findAllWallets(v, results));
  return results;
}

function parsePositions(d) {
  const positions = [];
  const attrs = d?.data?.attributes || {};

  // Known asset group keys from debug response:
  // cryptocoin, commodity, index, security, equity_security,
  // etf, et_c, mutual_fund, stock, fiat_earn, equity_stock,
  // equity_etf, equity_right, equity_complex_etf, equity_complex_etc

  const allGroups = Object.keys(attrs);

  allGroups.forEach(groupKey => {
    const group = attrs[groupKey];
    if (!group) return;

    // Find all wallets in this group recursively
    const wallets = findAllWallets(group);

    wallets.forEach(w => {
      const a = w.attributes || {};
      const balance = parseFloat(a.balance || a.quantity || a.shares || 0);
      if (balance <= 0.000001) return;

      const sym = (a.cryptocoin_symbol || a.symbol || a.asset_symbol || "").toUpperCase();
      if (!sym || sym === "EUR" || sym === "BEST") return;

      // Determine type from group key
      let type = "crypto";
      if (groupKey.includes("stock") || groupKey.includes("equity") || groupKey === "security") {
        type = "stock";
      } else if (groupKey.includes("etf")) {
        type = "etf";
      } else if (groupKey.includes("commodity") || groupKey.includes("metal")) {
        type = "commodity";
      }

      positions.push({
        symbol: sym,
        name: a.name || a.asset_name || sym,
        amount: balance,
        type: type,
        group: groupKey,
        isin: a.isin || "",
        walletId: w.id || ""
      });
    });
  });

  return positions;
}

// Calculate avg buy prices from trades
function calcAvgPrices(trades) {
  const totals = {};
  const counts = {};
  trades.forEach(t => {
    const a = t.attributes || {};
    if ((a.type || "").toLowerCase() !== "buy") return;
    const amtCrypto = parseFloat(a.amount_cryptocoin || 0);
    const amtFiat   = parseFloat(a.amount_fiat || 0);
    const price     = parseFloat(a.price || (amtCrypto > 0 ? amtFiat / amtCrypto : 0));
    const walletId  = a.wallet_id || "";
    if (walletId && price > 0) {
      totals[walletId] = (totals[walletId] || 0) + price;
      counts[walletId] = (counts[walletId] || 0) + 1;
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
  const path   = parsed.pathname;
  const apiKey = req.headers["x-api-key"] || BITPANDA_KEY;

  if (path === "/" || path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", message: "Bitpanda Proxy v3 läuft ✅", time: new Date().toISOString() }));
    return;
  }

  if (!apiKey) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Kein API-Key." }));
    return;
  }

  try {
    if (path === "/portfolio" || path === "/wallets") {
      const [awRes, tradeRes] = await Promise.all([
        bpFetch("/v1/asset-wallets", apiKey),
        bpFetch("/v1/trades?page_size=100", apiKey)
      ]);

      const positions  = parsePositions(awRes.data);
      const trades     = tradeRes.data?.data || [];
      const avgByWallet = calcAvgPrices(trades);

      // Map wallet avg prices to positions
      positions.forEach(p => {
        if (p.walletId && avgByWallet[p.walletId]) {
          p.buyPrice = parseFloat(avgByWallet[p.walletId].toFixed(4));
        } else {
          p.buyPrice = 0;
        }
      });

      const groups = Object.keys(awRes.data?.data?.attributes || {});

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        positions,
        avgPrices: avgByWallet,
        debug: {
          assetGroups: groups,
          positionCount: positions.length,
          tradeCount: trades.length,
          positionsByGroup: positions.reduce((acc, p) => {
            acc[p.group] = (acc[p.group] || 0) + 1;
            return acc;
          }, {})
        },
        updated: new Date().toISOString()
      }));
      return;
    }

    // Full debug dump
    if (path === "/debug") {
      const r = await bpFetch("/v1/asset-wallets", apiKey);
      const groups = Object.keys(r.data?.data?.attributes || {});
      const positions = parsePositions(r.data);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: r.status,
        assetGroups: groups,
        positionsFound: positions,
        raw: r.data
      }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Route nicht gefunden. Verfügbar: /health, /portfolio, /debug" }));

  } catch(e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message, stack: e.stack }));
  }
});

server.listen(PORT, () => console.log(`Bitpanda Proxy v3 läuft auf Port ${PORT}`));
