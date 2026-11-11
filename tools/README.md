# 行情与财报数据刷新机制

本站公司数据分为**两层**，严格分开更新，杜绝 TTM 与年报、GAAP 与非 GAAP 口径混用。

## 两层口径

| 层 | 字段 | 更新频率 | 数据来源 |
|---|---|---|---|
| 行情层 | 总市值 `mktcap`、市销率 `ps` | **每个交易日收盘后自动刷新** | Wind / 同花顺 iFinD 最新总市值 |
| 年报层 | 财年 `fy`、营业收入 `rev`、销售毛利率 `gm`、归母净利润 `ni` | **仅在发布新一份完整财年年报后更新** | 公司年报 / 10-K / 官方财报新闻稿（IR） |

- 市销率 `PS = 最新总市值 ÷ 最新完整财年营业收入`，同币种、无量纲、保留 2 位，页面统一标注「测算」，不采用 PS-TTM。
- 已私有化 / 被收购公司（CyberArk、Sophos、Kaspersky、Darktrace、OneTrust、Mimecast）**冻结**：不进行情表、不刷市值、不算 PS，沿用收购对价或最近一轮估值与最后一份公开年报。
- 趋势科技（4704.T）为日本会计准则、日元原币；PS 用日元同币种复算，美元市值按当期 USD/JPY 折算。

## 文件

- `data/quotes.latest.json`：行情层与年报层的结构化数据、行情截止日、汇率、来源、冻结清单，是审计与复算的唯一数据底稿。
- `index.html` 中 `// __QUOTE_START__ … // __QUOTE_END__` 之间的 `QUOTE` 区块为自动生成区，**禁止手工编辑**；页面加载时由 `applyQuotes()` 把行情层覆盖到各公司，年报层字段不受影响。
- `tools/apply-quotes.js`：读取 JSON，做键校验、PS 复算、冻结保护和 JS 语法校验后，确定性重建 `QUOTE` 区块；任一步失败即非零退出、不写盘。
- `tools/push-github.js`：经 GitHub Contents API 提交到 `main`，Token 只从环境变量 `GITHUB_TOKEN` 或仓库外文件 `~/.config/cyber-map-github-token` 读取，不入库、不回显。

## 每日自动刷新流程（定时任务执行）

1. 用 Wind / 同花顺逐家取 26 家在交易公司最新总市值（A 股沪深收盘、美股美东收盘、日股收盘），更新 `data/quotes.latest.json` 的 `quotes[].mktcap`、`quoteDate` 与 `meta.quoteAsof`、汇率。
2. 同币种重算每家 `ps`（= 新市值 ÷ 当前最新完整财年营收），写入 JSON。
3. 运行 `node tools/apply-quotes.js`（会自动复算校验并重建区块；先想只校验可加 `--check`）。
4. 运行 `node tools/push-github.js "chore(quotes): 每日行情刷新 YYYY-MM-DD"` 推送；脚本先验证 Token，401 即中止并提示更换。
5. 推送后约 1–2 分钟，带时间戳回读线上 `index.html?v=…` 核验。

## 新财年年报更新流程（人工，低频）

当某公司发布新一份**完整财年年报**时，才修改 `index.html` 该公司 `fin` 的 `fy/rev/gm/ni`，并同步 `data/quotes.latest.json` 的 `annuals[]`；GAAP 毛利率优先取公司官方财报新闻稿/10-K 的全年口径（必要时用全年毛利÷总营收复算并保留来源链接）。季报、TTM、非 GAAP 数据一律不写入年报层。

## 复算与自检

```bash
node tools/apply-quotes.js --check   # 键齐全 + PS 复算 + 冻结保护 + 语法校验，不写盘
node tools/apply-quotes.js           # 校验通过后重建 index.html 行情区块
```
