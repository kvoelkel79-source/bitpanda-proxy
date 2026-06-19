const https = require("https");
const http  = require("http");
const url   = require("url");

const PORT          = process.env.PORT || 3000;
const BITPANDA_KEY  = process.env.BITPANDA_API_KEY || "";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-KEY, X-ANTHROPIC-KEY");
}

function fetchJson(hostname, path, headers={}) {
  return new Promise((resolve, reject) => {
    const opts = { hostname, path, method:"GET", headers:{"Content-Type":"application/json",...headers} };
    const req = https.request(opts, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, data: { raw: data.slice(0,300) } }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error("Timeout")); });
    req.end();
  });
}

function postJson(hostname, path, body, headers={}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const opts = {
      hostname, path, method:"POST",
      headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(payload),...headers}
    };
    const req = https.request(opts, res => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch(e) { resolve({ status: res.statusCode, data: { raw: data.slice(0,300) } }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("AI Timeout")); });
    req.write(payload);
    req.end();
  });
}

function bpFetch(path, key) {
  return fetchJson("api.bitpanda.com", path, {"X-API-KEY": key});
}

// Yahoo Finance – unbegrenzte kostenlose Aktienkurse, kein API-Key nötig
async function getStockPriceYahoo(symbol) {
  try {
    // Convert SAP-DE → SAP.DE for Yahoo Finance
    const yahooSymbol = symbol.replace(/-([A-Z]{2})$/, ".$1");
    const r = await fetchJson("query1.finance.yahoo.com",
      `/v8/finance/chart/${yahooSymbol}?interval=1d&range=1d`,
      {"User-Agent": "Mozilla/5.0"}
    );
    const meta = r.data?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const priceUSD = meta.regularMarketPrice || meta.previousClose;
    if (!priceUSD) return null;
    // Get EUR/USD rate
    const fxR = await fetchJson("query1.finance.yahoo.com",
      `/v8/finance/chart/EURUSD=X?interval=1d&range=1d`,
      {"User-Agent": "Mozilla/5.0"}
    );
    const eurUsd = fxR.data?.chart?.result?.[0]?.meta?.regularMarketPrice || 1.08;
    const priceEUR = priceUSD / eurUsd;
    const prevClose = meta.chartPreviousClose || meta.previousClose || priceUSD;
    const change24h = ((priceUSD - prevClose) / prevClose) * 100;
    return {
      symbol,
      priceUSD: parseFloat(priceUSD.toFixed(4)),
      priceEUR: parseFloat(priceEUR.toFixed(4)),
      change24h: parseFloat(change24h.toFixed(2)),
      currency: meta.currency || "USD",
      exchange: meta.exchangeName || "",
      lastUpdated: new Date().toLocaleTimeString("de-DE")
    };
  } catch(e) { return null; }
}

// Batch stock prices via Yahoo Finance
async function getStockPricesYahoo(symbols) {
  const results = {};
  await Promise.all(symbols.map(async sym => {
    const data = await getStockPriceYahoo(sym);
    if (data) results[sym] = data;
  }));
  return results;
}

// ── Data Sources ──────────────────────────────────────────────────────────────

// 1. CoinGecko – Fear & Greed + Market data
async function getCryptoData(symbol) {
  try {
    const slugMap = {BTC:"bitcoin",ETH:"ethereum",SOL:"solana",BNB:"binancecoin",
      XRP:"ripple",ADA:"cardano",DOGE:"dogecoin",AVAX:"avalanche-2",LINK:"chainlink",MATIC:"matic-network"};
    const slug = slugMap[symbol.toUpperCase()] || symbol.toLowerCase();
    const r = await fetchJson("api.coingecko.com",
      `/api/v3/coins/${slug}?localization=false&tickers=false&community_data=true&developer_data=false`);
    if (!r.data.market_data) return null;
    const md = r.data.market_data;
    return {
      price: md.current_price?.eur,
      change24h: md.price_change_percentage_24h,
      change7d: md.price_change_percentage_7d,
      volume24h: md.total_volume?.eur,
      marketCap: md.market_cap?.eur,
      high24h: md.high_24h?.eur,
      low24h: md.low_24h?.eur,
      sentiment_up: r.data.sentiment_votes_up_percentage,
      sentiment_down: r.data.sentiment_votes_down_percentage,
    };
  } catch(e) { return null; }
}

// 2. Fear & Greed Index
async function getFearGreed() {
  try {
    const r = await fetchJson("api.alternative.me", "/fng/?limit=2");
    const data = r.data?.data || [];
    return {
      value: parseInt(data[0]?.value || 50),
      classification: data[0]?.value_classification || "Neutral",
      yesterday: parseInt(data[1]?.value || 50)
    };
  } catch(e) { return { value:50, classification:"Neutral", yesterday:50 }; }
}

// 3. Binance Orderbook pressure
async function getOrderbookPressure(symbol) {
  try {
    const pair = symbol.toUpperCase()+"USDT";
    const r = await fetchJson("api.binance.com", `/api/v3/depth?symbol=${pair}&limit=20`);
    if (!r.data.bids) return null;
    const bidVol = r.data.bids.reduce((s,b) => s + parseFloat(b[0])*parseFloat(b[1]), 0);
    const askVol = r.data.asks.reduce((s,a) => s + parseFloat(a[0])*parseFloat(a[1]), 0);
    const total = bidVol + askVol;
    const buyPct = total > 0 ? Math.round(bidVol/total*100) : 50;
    return { buyPct, sellPct: 100-buyPct, pressure: buyPct>=60?"bullish":buyPct<=40?"bearish":"neutral" };
  } catch(e) { return null; }
}

// 4. Binance 24h ticker (volume + price momentum)
async function getBinanceTicker(symbol) {
  try {
    const pair = symbol.toUpperCase()+"USDT";
    const r = await fetchJson("api.binance.com", `/api/v3/ticker/24hr?symbol=${pair}`);
    if (!r.data.priceChangePercent) return null;
    return {
      changePercent: parseFloat(r.data.priceChangePercent),
      volume: parseFloat(r.data.volume),
      quoteVolume: parseFloat(r.data.quoteVolume),
      trades: parseInt(r.data.count),
      high: parseFloat(r.data.highPrice),
      low: parseFloat(r.data.lowPrice),
    };
  } catch(e) { return null; }
}

// 5. SEC EDGAR – Insider transactions (last 7 days, US stocks)
async function getInsiderData(symbol) {
  try {
    // Search for company CIK by ticker
    const search = await fetchJson("efts.sec.gov",
      `/efts/hits.json?q=%22${symbol}%22&dateRange=custom&startdt=${getDateStr(-7)}&enddt=${getDateStr(0)}&forms=4`);
    const hits = search.data?.hits?.hits || [];
    const buys = hits.filter(h => {
      const src = h._source || {};
      return (src.period_of_report || "") && src.entity_name;
    }).slice(0,5);
    return {
      recentFilings: buys.length,
      signal: buys.length >= 2 ? "bullish" : buys.length === 1 ? "neutral" : "no_data",
      filings: buys.map(h => ({ name: h._source?.entity_name, date: h._source?.period_of_report }))
    };
  } catch(e) { return { recentFilings:0, signal:"no_data", filings:[] }; }
}

// 6. StockTwits sentiment
async function getStockTwitsSentiment(symbol) {
  try {
    const r = await fetchJson("api.stocktwits.com", `/api/2/streams/symbol/${symbol}.json`);
    const msgs = r.data?.messages || [];
    let bull=0, bear=0;
    msgs.forEach(m => {
      const s = m.entities?.sentiment?.basic;
      if(s === "Bullish") bull++;
      else if(s === "Bearish") bear++;
    });
    const total = bull+bear;
    const bullPct = total>0 ? Math.round(bull/total*100) : 50;
    return {
      bullish: bull, bearish: bear, bullPct,
      signal: bullPct>=65?"bullish":bullPct<=35?"bearish":"neutral",
      messageCount: msgs.length
    };
  } catch(e) { return null; }
}

// 7. Reddit mentions (via pushshift-compatible)
async function getRedditMentions(symbol) {
  try {
    const r = await fetchJson("www.reddit.com",
      `/search.json?q=${symbol}&sort=new&t=day&limit=25`,
      {"User-Agent":"FinanzMonitor/1.0"});
    const posts = r.data?.data?.children || [];
    let bullCount=0, bearCount=0;
    const bullWords = ["buy","bull","moon","pump","long","calls","squeeze","breakout"];
    const bearWords = ["sell","bear","short","dump","puts","crash","drop","down"];
    posts.forEach(p => {
      const text = ((p.data?.title||"")+" "+(p.data?.selftext||"")).toLowerCase();
      bullWords.forEach(w => { if(text.includes(w)) bullCount++; });
      bearWords.forEach(w => { if(text.includes(w)) bearCount++; });
    });
    const total = bullCount+bearCount;
    const bullPct = total>0 ? Math.round(bullCount/total*100) : 50;
    return { mentions: posts.length, bullPct, signal: bullPct>=60?"bullish":bullPct<=40?"bearish":"neutral" };
  } catch(e) { return { mentions:0, bullPct:50, signal:"neutral" }; }
}

// 8. Alpha Vantage RSI + MACD (for stocks)
async function getTechnicalIndicators(symbol, avKey) {
  if(!avKey) return null;
  try {
    const [rsiR, macdR] = await Promise.all([
      fetchJson("www.alphavantage.co", `/query?function=RSI&symbol=${symbol}&interval=daily&time_period=14&series_type=close&apikey=${avKey}`),
      fetchJson("www.alphavantage.co", `/query?function=MACD&symbol=${symbol}&interval=daily&series_type=close&apikey=${avKey}`)
    ]);
    const rsiData = Object.values(rsiR.data?.["Technical Analysis: RSI"]||{})[0];
    const macdData = Object.values(macdR.data?.["Technical Analysis: MACD"]||{})[0];
    const rsi = rsiData ? parseFloat(rsiData.RSI) : null;
    const macd = macdData ? parseFloat(macdData.MACD) : null;
    const signal = macdData ? parseFloat(macdData.Signal) : null;
    return {
      rsi,
      rsiSignal: rsi ? (rsi<30?"oversold_bullish":rsi>70?"overbought_bearish":"neutral") : "no_data",
      macdCrossover: (macd && signal) ? (macd>signal?"bullish":"bearish") : "no_data",
      macd, macdSignal: signal
    };
  } catch(e) { return null; }
}

// ── Score Calculator ──────────────────────────────────────────────────────────
function calcScore(signals, type) {
  let score = 50; // neutral baseline
  let factors = [];

  // Technical (25%)
  if(signals.technical) {
    const t = signals.technical;
    if(t.rsiSignal === "oversold_bullish")  { score += 12; factors.push("RSI ueberkauft bullish"); }
    if(t.rsiSignal === "overbought_bearish"){ score -= 12; factors.push("RSI ueberkauft bearish"); }
    if(t.macdCrossover === "bullish")       { score += 8;  factors.push("MACD Kaufsignal"); }
    if(t.macdCrossover === "bearish")       { score -= 8;  factors.push("MACD Verkaufssignal"); }
  }

  // Orderbook (20%) – crypto only
  if(signals.orderbook) {
    const ob = signals.orderbook;
    if(ob.buyPct >= 65) { score += 10; factors.push(`Kaufdruck ${ob.buyPct}%`); }
    if(ob.buyPct <= 35) { score -= 10; factors.push(`Verkaufsdruck ${100-ob.buyPct}%`); }
    if(ob.buyPct >= 75) { score += 5; }
    if(ob.buyPct <= 25) { score -= 5; }
  }

  // Market momentum (15%)
  if(signals.ticker) {
    const t = signals.ticker;
    if(t.changePercent >= 3)  { score += 8; factors.push(`+${t.changePercent.toFixed(1)}% 24h Momentum`); }
    if(t.changePercent <= -3) { score -= 8; factors.push(`${t.changePercent.toFixed(1)}% 24h Schwaeche`); }
  }
  if(signals.cryptoData) {
    const c = signals.cryptoData;
    if(c.change7d >= 5)  { score += 5; factors.push(`+${c.change7d?.toFixed(1)}% 7-Tage-Trend`); }
    if(c.change7d <= -5) { score -= 5; }
    if(c.sentiment_up > 65) { score += 5; factors.push(`${c.sentiment_up?.toFixed(0)}% bullishes CoinGecko-Sentiment`); }
  }

  // Fear & Greed (10%) – crypto
  if(signals.fearGreed && type === "crypto") {
    const fg = signals.fearGreed;
    if(fg.value >= 65) { score += 5; factors.push(`Fear&Greed: ${fg.value} (${fg.classification})`); }
    if(fg.value <= 35) { score -= 5; factors.push(`Fear&Greed: ${fg.value} (${fg.classification})`); }
  }

  // Insider (15%) – stocks
  if(signals.insider && type === "stock") {
    if(signals.insider.signal === "bullish") { score += 12; factors.push(`${signals.insider.recentFilings} Insider-Kaeufe`); }
    if(signals.insider.signal === "neutral") { score += 4; }
  }

  // StockTwits sentiment (15%)
  if(signals.stocktwits) {
    const st = signals.stocktwits;
    if(st.bullPct >= 65) { score += 8; factors.push(`StockTwits ${st.bullPct}% bullish`); }
    if(st.bullPct <= 35) { score -= 8; factors.push(`StockTwits ${st.bullPct}% bearish`); }
  }

  // Reddit (10%)
  if(signals.reddit) {
    const r = signals.reddit;
    if(r.mentions >= 5 && r.bullPct >= 60) { score += 5; factors.push(`Reddit: ${r.mentions} Erw. ${r.bullPct}% positiv`); }
    if(r.bullPct <= 35) { score -= 5; }
  }

  score = Math.min(95, Math.max(5, Math.round(score)));
  const direction = score >= 60 ? "steigend" : score <= 40 ? "fallend" : "seitwaerts";
  const confidence = score >= 75 ? "SEHR HOCH" : score >= 60 ? "HOCH" : score >= 45 ? "MITTEL" : "NIEDRIG";

  // Estimated move (rough)
  const aboveNeutral = score - 50;
  const targetPct = direction === "steigend" ? Math.round(aboveNeutral * 0.3 * 10) / 10
                   : direction === "fallend"  ? Math.round(aboveNeutral * 0.3 * 10) / 10 : 0;
  const stopPct = -Math.max(4, Math.abs(targetPct) * 0.5);

  return { score, direction, confidence, factors, targetPct, stopPct };
}

// ── AI Prognose ───────────────────────────────────────────────────────────────
async function getAIPrognose(symbol, type, signals, score, aiKey) {
  if(!aiKey) return null;
  try {
    const prompt = `Du bist ein erfahrener Kurzfrist-Trader. Analysiere folgende Daten fuer ${symbol} (${type}) fuer einen 3-7 Tage Zeithorizont:

Score: ${score.score}/100 | Richtung: ${score.direction} | Konfidenz: ${score.confidence}
Faktoren: ${score.factors.join(", ")}

Rohdaten:
${JSON.stringify(signals, null, 2).slice(0, 2000)}

Antworte NUR als JSON ohne Backticks:
{"kurzanalyse":"2-3 Saetze warum und wohin","wahrscheinlichkeitSteigend":65,"wahrscheinlichkeitSeitwaerts":20,"wahrscheinlichkeitFallend":15,"kurszielPct":8.5,"stopLossPct":-4.5,"hauptrisiko":"kurzer Satz","hauptchance":"kurzer Satz","empfehlung":"KAUFEN oder ABWARTEN oder MEIDEN","empfohleneBetrag":150}`;

    const r = await postJson("api.anthropic.com", "/v1/messages", {
      model: "claude-sonnet-4-6", max_tokens: 600,
      messages: [{ role:"user", content: prompt }]
    }, {
      "x-api-key": aiKey,
      "anthropic-version": "2023-06-01"
    });

    const txt = r.data?.content?.[0]?.text || "";
    const s = txt.indexOf("{"), e = txt.lastIndexOf("}");
    if(s !== -1 && e !== -1) return JSON.parse(txt.slice(s, e+1));
  } catch(e) {}
  return null;
}

// ── ntfy Push Alert ───────────────────────────────────────────────────────────
async function sendNtfy(topic, title, message, priority=3) {
  if(!topic) return;
  return new Promise(resolve => {
    const payload = JSON.stringify({ topic, title, message, priority });
    const opts = {
      hostname: "ntfy.sh", path:"/", method:"POST",
      headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(payload)}
    };
    const req = https.request(opts, () => resolve());
    req.on("error", () => resolve());
    req.write(payload); req.end();
  });
}

// ── Full Scanner ──────────────────────────────────────────────────────────────
async function runScanner(symbols, type, avKey, aiKey, ntfyTopic) {
  const results = [];
  const fearGreed = type === "crypto" ? await getFearGreed() : null;

  for(const sym of symbols) {
    try {
      const signals = { fearGreed };

      if(type === "crypto") {
        const [cryptoData, orderbook, ticker, stocktwits, reddit] = await Promise.all([
          getCryptoData(sym),
          getOrderbookPressure(sym),
          getBinanceTicker(sym),
          getStockTwitsSentiment(sym),
          getRedditMentions(sym)
        ]);
        Object.assign(signals, { cryptoData, orderbook, ticker, stocktwits, reddit });
      } else {
        const [yahooPrice, technical, insider, stocktwits, reddit] = await Promise.all([
          getStockPriceYahoo(sym),           // Yahoo Finance – unbegrenzt
          getTechnicalIndicators(sym, avKey), // Alpha Vantage RSI/MACD (falls verfügbar)
          getInsiderData(sym),
          getStockTwitsSentiment(sym),
          getRedditMentions(sym)
        ]);
        Object.assign(signals, { yahooPrice, technical, insider, stocktwits, reddit });
      }

      const score = calcScore(signals, type);
      const aiPrognose = aiKey ? await getAIPrognose(sym, type, signals, score, aiKey) : null;

      const result = { symbol:sym, type, score, signals, aiPrognose, timestamp: new Date().toISOString() };
      results.push(result);

      // Push alert if score >= 70
      if(ntfyTopic && score.score >= 70) {
        const dir = score.direction === "steigend" ? "▲" : score.direction === "fallend" ? "▼" : "→";
        await sendNtfy(ntfyTopic,
          `⚡ Scanner: ${sym} ${dir} ${score.score}/100`,
          `${score.confidence} | Ziel: ${score.targetPct>0?"+":""}${score.targetPct}% | ${score.factors.slice(0,2).join(", ")}`,
          score.score >= 80 ? 5 : 4
        );
      }
    } catch(e) {
      results.push({ symbol:sym, type, error: e.message });
    }
  }
  return results;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function getDateStr(offsetDays=0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0,10);
}

function findAllWallets(obj, results=[]) {
  if(!obj||typeof obj!=="object") return results;
  if(Array.isArray(obj)){obj.forEach(i=>findAllWallets(i,results));return results;}
  if(obj.type==="wallet"&&obj.attributes){results.push(obj);return results;}
  Object.values(obj).forEach(v=>findAllWallets(v,results));
  return results;
}

function parsePositions(d) {
  const positions=[];
  const attrs=d?.data?.attributes||{};
  Object.keys(attrs).forEach(groupKey=>{
    findAllWallets(attrs[groupKey]).forEach(w=>{
      const a=w.attributes||{};
      const balance=parseFloat(a.balance||a.quantity||a.shares||0);
      if(balance<=0.000001) return;
      const sym=(a.cryptocoin_symbol||a.symbol||a.asset_symbol||"").toUpperCase();
      if(!sym||sym==="EUR"||sym==="BEST") return;
      let type="crypto";
      if(groupKey.includes("stock")||groupKey.includes("equity")||groupKey==="security") type="stock";
      else if(groupKey.includes("etf")) type="etf";
      positions.push({symbol:sym,name:a.name||a.asset_name||sym,amount:balance,type,walletId:w.id||"",isin:a.isin||""});
    });
  });
  return positions;
}

function calcBuyData(trades) {
  const bySymbol={};
  trades.forEach(t=>{
    const a=t.attributes||{};
    if(!(a.type||"").toLowerCase().includes("buy")) return;
    const sym=(a.cryptocoin_symbol||"").toUpperCase();
    if(!sym||sym==="EUR") return;
    const amtFiat=parseFloat(a.amount_fiat||0);
    const amtUnits=parseFloat(a.amount_cryptocoin||0);
    const directPrice=parseFloat(a.price||0);
    const fee=parseFloat(a.fee?.attributes?.fee_amount_in_fiat||a.fee?.attributes?.fee_amount||a.trading_fee||0);
    if(amtFiat<=0||amtUnits<=0) return;
    if(!bySymbol[sym]) bySymbol[sym]={totalFiat:0,totalNetFiat:0,totalUnits:0,totalFee:0,directPrice:0};
    bySymbol[sym].totalFiat+=amtFiat;
    bySymbol[sym].totalNetFiat+=amtFiat-fee;
    bySymbol[sym].totalUnits+=amtUnits;
    bySymbol[sym].totalFee+=fee;
    if(directPrice>0) bySymbol[sym].directPrice=directPrice;
  });
  const result={};
  Object.keys(bySymbol).forEach(sym=>{
    const{totalFiat,totalNetFiat,totalUnits,totalFee,directPrice}=bySymbol[sym];
    const pricePerUnit=directPrice>0?directPrice:(totalNetFiat/totalUnits);
    result[sym]={totalInvested:parseFloat(totalFiat.toFixed(2)),pricePerUnit:parseFloat(pricePerUnit.toFixed(4)),totalFee:parseFloat(totalFee.toFixed(2))};
  });
  return result;
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  cors(res);
  if(req.method==="OPTIONS"){res.writeHead(204);res.end();return;}

  const parsed = url.parse(req.url, true);
  const path   = parsed.pathname;
  const q      = parsed.query;
  const apiKey = req.headers["x-api-key"] || BITPANDA_KEY;
  const aiKey  = req.headers["x-anthropic-key"] || ANTHROPIC_KEY;

  if(path==="/"||path==="/health"){
    res.writeHead(200,{"Content-Type":"application/json"});
    res.end(JSON.stringify({status:"ok",message:"Bitpanda Proxy v7 + Yahoo Finance ✅",time:new Date().toISOString()}));
    return;
  }

  try {
    // ── Portfolio endpoints ──
    if(path==="/portfolio"||path==="/wallets"){
      if(!apiKey){res.writeHead(401);res.end(JSON.stringify({error:"Kein API-Key."}));return;}
      const[awRes,tradeRes]=await Promise.all([bpFetch("/v1/asset-wallets",apiKey),bpFetch("/v1/trades?page_size=100",apiKey)]);
      const positions=parsePositions(awRes.data);
      const trades=tradeRes.data?.data||[];
      const buyData=calcBuyData(trades);
      positions.forEach(p=>{
        const bd=buyData[p.symbol];
        if(bd){p.pricePerUnit=bd.pricePerUnit;p.totalInvested=bd.totalInvested;p.totalFee=bd.totalFee;p.buyPrice=bd.pricePerUnit;}
        else{p.pricePerUnit=0;p.totalInvested=0;p.totalFee=0;p.buyPrice=0;}
      });
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify({positions,debug:{assetGroups:Object.keys(awRes.data?.data?.attributes||{}),positionCount:positions.length,tradeCount:trades.length},updated:new Date().toISOString()}));
      return;
    }

    // ── Scanner endpoint ──
    if(path==="/scanner"){
      const symbols = (q.symbols||"BTC,ETH,SOL").split(",").map(s=>s.trim().toUpperCase()).slice(0,8);
      const type    = q.type||"crypto"; // "crypto" or "stock"
      const ntfyTopic = q.ntfy||"";
      const avKey   = q.avkey||"";
      const results = await runScanner(symbols, type, avKey, aiKey, ntfyTopic);
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify({results,scannedAt:new Date().toISOString()}));
      return;
    }

    // ── Single prognose ──
    if(path.startsWith("/prognose/")){
      const sym  = path.split("/")[2].toUpperCase();
      const type = q.type||"crypto";
      const avKey= q.avkey||"";
      const ntfyTopic = q.ntfy||"";
      const results = await runScanner([sym], type, avKey, aiKey, ntfyTopic);
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify(results[0]||{error:"Keine Daten"}));
      return;
    }

    // ── Fear & Greed ──
    if(path==="/feargreed"){
      const fg = await getFearGreed();
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify(fg));
      return;
    }

    // ── Debug ──
    if(path==="/debug"){
      if(!apiKey){res.writeHead(401);res.end(JSON.stringify({error:"Kein API-Key."}));return;}
      const r=await bpFetch("/v1/asset-wallets",apiKey);
      const positions=parsePositions(r.data);
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify({status:r.status,assetGroups:Object.keys(r.data?.data?.attributes||{}),positionsFound:positions}));
      return;
    }

    if(path==="/trades-debug"){
      if(!apiKey){res.writeHead(401);res.end(JSON.stringify({error:"Kein API-Key."}));return;}
      const r=await bpFetch("/v1/trades?page_size=5",apiKey);
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify({count:r.data?.data?.length||0,trades:(r.data?.data||[]).map(t=>t.attributes)}));
      return;
    }

    // ── Yahoo Finance Stock Prices ──
    if(path==="/stocks"){
      const symbols = (q.symbols||"").split(",").map(s=>s.trim().toUpperCase()).filter(Boolean);
      if(!symbols.length){res.writeHead(400);res.end(JSON.stringify({error:"Keine Symbole angegeben. ?symbols=MU,AAPL"}));return;}
      const data = await getStockPricesYahoo(symbols);
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify({prices:data,updatedAt:new Date().toISOString()}));
      return;
    }

    res.writeHead(404,{"Content-Type":"application/json"});
    res.end(JSON.stringify({error:"Verfuegbar: /health /portfolio /scanner /prognose/:symbol /feargreed /stocks /debug /trades-debug"}));

  } catch(e) {
    res.writeHead(500,{"Content-Type":"application/json"});
    res.end(JSON.stringify({error:e.message}));
  }
});

server.listen(PORT, () => console.log(`Bitpanda Proxy v6 + Scanner laeuft auf Port ${PORT}`));
