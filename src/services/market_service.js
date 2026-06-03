const axios = require("axios");
const path = require("path");
const fs = require("fs");

const DATA_DIR = path.join(__dirname, "../data");
const TUSHARE_TOKEN = process.env.TUSHARE_TOKEN || "51fbaa947c34a4caa000e1323fa20153f93a34b1fea1f6b98196e59e";
const TUSHARE_BASE = "http://api.tushare.pro";

// 沪深300历史K线 (腾讯证券)
async function fetchCSI300(klineCount = 250) {
    try {
        const url = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?_var=kline_dayqfq&param=sh000300,day,,," + klineCount + ",qfq";
        const r = await axios.get(url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 8000 });
        const match = r.data.match(/\{.*\}/);
        if (!match) return null;
        const d = JSON.parse(match[0]);
        const klines = d.data.sh000300.day;
        return klines.map(k => ({
            date: k[0], open: parseFloat(k[1]), close: parseFloat(k[2]),
            high: parseFloat(k[3]), low: parseFloat(k[4]), vol: parseFloat(k[5])
        }));
    } catch (e) { console.error("CSI300 fetch error:", e.message); return null; }
}

// Tushare API调用封装
async function tushareApi(apiName, params, fields) {
    try {
        const payload = new URLSearchParams({
            api_name: apiName,
            token: TUSHARE_TOKEN,
            params: JSON.stringify(params || {}),
            fields: fields || ""
        });
        const r = await axios.post(TUSHARE_BASE, payload, { timeout: 10000 });
        if (r.data.code !== 0) throw new Error(r.data.msg || "unknown error");
        return r.data.data;
    } catch (e) { console.error("Tushare(" + apiName + ") error:", e.message); return null; }
}

// Shibor利率
async function fetchShibor() {
    try {
        const data = await tushareApi("shibor", {}, "shibor1w,shibor2w,shibor1m,shibor3m,shibor6m,shibor9m,shibor1y");
        if (!data || !data.items || data.items.length === 0) return { shibor3m: 1.652, shibor1y: 1.7 };
        const fields = data.fields;
        const row = data.items[data.items.length - 1];
        const obj = {}; fields.forEach((f, i) => obj[f] = row[i]);
        return {
            shibor3m: parseFloat(obj.shibor3m || 1.652),
            shibor1y: parseFloat(obj.shibor1y || 1.7),
            shibor1w: parseFloat(obj.shibor1w || 0),
            shibor2w: parseFloat(obj.shibor2w || 0),
            shibor1m: parseFloat(obj.shibor1m || 0),
            shibor6m: parseFloat(obj.shibor6m || 0)
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

// 计算市场温度
function calcMarketTemp(raw) {
    const closes = raw.csi300.map(k => k.close);
    const last = closes[closes.length - 1];
    const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const ma60 = closes.slice(-60).reduce((a, b) => a + b, 0) / Math.min(60, closes.length);
    const ma200 = closes.slice(-200).reduce((a, b) => a + b, 0) / Math.min(200, closes.length);
    const rets = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
    const avgRet20 = rets.slice(-20).reduce((a, b) => a + b, 0) / 20;
    const std20 = Math.sqrt(rets.slice(-20).map(r => Math.pow(r - avgRet20, 2)).reduce((a, b) => a + b, 0) / 20);
    const realizedVol = std20 * Math.sqrt(252);
    const spread = (raw.shibor.shibor3m - raw.shibor.shibor1y) * 100;
    const uc = raw.fx.usdCny;

    const score1 = last > ma200 ? Math.min(Math.round((last / ma200 - 1) * 500 + 50), 100) : Math.max(Math.round(50 - (1 - last / ma200) * 500), 0);
    const score2 = realizedVol <= 0.15 ? Math.min(Math.round(50 + (0.15 - realizedVol) * 400), 100) : Math.max(Math.round(50 - (realizedVol - 0.15) * 300), 0);
    const score3 = 65;
    const score4 = spread < -0.1 ? 35 : spread < 0 ? 50 : 65;
    const score5 = uc < 7.0 ? 80 : uc < 7.3 ? 65 : uc < 7.8 ? 50 : 35;
    const score6 = 60;
    const scores = [score1, score2, score3, score4, score5, score6];
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    const label = avg >= 80 ? "Hot" : avg >= 65 ? "Warm" : avg >= 50 ? "Cool" : "Cold";

    return {
        score: Math.round(avg), label,
        csi300: { close: last, ma20: ma20.toFixed(2), ma60: ma60.toFixed(2), ma200: ma200.toFixed(2), realizedVol: (realizedVol * 100).toFixed(2), aboveMA200: last > ma200, distFromMA200: ((last / ma200 - 1) * 100).toFixed(2) },
        fx: { usdCny: uc.toFixed(4) },
        shibor: { shibor3m: raw.shibor.shibor3m, shibor1y: raw.shibor.shibor1y, spread: spread.toFixed(3) },
        indicators: [
            { name: "沪深300 MA200", value: Math.round(last), score: score1, flag: last > ma200 ? "Above MA200" : "Below MA200" },
            { name: "恐慌波动率", value: (realizedVol * 100).toFixed(1) + "%", score: score2, flag: realizedVol <= 0.15 ? "Low" : realizedVol <= 0.25 ? "Normal" : "High" },
            { name: "融资余额", value: "TBD", score: score3, flag: "Real data pending" },
            { name: "信用利差", value: spread.toFixed(3) + "%", score: score4, flag: spread < 0 ? "Inverted" : "Normal" },
            { name: "人民币汇率", value: uc.toFixed(2), score: score5, flag: uc < 7.3 ? "Strong" : "Weak" },
            { name: "认沽认购比", value: "TBD", score: score6, flag: "Real data pending" }
        ],
        updatedAt: new Date().toISOString()
    };
}

module.exports = { fetchCSI300, fetchShibor, fetchFX, calcMarketTemp, tushareApi };
