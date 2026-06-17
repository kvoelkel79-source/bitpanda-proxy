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

// Recursively find all wallets in nested structure
function findAllWallets(obj, results = []) {
  if (!obj || typeof obj !== "object") return results;
  if (Array.isArray(obj)) { obj.forEach(i => findAllWallets(i, results)); return results; }
  if (obj.type === "wallet" && obj.attributes) { results.push(obj); return results; }
  Object.values(obj).forEach(v => findAllWallets(v, results));
  return results;
}

function parsePositions(d) {
  const positions = [];
  const attrs = d?.data?.attributes || {};
  const allGroups = Object.keys(attrs);

  allGroups.forEach(groupKey => {
    const wallets = findAllWallets(attrs[groupKey]);
    wallets.forEach(w => {
      const a = w.attributes || {};
      const balance = parseFloat(a.balance || a.quantity || a.shares || 0);
      if (balance <= 0.000001) return;
      const sym = (a.cryptocoin_symbol || a.symbol || a.asset_symbol || "").toUpperCase();
      if (!sym || sym === "EUR" || sym === "BEST") return;

      let type = "crypto";
      if (groupKey.includes("stock") || groupKey.includes("equity") || groupKey === "security") type = "stock";
      else if (groupKey.includes("etf")) type = "etf";
      else if (groupKey.includes("commodity") || groupKey.includes("metal")) type = "commodity";

      positions.push({
        symbol: sym,
        name: a.name || a.asset_name || sym,
        amount: balance,
        type,
        isin: a.isin || "",
        walletId: w.id || ""
      });
    });
  });
  return positions;
}

// Calculate per-unit buy price and total invested from trades
// Bitpanda trades: amount_fiat = total EUR paid, amount_cryptocoin = units received
function calcBuyData(trades) {
  // Group by wallet_id: collect all buy trades
  const byWallet = {};
  trades.forEach(t => {
    const a = t.attributes || {};
    const type = (a.type || "").toLowerCase();
    if (type !== "buy") return;

    const walletId = a.wallet_id || "";
    const amtFiat = parseFloat(a.amount_fiat || 0);      // total EUR paid
    const amtUnits = parseFloat(a.amount_cryptocoin || 0); // units received
    const feeAmt = parseFloat(a.fee?.attributes?.fee_amount || a.trading_fee || 0);

    if (!walletId || amtFiat <= 0 || amtUnits <= 0) return;

    if (!byWallet[walletId]) byWallet[walletId] = { totalFiat: 0, totalUnits: 0 };
    byWallet[walletId].totalFiat += amtFiat;
    byWallet[walletId].totalUnits += amtUnits;
  });

  // Calculate avg price per unit and total invested per wallet
  const result = {};
  Object.keys(byWallet).forEach(wid => {
    const { totalFiat, totalUnits } = byWallet[wid];
    result[wid] = {
      pricePerUnit: totalUnits > 0 ? totalFiat / totalUnits : 0,  // avg EUR per unit
      totalInvested: totalFiat                                      // total EUR spent
    };
  });
  return result;
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;
  const apiKey = req.headers["x-api-key"] || BITPANDA_KEY;

  if (path === "/" || path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", message: "Bitpanda Proxy v4 ✅", time: new Date().toISOString() }));
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

      const positions = parsePositions(awRes.data);
      const trades = tradeRes.data?.data || [];
      const buyData = calcBuyData(trades);

      // Match positions to buy data via walletId
      positions.forEach(p => {
        const bd = buyData[p.walletId];
        if (bd) {
          p.pricePerUnit = parseFloat(bd.pricePerUnit.toFixed(4));  // avg EUR per unit
          p.totalInvested = parseFloat(bd.totalInvested.toFixed(2)); // total EUR spent
          p.buyPrice = p.pricePerUnit; // keep for compatibility
        } else {
          p.pricePerUnit = 0;
          p.totalInvested = 0;
          p.buyPrice = 0;
        }
      });

      const groups = Object.keys(awRes.data?.data?.attributes || {});

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        positions,
        debug: {
          assetGroups: groups,
          positionCount: positions.length,
          tradeCount: trades.length
        },
        updated: new Date().toISOString()
      }));
      return;
    }

    if (path === "/debug") {
      const r = await bpFetch("/v1/asset-wallets", apiKey);
      const positions = parsePositions(r.data);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: r.status,
        assetGroups: Object.keys(r.data?.data?.attributes || {}),
        positionsFound: positions
      }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Route nicht gefunden. Verfügbar: /health, /portfolio, /debug" }));

  } catch(e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => console.log(`Bitpanda Proxy v4 läuft auf Port ${PORT}`));
