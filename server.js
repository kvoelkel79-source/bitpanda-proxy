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
    const currency = meta.currency || "USD";
    let priceEUR;
    if(currency === "EUR") {
      // Already in EUR (e.g. SAP.DE, XETRA stocks)
      priceEUR = priceUSD;
    } else {
      // Convert USD → EUR
      const fxR = await fetchJson("query1.finance.yahoo.com",
        `/v8/finance/chart/EURUSD=X?interval=1d&range=1d`,
        {"User-Agent": "Mozilla/5.0"}
      );
      const eurUsd = fxR.data?.chart?.result?.[0]?.meta?.regularMarketPrice || 1.08;
      priceEUR = priceUSD / eurUsd;
    }
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

// 8. Moving Averages + Bollinger Bands + Volume (Yahoo Finance)
async function getMovingAverages(symbol) {
  try {
    const yahooSym = symbol.replace(/-([A-Z]{2})$/, ".$1");
    const r = await fetchJson("query1.finance.yahoo.com",
      `/v8/finance/chart/${yahooSym}?interval=1d&range=1y`,
      {"User-Agent": "Mozilla/5.0"}
    );
    const quotes = r.data?.chart?.result?.[0];
    if(!quotes) return null;
    const closes = quotes.indicators?.quote?.[0]?.close?.filter(c => c != null) || [];
    const volumes = quotes.indicators?.quote?.[0]?.volume?.filter(v => v != null) || [];
    if(closes.length < 20) return null;

    // Moving Averages
    const ma50  = closes.length>=50  ? closes.slice(-50).reduce((a,b)=>a+b,0)/50   : null;
    const ma200 = closes.length>=200 ? closes.slice(-200).reduce((a,b)=>a+b,0)/200 : null;
    const currentPrice = closes[closes.length-1];

    // Bollinger Bands (20-day)
    const bb20 = closes.slice(-20);
    const bbMid = bb20.reduce((a,b)=>a+b,0)/20;
    const bbStd = Math.sqrt(bb20.reduce((s,c)=>s+Math.pow(c-bbMid,2),0)/20);
    const bbUpper = bbMid + 2*bbStd;
    const bbLower = bbMid - 2*bbStd;

    // Volume analysis (avg 20 days)
    const avgVol20 = volumes.length>=20 ? volumes.slice(-20).reduce((a,b)=>a+b,0)/20 : null;
    const lastVol = volumes[volumes.length-1];
    const volRatio = avgVol20 && lastVol ? lastVol/avgVol20 : 1;

    // Signals
    const aboveMa50  = ma50  ? currentPrice > ma50  : null;
    const aboveMa200 = ma200 ? currentPrice > ma200 : null;
    const goldenCross = ma50 && ma200 ? ma50 > ma200 : null; // bullish
    const deathCross  = ma50 && ma200 ? ma50 < ma200 : null; // bearish
    const bbPosition = currentPrice < bbLower ? "oversold" : currentPrice > bbUpper ? "overbought" : "normal";

    return {
      ma50, ma200, currentPrice,
      aboveMa50, aboveMa200, goldenCross, deathCross,
      bbUpper, bbLower, bbMid, bbPosition,
      volRatio, highVolume: volRatio > 1.5
    };
  } catch(e) { return null; }
}

// 9. Binance Funding Rate (Krypto only)
async function getFundingRate(symbol) {
  try {
    const pair = symbol.toUpperCase()+"USDT";
    const r = await fetchJson("fapi.binance.com",
      `/fapi/v1/premiumIndex?symbol=${pair}`);
    if(!r.data?.lastFundingRate) return null;
    const rate = parseFloat(r.data.lastFundingRate) * 100; // in %
    return {
      rate,
      signal: rate > 0.05 ? "bearish" : rate < -0.01 ? "bullish" : "neutral",
      // High positive = too many longs = correction likely
      // Negative = too many shorts = squeeze possible
      interpretation: rate > 0.1 ? "Zu viele Longs – Korrektur wahrscheinlich" :
                      rate > 0.05 ? "Leicht überhitzt" :
                      rate < -0.05 ? "Short-Squeeze möglich" :
                      rate < 0 ? "Leicht bärisch positioniert" : "Neutral"
    };
  } catch(e) { return null; }
}

// 10. Google Trends (via unofficial API)
async function getGoogleTrends(symbol) {
  try {
    const query = encodeURIComponent(symbol+" stock");
    const r = await fetchJson("trends.google.com",
      `/trends/api/dailytrends?hl=en-US&tz=-60&geo=DE&ns=15`,
      {"User-Agent": "Mozilla/5.0"});
    // Simple fallback - trends API is complex, use basic interest score
    return { interest: 50, trend: "neutral" }; // placeholder
  } catch(e) { return null; }
}

// 11. Yahoo Finance Screener – Top Movers for Chancen-Scanner
async function getYahooScreener(type="crypto") {
  try {
    const screenerUrl = type === "crypto"
      ? `/v1/finance/screener/predefined/saved?formatted=false&lang=en-US&region=US&scrIds=crypto_top_movers&count=20`
      : `/v1/finance/screener/predefined/saved?formatted=false&lang=en-US&region=US&scrIds=day_gainers&count=20`;
    const r = await fetchJson("query1.finance.yahoo.com", screenerUrl,
      {"User-Agent": "Mozilla/5.0"});
    const quotes = r.data?.finance?.result?.[0]?.quotes || [];
    return quotes.map(q => ({
      symbol: q.symbol,
      name: q.shortName || q.longName || q.symbol,
      price: q.regularMarketPrice,
      change: q.regularMarketChangePercent,
      volume: q.regularMarketVolume,
      marketCap: q.marketCap
    })).filter(q => q.change > 2); // only >2% movers
  } catch(e) { return []; }
}

// ── Score Calculator – getrennte Gewichtung für Krypto und Aktien ─────────────
// KRYPTO: RSI/MACD 22% | Kurs 18% | MA 13% | StockTwits 13% | F&G 10% | Volume 8% | FundingRate 10% | GoogleTrends 6%
// AKTIEN: RSI/MACD 27% | Kurs 22% | MA 18% | StockTwits 15% | F&G 8% | Volume 10%
function calcScore(signals, type) {
  const bullish = [];
  const bearish = [];
  let weightedScore = 0;
  let totalWeight = 0;

  const isCrypto = type === "crypto";

  // Gewichtungen je Asset-Klasse
  const W = isCrypto ? {
    tech: 0.22, price: 0.18, ma: 0.13, sentiment: 0.13,
    feargreed: 0.10, volume: 0.08, funding: 0.10, trends: 0.06
  } : {
    tech: 0.27, price: 0.22, ma: 0.18, sentiment: 0.15,
    feargreed: 0.08, volume: 0.10, funding: 0, trends: 0
  };

  function addScore(weight, points, label) {
    if(weight === 0) return;
    const clamped = Math.max(-1, Math.min(1, points));
    weightedScore += clamped * weight;
    totalWeight += weight;
    if(clamped > 0.2 && label) bullish.push(label);
    else if(clamped < -0.2 && label) bearish.push(label);
  }

  // ── RSI/MACD ─────────────────────────────────────────────────────
  if(signals.technical?.rsi != null) {
    const t = signals.technical;
    let p = 0;
    if(t.rsiSignal === "oversold_bullish")  { p += 0.7; }
    if(t.rsiSignal === "overbought_bearish"){ p -= 0.7; }
    if(t.macdCrossover === "bullish")       { p += 0.5; }
    if(t.macdCrossover === "bearish")       { p -= 0.5; }
    const rsiLabel = t.rsiSignal === "oversold_bullish"
      ? `RSI ${t.rsi?.toFixed(0)} – überverkauft (Kaufsignal)`
      : t.rsiSignal === "overbought_bearish"
      ? `RSI ${t.rsi?.toFixed(0)} – überkauft (Verkaufssignal)` : null;
    const macdLabel = t.macdCrossover === "bullish" ? "MACD Kaufsignal" :
                      t.macdCrossover === "bearish" ? "MACD Verkaufssignal" : null;
    addScore(W.tech, p, rsiLabel || macdLabel);
  }

  // ── Kursveränderung heute ─────────────────────────────────────────
  const priceChange = signals.yahooPrice?.change24h || signals.ticker?.changePercent || signals.cryptoData?.change24h || null;
  if(priceChange != null) {
    const p = priceChange >= 5 ? 1.0 : priceChange >= 2 ? 0.5 : priceChange <= -5 ? -1.0 : priceChange <= -2 ? -0.5 : 0;
    const label = priceChange >= 2 ? `+${priceChange.toFixed(1)}% heute – positiver Trend` :
                  priceChange <= -2 ? `${priceChange.toFixed(1)}% heute – negativer Trend` : null;
    addScore(W.price, p, label);
  }

  // ── Moving Averages + Bollinger Bands ────────────────────────────
  if(signals.movingAverages) {
    const ma = signals.movingAverages;
    let p = 0;
    let label = null;
    if(ma.goldenCross)    { p += 0.6; label = "Golden Cross – MA50 über MA200 (Bullish)"; }
    if(ma.deathCross)     { p -= 0.6; label = "Death Cross – MA50 unter MA200 (Bearish)"; }
    if(ma.aboveMa200)     { p += 0.3; }
    if(ma.aboveMa200 === false) { p -= 0.3; }
    if(ma.bbPosition === "oversold")   { p += 0.4; label = label || "Unter Bollinger Band – überverkauft"; }
    if(ma.bbPosition === "overbought") { p -= 0.4; label = label || "Über Bollinger Band – überkauft"; }
    addScore(W.ma, p, label);
  }

  // ── StockTwits Sentiment ─────────────────────────────────────────
  if(signals.stocktwits) {
    const st = signals.stocktwits;
    const p = st.bullPct >= 70 ? 1.0 : st.bullPct >= 55 ? 0.4 : st.bullPct <= 30 ? -1.0 : st.bullPct <= 45 ? -0.4 : 0;
    const label = st.bullPct >= 55 ? `StockTwits ${st.bullPct}% bullish – positive Trader-Stimmung` :
                  st.bullPct <= 45 ? `StockTwits ${st.bullPct}% bullish – negative Trader-Stimmung` : null;
    addScore(W.sentiment, p, label);
  }

  // ── Fear & Greed ─────────────────────────────────────────────────
  if(signals.fearGreed) {
    const fg = signals.fearGreed;
    const p = fg.value >= 75 ? 1.0 : fg.value >= 55 ? 0.4 : fg.value <= 25 ? -1.0 : fg.value <= 45 ? -0.4 : 0;
    const label = fg.value >= 55 ? `Fear&Greed ${fg.value} (${fg.classification}) – positive Stimmung` :
                  fg.value <= 45 ? `Fear&Greed ${fg.value} (${fg.classification}) – Vorsicht` : null;
    addScore(W.feargreed, p, label);
  }

  // ── Volume ───────────────────────────────────────────────────────
  if(signals.movingAverages?.volRatio != null) {
    const vr = signals.movingAverages.volRatio;
    const priceDir = priceChange != null ? Math.sign(priceChange) : 0;
    const p = vr > 2.0 ? 0.8*priceDir : vr > 1.5 ? 0.5*priceDir : vr < 0.5 ? -0.3 : 0;
    const label = vr > 1.5 && priceDir > 0 ? `Volumen ${vr.toFixed(1)}x über Durchschnitt – starke Kaufbestätigung` :
                  vr > 1.5 && priceDir < 0 ? `Volumen ${vr.toFixed(1)}x über Durchschnitt – starker Verkaufsdruck` : null;
    addScore(W.volume, p, label);
  }

  // ── Funding Rate (nur Krypto) ────────────────────────────────────
  if(isCrypto && signals.fundingRate) {
    const fr = signals.fundingRate;
    const p = fr.signal === "bullish" ? 0.7 : fr.signal === "bearish" ? -0.7 : 0;
    const label = fr.signal !== "neutral" ? `Funding Rate ${fr.rate.toFixed(3)}% – ${fr.interpretation}` : null;
    addScore(W.funding, p, label);
  }

  // ── Google Trends (Bonus) ────────────────────────────────────────
  if(signals.trends?.interest != null && W.trends > 0) {
    const p = signals.trends.interest > 70 ? 0.5 : signals.trends.interest < 30 ? -0.3 : 0;
    addScore(W.trends, p, null);
  }

  // Normalisierung
  const normalized = totalWeight > 0 ? weightedScore / totalWeight : 0;
  const rawScore = 50 + (normalized * 50);
  const score = Math.min(95, Math.max(5, Math.round(rawScore)));

  const bullPct = score;
  const bearPct = 100 - score;
  const direction = score >= 60 ? "steigend" : score <= 40 ? "fallend" : "seitwaerts";
  const confidence = score >= 75 || score <= 25 ? "SEHR HOCH" : score >= 65 || score <= 35 ? "HOCH" : score >= 55 || score <= 45 ? "MITTEL" : "NIEDRIG";
  const alertLevel = score <= 30 ? "WARNUNG" : score <= 40 ? "INFO" : score >= 70 ? "BULLISH" : score >= 60 ? "CHANCE" : "NEUTRAL";

  const aboveNeutral = score - 50;
  const targetPct = direction === "steigend" ? Math.round(aboveNeutral * 0.3 * 10) / 10
                  : direction === "fallend"  ? Math.round(aboveNeutral * 0.3 * 10) / 10 : 0;
  const stopPct = -Math.max(4, Math.abs(targetPct) * 0.5);

  return { score, bullPct, bearPct, direction, confidence, alertLevel, bullish, bearish, targetPct, stopPct };
}

// ── AI Prognose ───────────────────────────────────────────────────────────────
async function getAIPrognose(symbol, type, signals, score, aiKey) {
  if(!aiKey) return null;
  try {
    const prompt = `Du bist ein erfahrener Kurzfrist-Trader. Analysiere folgende Daten fuer ${symbol} (${type}) fuer einen 3-7 Tage Zeithorizont:

Score: ${score.score}/100 | Richtung: ${score.direction} | Konfidenz: ${score.confidence}
Bullish: ${(score.bullish||[]).slice(0,2).join(", ")} | Bärisch: ${(score.bearish||[]).slice(0,2).join(", ")}

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
        const [cryptoData, orderbook, ticker, stocktwits, reddit, movingAverages, fundingRate] = await Promise.all([
          getCryptoData(sym),
          getOrderbookPressure(sym),
          getBinanceTicker(sym),
          getStockTwitsSentiment(sym),
          getRedditMentions(sym),
          getMovingAverages(sym),
          getFundingRate(sym)
        ]);
        Object.assign(signals, { cryptoData, orderbook, ticker, stocktwits, reddit, movingAverages, fundingRate });
      } else {
        const [yahooPrice, technical, insider, stocktwits, reddit, movingAverages] = await Promise.all([
          getStockPriceYahoo(sym),           // Yahoo Finance – unbegrenzt
          getTechnicalIndicators(sym, avKey), // Alpha Vantage RSI/MACD (falls verfügbar)
          getInsiderData(sym),
          getStockTwitsSentiment(sym),
          getRedditMentions(sym),
          getMovingAverages(sym)
        ]);
        Object.assign(signals, { yahooPrice, technical, insider, stocktwits, reddit, movingAverages });
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
          `${score.confidence} | Ziel: ${score.targetPct>0?"+":""}${score.targetPct}% | ${(score.bullish||[]).slice(0,2).join(", ")}`,
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

    // ── Signals Cache (Background Monitor Ergebnisse) ──
    if(path==="/signals"){
      res.writeHead(200,{"Content-Type":"application/json"});
      res.end(JSON.stringify({signals:lastSignals,updatedAt:new Date().toISOString()}));
      return;
    }

    // ── Chancen-Scanner – automatische Top-Mover Suche ──
    if(path==="/chancen"){
      try {
        const scanType = q.type||"all"; // all, crypto, stock
        const aiKey = req.headers["x-anthropic-key"] || ANTHROPIC_KEY;
        const ntfyTopic = process.env.NTFY_TOPIC||"";
        let symbols = [];

        // Bekannte Top-Symbole für automatischen Scan
        const cryptoSymbols = ["BTC","ETH","SOL","BNB","XRP","ADA","AVAX","LINK","DOT","MATIC","NEAR","FTM","SAND","MANA","UNI","ATOM","ALGO","LTC","DOGE","SHIB"];
        const stockSymbols  = ["AAPL","MSFT","NVDA","TSLA","META","AMZN","GOOGL","AMD","INTC","MU","ASML","SAP-DE","BABA","TSM","NFLX","PYPL","SQ","COIN","SHOP","SNAP"];

        if(scanType==="crypto") symbols = cryptoSymbols.map(s=>({symbol:s,type:"crypto"}));
        else if(scanType==="stock") symbols = stockSymbols.map(s=>({symbol:s,type:"stock"}));
        else symbols = [...cryptoSymbols.map(s=>({symbol:s,type:"crypto"})), ...stockSymbols.map(s=>({symbol:s,type:"stock"}))];

        // Yahoo Screener für aktuelle Top-Mover
        const [cryptoMovers, stockMovers] = await Promise.all([
          scanType!=="stock" ? getYahooScreener("crypto") : Promise.resolve([]),
          scanType!=="crypto" ? getYahooScreener("stock") : Promise.resolve([])
        ]);

        // Merge screener results with known symbols (avoid duplicates)
        const knownSyms = new Set(symbols.map(s=>s.symbol));
        cryptoMovers.forEach(m => { if(!knownSyms.has(m.symbol)) { symbols.push({symbol:m.symbol,type:"crypto"}); knownSyms.add(m.symbol); }});
        stockMovers.forEach(m  => { if(!knownSyms.has(m.symbol)) { symbols.push({symbol:m.symbol,type:"stock"});  knownSyms.add(m.symbol); }});

        // Run scanner on all symbols (limit to 15 to avoid timeout)
        const toScan = symbols.slice(0, 15);
        const results = await runScanner(toScan.map(s=>s.symbol), toScan[0]?.type||"crypto", "", aiKey, ntfyTopic);

        // Sort by score descending, filter score >= 60 (bullish/chance only)
        const chancen = results
          .filter(r => r.score?.score >= 58)
          .sort((a,b) => b.score.score - a.score.score)
          .slice(0, 10);

        res.writeHead(200,{"Content-Type":"application/json"});
        res.end(JSON.stringify({chancen, updatedAt:new Date().toISOString()}));
      } catch(e) {
        res.writeHead(500,{"Content-Type":"application/json"});
        res.end(JSON.stringify({error:e.message}));
      }
      return;
    }

    res.writeHead(404,{"Content-Type":"application/json"});
    res.end(JSON.stringify({error:"Verfuegbar: /health /portfolio /scanner /prognose/:symbol /feargreed /stocks /signals /debug /trades-debug"}));

  } catch(e) {
    res.writeHead(500,{"Content-Type":"application/json"});
    res.end(JSON.stringify({error:e.message}));
  }
});

server.listen(PORT, () => console.log(`Bitpanda Proxy v6 + Scanner laeuft auf Port ${PORT}`));

// ── Background Monitor (alle 30 Min) ─────────────────────────────────────────
// Prüft alle Positionen aus dem Bitpanda-Portfolio und sendet Push-Alerts
let lastSignals = {}; // Cache: letzter Alert-Status pro Symbol

async function runBackgroundMonitor() {
  try {
    if(!BITPANDA_KEY) return;
    console.log("[Monitor] Starte Hintergrund-Analyse...");

    // Portfolio direkt über den internen Endpoint laden (identisch zu /portfolio)
    const walletRes = await bpFetch("/v1/asset-wallets", BITPANDA_KEY);
    const attrs = walletRes.data?.data?.attributes || {};
    const positions = [];
    Object.keys(attrs).forEach(groupKey => {
      findAllWallets(attrs[groupKey]).forEach(w => {
        const a = w.attributes || {};
        const balance = parseFloat(a.balance || a.quantity || a.shares || 0);
        if(balance <= 0.000001) return;
        const sym = (a.cryptocoin_symbol || a.symbol || a.asset_symbol || "").toUpperCase();
        if(!sym || sym === "EUR" || sym === "BEST") return;
        let type = "crypto";
        if(groupKey.includes("stock") || groupKey.includes("equity") || groupKey === "security") type = "stock";
        else if(groupKey.includes("etf")) type = "etf";
        positions.push({ symbol: sym, type });
      });
    });
    console.log(`[Monitor] ${positions.length} Positionen gefunden:`, positions.map(p=>p.symbol).join(", "));
    if(!positions.length) {
      console.log("[Monitor] Keine Positionen gefunden - überspringe");
      return;
    }

    // ntfy Topic aus Env
    const ntfyTopic = process.env.NTFY_TOPIC || "";

    // Fear & Greed einmal laden
    const fearGreed = await getFearGreed();

    for(const pos of positions) {
      try {
        const sym = pos.symbol;
        const type = pos.type === "crypto" ? "crypto" : "stock";
        const signals = { fearGreed };

        if(type === "crypto") {
          const [cryptoData, orderbook, ticker, stocktwits, reddit, movingAverages, fundingRate] = await Promise.all([
            getCryptoData(sym), getOrderbookPressure(sym), getBinanceTicker(sym),
            getStockTwitsSentiment(sym), getRedditMentions(sym),
            getMovingAverages(sym), getFundingRate(sym)
          ]);
          Object.assign(signals, { cryptoData, orderbook, ticker, stocktwits, reddit, movingAverages, fundingRate });
        } else {
          const yahooSym = sym.replace(/-([A-Z]{2})$/, ".$1");
          const [yahooPrice, technical, insider, stocktwits, reddit, movingAverages] = await Promise.all([
            getStockPriceYahoo(sym), getTechnicalIndicators(yahooSym, ""),
            getInsiderData(sym), getStockTwitsSentiment(sym), getRedditMentions(sym),
            getMovingAverages(yahooSym)
          ]);
          Object.assign(signals, { yahooPrice, technical, insider, stocktwits, reddit, movingAverages });
        }

        const score = calcScore(signals, type);
        const prev = lastSignals[sym];

        // KI-Prognose nur bei Änderung des Alert-Levels
        let aiPrognose = null;
        const levelChanged = !prev || prev.alertLevel !== score.alertLevel;
        if(levelChanged && (score.alertLevel === "WARNUNG" || score.alertLevel === "BULLISH")) {
          aiPrognose = await getAIPrognose(sym, type, signals, score, ANTHROPIC_KEY);
        }

        // Push senden bei Statusänderung
        if(ntfyTopic && levelChanged) {
          const icon = score.alertLevel === "WARNUNG" ? "🔴" : score.alertLevel === "INFO" ? "🟡" : score.alertLevel === "BULLISH" ? "🟢" : score.alertLevel === "CHANCE" ? "🔵" : "⚪";
          const title = `${icon} ${sym} – ${score.alertLevel}`;
          const bearReasons = score.bearish.slice(0,2).join(" | ");
          const bullReasons = score.bullish.slice(0,2).join(" | ");
          const reasons = score.alertLevel === "WARNUNG" || score.alertLevel === "INFO" ? bearReasons : bullReasons;
          const aiText = aiPrognose?.kurzanalyse ? `
🤖 ${aiPrognose.kurzanalyse.slice(0,100)}` : "";
          const priority = score.alertLevel === "WARNUNG" ? 5 : score.alertLevel === "BULLISH" ? 4 : 3;
          await sendNtfy(ntfyTopic, title, `${reasons}${aiText}`, priority);
          console.log(`[Monitor] Push gesendet: ${sym} → ${score.alertLevel}`);
        }

        // Entwarnung senden
        if(ntfyTopic && prev && (prev.alertLevel === "WARNUNG" || prev.alertLevel === "INFO") && score.alertLevel === "NEUTRAL") {
          await sendNtfy(ntfyTopic, `✅ ${sym} – Entwarnung`, `Bären-Signal aufgelöst. Score: ${score.score}/100`, 3);
        }

        // Cache aktualisieren
        lastSignals[sym] = {
          alertLevel: score.alertLevel,
          score: score.score,
          bullPct: score.bullPct,
          bearPct: score.bearPct,
          bullish: score.bullish,
          bearish: score.bearish,
          direction: score.direction,
          confidence: score.confidence,
          aiPrognose,
          updatedAt: new Date().toISOString()
        };

      } catch(e) { console.error(`[Monitor] Fehler bei ${pos.symbol}:`, e.message); }
    }
    console.log(`[Monitor] Analyse abgeschlossen. ${positions.length} Positionen geprüft.`);
  } catch(e) { console.error("[Monitor] Fehler:", e.message); }
}

// ── /signals Endpoint – App holt aktuelle Signale ────────────────────────────
// Wird beim Öffnen der App aufgerufen um gecachte Signale zu laden

// Erster Start nach 60 Sekunden (Server-Warmup), dann alle 30 Minuten
setTimeout(() => {
  runBackgroundMonitor();
  setInterval(runBackgroundMonitor, 30 * 60 * 1000);
}, 60 * 1000);

console.log("[Monitor] Hintergrund-Überwachung gestartet (alle 30 Min)");
