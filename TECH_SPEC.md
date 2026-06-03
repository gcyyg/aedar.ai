# CEDAR AI 动态Web架构技术方案

## 1. 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                      用户浏览器                              │
│              Vue 3 SPA (CDN引入, 无构建)                      │
└─────────────────────┬───────────────────────────────────────┘
                      │ HTTP /api/*
                      ▼
┌─────────────────────────────────────────────────────────────┐
│                   Express.js 服务端                          │
│                   Port 8080                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  静态文件    │  │  API路由     │  │  定时任务 (node-cron) │  │
│  │  /public/* │  │  /api/*    │  │  每5分钟刷新缓存      │  │
│  └─────────────┘  └──────┬──────┘  └─────────────────────┘  │
│                           │                                  │
│                     ┌─────▼─────┐                            │
│                     │  数据缓存  │  /tmp/market_cache.json   │
│                     │  (TTL 5min)│                           │
│                     └─────┬─────┘                            │
└───────────────────────────┼───────────────────────────────────┘
                            │
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
      ┌──────────────┐ ┌──────────┐ ┌──────────────┐
      │  腾讯证券API  │ │ Tushare  │ │ Frankfurt   │
      │ qt.gtimg.cn  │ │ (Shibor) │ │ API (汇率)   │
      └──────────────┘ └──────────┘ └──────────────┘
```

**设计原则**：
- **读缓存优先**：API响应走缓存，<50ms，避免Tushare 1req/min限速
- **后台预取**：node-cron每5分钟刷新缓存，交易时段(9:30-15:00 CST)自动降频
- **无构建依赖**：Vue 3通过CDN引入，drop-in部署

---

## 2. 技术栈

### 前端
| 技术 | 用途 | 引入方式 |
|------|------|----------|
| Vue 3 | 响应式框架 | `unpkg.com/vue@3` CDN |
| ECharts 5 | 图表 | `cdn.jsdelivr.net/npm/echarts` |
| 原生CSS | 样式 | 内联，无构建 |

### 后端
| 技术 | 版本 | 用途 |
|------|------|------|
| Node.js | v22 | 运行时 |
| Express | 4.18 | HTTP服务 + API路由 |
| axios | latest | HTTP客户端 |
| node-cron | latest | 定时任务 |

### 数据源
| 数据 | 来源 | 频率限制 |
|------|------|----------|
| 沪深300实时 | `qt.gtimg.cn` | 无限制 |
| Shibor利率 | Tushare Pro | 1 req/min |
| USD/CNY | Frankfurt API | 无限制 |
| 历史数据 | Tushare Pro | 1 req/min |

---

## 3. 核心API

### `GET /api/market_temp`
返回市场综合温度评分。

**响应示例**：
```json
{
  "success": true,
  "data": {
    "score": 67,
    "label": "WARM",
    "last_close": 4991.50,
    "ma200": 4615,
    "vol20": 16.4,
    "usd_cny": 6.76,
    "credit_spread": 0.048,
    "updated_at": "2026-06-03T04:05:00Z",
    "source": "cache"
  }
}
```

### `GET /api/indicator/:id`
返回单项指标原始数据，用于详情页。

| id | 指标 |
|----|------|
| `csi300` | 沪深300行情 |
| `volatility` | 恐慌波动率 |
| `margin` | 融资余额(模拟) |
| `credit_spread` | 信用利差 |
| `fx` | 人民币汇率 |
| `put_call` | 认沽认购比(模拟) |

### `GET /api/history`
返回历史评分序列(30天)。

### `GET /api/health`
健康检查。

---

## 4. 缓存策略

### 分层缓存
```
用户请求
    │
    ▼
┌─────────────┐ 命中? ──→ 直接返回 (<50ms)
│   内存/磁盘  │
│   缓存JSON   │
└──────┬──────┘ 未命中?
       │ age > 5min?
       ▼
  ┌──────────┐  ──→ fetch外部API → 更新缓存 → 返回
  │ 外部API  │
  └──────────┘
```

### node-cron预取
```javascript
// 每5分钟执行，交易时段更密集
cron.schedule('*/5 9-15 * * 1-5', fetchAllData);  // 交易时段
cron.schedule('*/15 0-8,16-23 * * 1-5', fetchAllData); // 非交易时段
```

### 缓存文件
```
/tmp/market_cache.json  ──→ 市场温度主缓存
/tmp/shibor_cache.json   ──→ Shibor单独缓存(1req/min)
/tmp/history_cache.json  ──→ 30天历史缓存(日更)
```

---

## 5. 模块页面规划

| 编号 | 页面 | 指标 | 优先级 |
|------|------|------|--------|
| M6 | 市场温度主页 | 综合评分 | P0 |
| M2 | 板块评分 | 各行业轮动 | P1 |
| M3E | 成长评分 | 营收/利润增速 | P1 |
| M3D | 价值评分 | PE/PB/PCF | P1 |
| M4 | 估值分析 | DCF/NAV | P2 |
| M5 | 风险评级 | Beta/波动率/VaR | P2 |

---

## 6. 部署架构

### 当前环境
- **云VM**: `10.3.0.14` (内网) / `43.160.252.16` (公网)
- **HTTP服务**: Port 8080
- **远程访问**: Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:8080`)

### 部署步骤
```bash
cd ~/aedar.ai

# 安装依赖
npm install

# 启动服务
TUSHARE_TOKEN=51fbaa... node server.js

# 建立tunnel(前台运行)
cloudflared tunnel --url http://localhost:8080
```

### PM2进程管理(生产推荐)
```bash
npm install -g pm2
pm2 start server.js --name cedar-api
pm2 save
pm2 startup
```

---

## 7. 扩展路线

### Phase 2 - 实时数据
- WebSocket推送市场数据(`ws`模块)
- 腾讯证券WebSocket行情
- 浏览器端Vue响应式实时更新

### Phase 3 - 历史分析
- `/api/backtest` 回测接口
- ECharts K线图 + 交易信号标记
- Pandas数据分析

### Phase 4 - 用户系统
- `/api/auth/*` JWT认证
- 用户自选股/自选板块
- 微信内嵌H5页面

---

## 8. 性能目标

| 指标 | 目标 | 实际(当前) |
|------|------|-----------|
| API响应时间 | <100ms | ~30ms(cache) |
| 页面首屏加载 | <2s | ~1.2s |
| Tushare限速 | 1req/min | 1req/5min |
| 可用性 | >99% | 100% |
