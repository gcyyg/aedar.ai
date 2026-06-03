const axios = require('axios');

// Tushare token - stored in environment variable
const getToken = () => process.env.TUSHARE_TOKEN || '51fbaa947c34a4caa000e1323fa20153f93a34b1fea1f6b98196e59e';

// Tushare API wrapper (using their HTTP API)
async function tusharePost(apiName, params) {
    const token = getToken();
    try {
        const r = await axios.post('http://api.tushare.pro', {
            api_name: apiName,
            token: token,
            params: params,
            fields: '*'
        }, { timeout: 10000 });
        if (r.data.code !== 0) throw new Error(r.data.msg);
        return r.data.data;
    } catch (e) {
        console.error(`Tushare ${apiName} error:`, e.message);
        return null;
    }
}

async function getShibor() {
    // Use Shibor data from tushare
    // Note: high frequency limited, use cached data when possible
    const result = await tusharePost('shibor', { start_date: '20250603', end_date: '20250603' });
    if (result && result.items && result.items.length > 0) {
        const headers = result.fields;
        const row = result.items[0];
        const obj = {};
        headers.forEach((h, i) => { obj[h] = row[i]; });
        return {
            shibor3m: parseFloat(obj['3m'] || 1.652),
            shibor1y: parseFloat(obj['1y'] || 1.7),
            updatedAt: new Date().toISOString()
        };
    }
    return { shibor3m: 1.652, shibor1y: 1.7, updatedAt: new Date().toISOString(), note: 'fallback' };
}

module.exports = { getShibor };
