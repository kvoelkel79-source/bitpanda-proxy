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

// Recursively find all wallets
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
  Object.keys(attrs).forEach(groupKey => {
    findAllWallets(attrs[groupKey]).forEach(w => {
      const a = w.attributes || {};
      const balance = parseFloat(a.balance || a.quantity || a.shares || 0);
      if (balance <= 0.000001) return;
      const sym = (a.cryptocoin_symbol || a.symbol || a.asset_symbol || "").toUpperCase();
      if (!sym || sym === "EUR" || sym === "BEST") return;
      let type = "crypto";
      if (groupKey.includes("stock") || groupKey.includes("equity") || groupKey === "security") type = "stock";
      else if (groupKey.includes("etf")) type = "etf";
      else if (groupKey.includes("commodity") || groupKey.includes("metal")) type = "commodity";
      positions.push({ symbol: sym, name: a.name || a.asset_name || sym, amount: balance, type, walletId: w.id || "", isin: a.isin || "" });
    });
  });
  return positions;
}

// Calculate buy data from trades
// amount_fiat = total EUR paid (incl. fee), amount_cryptocoin = units received
// fee is read directly from trade data and subtracted for accurate price per unit
function calcBuyData(trades) {
  const byWallet = {};

  trades.forEach(t => {
    const a = t.attributes || {};
    const tradeType = (a.type || a.side || "").toLowerCase();
    if (!tradeType.includes("buy")) return;

    const walletId = a.wallet_id || "";
    if (!walletId) return;

    const amtFiat  = parseFloat(a.amount_fiat || 0);   // total EUR paid incl. fee
    const amtUnits = parseFloat(a.amount_cryptocoin || 0); // units received

    // Extract fee from multiple possible locations in API response
    const fee = parseFloat(
      a.fee?.attributes?.fee_amount ||  // nested fee object
      a.trading_fee ||                   // flat field
      a.fee_amount ||                    // alternative flat field
      a.fee ||                           // simple fee field
      0
    );

    if (amtFiat <= 0 || amtUnits <= 0) return;

    // Net amount = what you actually paid for the asset (without fee)
    const netFiat = amtFiat - fee;

    if (!byWallet[walletId]) {
      byWallet[walletId] = { totalFiat: 0, totalNetFiat: 0, totalUnits: 0, totalFee: 0 };
    }
    byWallet[walletId].totalFiat    += amtFiat;   // gross (incl. fee)
    byWallet[walletId].totalNetFiat += netFiat;   // net (excl. fee)
    byWallet[walletId].totalUnits   += amtUnits;
    byWallet[walletId].totalFee     += fee;
  });

  // Result per wallet:
  // totalInvested = gross EUR paid incl. fee (what left your account)
  // pricePerUnit  = netFiat / units = real market price per unit
  // totalFee      = total fees paid
  const result = {};
  Object.keys(byWallet).forEach(wid => {
    const { totalFiat, totalNetFiat, totalUnits, totalFee } = byWallet[wid];
    result[wid] = {
      totalInvested: parseFloat(totalFiat.toFixed(2)),
      pricePerUnit:  parseFloat((totalNetFiat / totalUnits).toFixed(4)),
      totalFee:      parseFloat(totalFee.toFixed(2))
    };
  });
  return result;
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const parsed = url.parse(req.url, true);
  const path   = parsed.pathname;
  const apiKey = req.headers["x-api-key"] || BITPANDA_KEY;

  if (path === "/" || path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", message: "Bitpanda Proxy v5 ✅", time: new Date().toISOString() }));
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
      const trades    = tradeRes.data?.data || [];
      const buyData   = calcBuyData(trades);

      // Match each position to its buy data via walletId
      positions.forEach(p => {
        const bd = buyData[p.walletId];
        if (bd) {
          p.pricePerUnit  = bd.pricePerUnit;   // real market price per unit (excl. fee)
          p.totalInvested = bd.totalInvested;  // gross EUR paid (incl. fee)
          p.totalFee      = bd.totalFee;       // total trading fee paid
          p.buyPrice      = bd.pricePerUnit;   // alias for compatibility
        } else {
          p.pricePerUnit  = 0;
          p.totalInvested = 0;
          p.totalFee      = 0;
          p.buyPrice      = 0;
        }
      });

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        positions,
        debug: {
          assetGroups: Object.keys(awRes.data?.data?.attributes || {}),
          positionCount: positions.length,
          tradeCount: trades.length,
          // Show first trade raw so we can verify field names
          sampleTrade: trades[0]?.attributes || null
        },
        updated: new Date().toISOString()
      }));
      return;
    }

    // Raw trade debug – shows exact field names from Bitpanda
    if (path === "/trades-debug") {
      const r = await bpFetch("/v1/trades?page_size=5", apiKey);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        count: r.data?.data?.length || 0,
        trades: (r.data?.data || []).map(t => t.attributes)
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
    res.end(JSON.stringify({ error: "Verfügbar: /health /portfolio /debug /trades-debug" }));

  } catch(e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => console.log(`Bitpanda Proxy v5 läuft auf Port ${PORT}`));
