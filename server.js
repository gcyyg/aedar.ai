const express = require("express");
const axios = require("axios");
const cron = require("node-cron");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 8080;
const DATA_DIR = path.join(__dirname, "src/data");
const TUSHARE_TOKEN = process.env.TUSHARE_TOKEN || "51fbaa947c34a4caa000e1323fa20153f93a34b1fea1f6b98196e59e";
const TUSHARE_BASE = "http://api.tushare.pro";


// Tushare API wrapper
async function tushareApi(apiName, params, fields) {
    try {
        const payload = JSON.stringify({ api_name: apiName, token: TUSHARE_TOKEN, params: params || {}, fields: fields || "" });
        const r = await axios.post(TUSHARE_BASE, payload, { headers: { "Content-Type": "application/json" }, timeout: 10000 });
        if (r.data.code !== 0) throw new Error(r.data.msg);
        return r.data.data;
    } catch (e) { console.error("Tushare(" + apiName + ") error:", e.message); return null; }
}

// 沪深300 K线
async function fetchCSI300(klineCount = 300) {
    try {
        const url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?_var=kline_dayqfq&param=sh000300,day,,," + klineCount + ",qfq";
        const r = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 8000 });
        const match = r.data.match(/\{.*\}/);
        if (!match) return null;
        const d = JSON.parse(match[0]);
        return d.data.sh000300.day.map(k => ({
            date: k[0], open: parseFloat(k[1]), close: parseFloat(k[2]),
            high: parseFloat(k[3]), low: parseFloat(k[4]), vol: parseFloat(k[5])
        }));
    } catch (e) { console.error("CSI300 error:", e.message); return null; }
}

// Shibor利率
async function fetchShibor() {
    try {
        const data = await tushareApi("shibor", {}, "shibor1w,shibor2w,shibor1m,shibor3m,shibor6m,shibor9m,shibor1y");
        if (!data || !data.items || data.items.length === 0) return { shibor3m: 1.652, shibor1y: 1.7 };
        const fields = data.fields; const row = data.items[data.items.length - 1];
        const o = {}; fields.forEach((f, i) => o[f] = row[i]);
        return {
            shibor3m: parseFloat(o.shibor3m || 1.652), shibor1y: parseFloat(o.shibor1y || 1.7),
            shibor1w: parseFloat(o.shibor1w || 0), shibor2w: parseFloat(o.shibor2w || 0),
            shibor1m: parseFloat(o.shibor1m || 0), shibor6m: parseFloat(o.shibor6m || 0)
        };
    } catch (e) { return { shibor3m: 1.652, shibor1y: 1.7, shibor1w: 0, shibor2w: 0, shibor1m: 0, shibor6m: 0 }; }
}

// 人民币汇率
async function fetchFX() {
    try {
        const r = await axios.get("https://api.frankfurter.app/latest?from=USD&to=CNY", { timeout: 5000 });
        return { usdCny: r.data.rates.CNY };
    } catch (e) { return { usdCny: 7.26 }; }
}

// 融资余额
async function fetchMargin() {
    try {
        const today = new Date();
        const start = new Date(today); start.setFullYear(start.getFullYear() - 1);
        const s = start.toISOString().slice(0, 10).replace(/-/g, "");
        const e = today.toISOString().slice(0, 10).replace(/-/g, "");
        const data = await tushareApi("margin", { start_date: s, end_date: e }, "exchange_id,trade_date,buy_balance,sell_balance,net_balance");
        if (!data || !data.items || data.items.length === 0) return null;
        const fields = data.fields; const latest = data.items[data.items.length - 1];
        const o = {}; fields.forEach((f, i) => o[f] = latest[i]);
        return { netBalance: parseFloat(o.net_balance || 0) / 1e8, updatedAt: o.trade_date };
    } catch (e) { return null; }
}

// 沪深300 PE/PB估值
async function fetchIndexValuation() {
    try {
        const todayStr = new Date().toISOString().slice(0, 10).replace(/-/g, "");
        const data = await tushareApi("index_peb", { trade_date: todayStr }, "ts_code,trade_date,pe,pb,pbf");
        if (!data || !data.items || data.items.length === 0) return { pe: 12.5, pb: 1.45, tsCode: "sh000300" };
        const fields = data.fields; const row = data.items[0];
        const o = {}; fields.forEach((f, i) => o[f] = row[i]);
        return { pe: parseFloat(o.pe || 12.5), pb: parseFloat(o.pb || 1.45), pbf: parseFloat(o.pbf || 0), tsCode: o.ts_code || "sh000300" };
    } catch (e) { return { pe: 12.5, pb: 1.45, tsCode: "sh000300" }; }
}

function calcMarketTemp(raw) {
    const closes = raw.csi300.map(k => k.close);
    const last = closes[closes.length - 1];
    const ma200 = closes.slice(-200).reduce((a, b) => a + b, 0) / Math.min(200, closes.length);
    const rets = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
    const avgRet20 = rets.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const std20 = Math.sqrt(rets.slice(-20).map(r => Math.pow(r - avgRet20, 2)).reduce((a, b) => a + b, 0) / 20);
    const realizedVol = std20 * Math.sqrt(252);
    const spread = (raw.shibor.shibor3m - raw.shibor.shibor1y) * 100;
    const uc = raw.fx.usdCny;
    const score1 = last > ma200 ? Math.min(Math.round((last / ma200 - 1) * 500 + 50), 100) : Math.max(Math.round(50 - (1 - last / ma200) * 500), 0);
    const score2 = realizedVol <= 0.15 ? Math.min(Math.round(50 + (0.15 - realizedVol) * 400), 100) : Math.max(Math.round(50 - (realizedVol - 0.15) * 300), 0);
    const score3 = raw.margin ? (raw.margin.netBalance > 1.3e12 ? 70 : raw.margin.netBalance > 1.1e12 ? 55 : 40) : 65;
    const score4 = spread < -0.1 ? 35 : spread < 0 ? 50 : 65;
    const score5 = uc < 7.0 ? 80 : uc < 7.3 ? 65 : uc < 7.8 ? 50 : 35;
    const score6 = 60;
    const scores = [score1, score2, score3, score4, score5, score6];
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const label = avg >= 80 ? "Hot" : avg >= 65 ? "Warm" : avg >= 50 ? "Cool" : "Cold";
    return {
        score: Math.round(avg), label,
        csi300: { close: last, ma200: ma200.toFixed(2), realizedVol: (realizedVol * 100).toFixed(2) },
        fx: { usdCny: uc.toFixed(4) },
        shibor: { shibor3m: raw.shibor.shibor3m, shibor1y: raw.shibor.shibor1y, spread: spread.toFixed(3) },
        margin: raw.margin,
        indicators: [
            { name: "沪深300 MA200", value: Math.round(last), score: score1, flag: last > ma200 ? "Above" : "Below" },
            { name: "恐慌波动率", value: (realizedVol * 100).toFixed(1) + "%", score: score2, flag: realizedVol <= 0.15 ? "Low" : "Normal" },
            { name: "融资余额增速", value: raw.margin ? (raw.margin.netBalance).toFixed(0) + "亿" : "N/A", score: score3, flag: raw.margin ? "Real" : "Simulated" },
            { name: "信用利差", value: spread.toFixed(3) + "%", score: score4, flag: spread < 0 ? "Inverted" : "Normal" },
            { name: "人民币汇率", value: uc.toFixed(2), score: score5, flag: uc < 7.3 ? "Strong" : "Weak" },
            { name: "认沽认购比", value: "N/A", score: score6, flag: "Simulated" }
        ],
        updatedAt: new Date().toISOString()
    };
}

// ==================== 缓存更新 ====================
let marketCache = null;
let marketCacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5分钟

async function updateMarketCache() {
    console.log("[Cache] Updating market data...");
    try {
        const [csi300, shibor, fx, margin] = await Promise.all([
            fetchCSI300(), fetchShibor(), fetchFX(), fetchMargin()
        ]);
        if (!csi300) { console.error("[Cache] CSI300 data missing"); return; }
        marketCache = calcMarketTemp({ csi300, shibor, fx, margin });
        marketCacheTime = Date.now();
        fs.writeFileSync(path.join(DATA_DIR, "market_temp.json"), JSON.stringify(marketCache, null, 2));
        console.log("[Cache] Updated. Score:", marketCache.score, "| Label:", marketCache.label);
    } catch (e) { console.error("[Cache] Update failed:", e.message); }
}

// 每5分钟更新一次缓存 (只在交易时段密集刷新)
cron.schedule("*/5 9-15 * * 1-5", updateMarketCache);
cron.schedule("*/15 0-8,16-23 * * 1-5", updateMarketCache);

// ==================== API路由 ====================
app.get("/api/market_temp", (req, res) => {
    if (marketCache) { res.json({ success: true, data: marketCache, cached: Date.now() - marketCacheTime < CACHE_TTL }); }
    else { res.status(503).json({ success: false, message: "Cache warming up..." }); }
});

app.get("/api/health", (req, res) => {
    res.json({ status: "ok", uptime: Math.round(process.uptime()), cacheAge: marketCacheTime ? Math.round((Date.now() - marketCacheTime) / 1000) + "s ago" : "none" });
});

app.get("/api/indicator/csi300", async (req, res) => {
    try {
        const data = await fetchCSI300();
        if (!data) return res.status(503).json({ success: false });
        const closes = data.map(k => k.close);
        const last = closes[closes.length - 1];
        const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const ma60 = closes.slice(-60).reduce((a, b) => a + b, 0) / Math.min(60, closes.length);
        const ma200 = closes.slice(-200).reduce((a, b) => a + b, 0) / Math.min(200, closes.length);
        const rets = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
        const avg20 = rets.slice(-20).reduce((a, b) => a + b, 0) / 20;
        const std20 = Math.sqrt(rets.slice(-20).map(r => Math.pow(r - avg20, 2)).reduce((a, b) => a + b, 0) / 20);
        const vol = std20 * Math.sqrt(252);
        res.json({ success: true, data: { close: last, ma20: ma20.toFixed(2), ma60: ma60.toFixed(2), ma200: ma200.toFixed(2), realizedVol: (vol * 100).toFixed(2), aboveMA200: last > ma200, history: closes.slice(-30) } });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get("/api/indicator/margin", async (req, res) => {
    try {
        const data = await fetchMargin();
        res.json({ success: true, data });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get("/api/indicator/valuation", async (req, res) => {
    try {
        const data = await fetchIndexValuation();
        res.json({ success: true, data });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

app.get("/api/indicator/sector", async (req, res) => {
    try {
        const data = await fetchSectorData();
        res.json({ success: true, data });
    } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ==================== 静态文件 ====================
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => { res.sendFile(path.join(__dirname, "public", "index.html")); });

app.listen(PORT, () => {
    console.log("CEDAR AI Server running on port " + PORT);
    console.log("API: http://localhost:" + PORT + "/api/market_temp");
    updateMarketCache();
});
