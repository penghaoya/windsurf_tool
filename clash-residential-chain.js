// Clash Verge Rev / Mihomo 覆盖脚本
// Windsurf 流量走「动态住宅 IP 池 + 链式代理」
//
// 拓扑:
//   Client → 本地 Clash → ♻️ 链式中转(已有翻墙节点) → 🏠 住宅 SOCKS5 → windsurf.com
//                                                       ↑
//                                                 dialer-proxy 链路
//
// 设计原理:
//   1. 每次 Clash 加载/重载配置, 脚本动态生成一批住宅节点
//   2. 每个节点的 session 随机 (8位随机数), 服务商基于 session 分配新住宅 IP
//   3. 节点 name 固定 (如 "🇬🇧 住宅-GB-01"), 重载时 name 不变但底层 IP 自动轮换
//   4. dialer-proxy 自动注入 → 住宅 SOCKS5 流量先经过 ♻️ 链式中转
//   5. 自动建组 (按地区) + 自动加规则 (windsurf.com / codeium.com)
//
// 使用方式:
//   Clash Verge Rev → 配置 → 覆盖 → 新建 JavaScript 覆盖 → 粘贴此脚本
//   只需要调 POOL_CONFIG 改国家和数量, 其他全自动

// ═══════════════════════════════════════════════════════════════
// 住宅 IP 池配置 — 只需要改这里
// ═══════════════════════════════════════════════════════════════

// 每个国家生成多少节点; sessTime = 单会话保持时间 (分钟)
//   sessTime 短(10) → IP 频繁轮换, 适合 multi-account 防关联
//   sessTime 长(180) → 长连接稳定, 适合保持登录态
const POOL_CONFIG = [
  { region: "GB", count: 5, sessTime: 10 },   // 英国
  { region: "US", count: 5, sessTime: 10 },   // 美国
  { region: "JP", count: 5, sessTime: 180 },  // 日本 (长会话)
  // 增减国家直接改这里, 自动生效:
  // { region: "DE", count: 3, sessTime: 10 },
  // { region: "SG", count: 3, sessTime: 10 },
  // { region: "FR", count: 3, sessTime: 10 },
];

// 服务商凭证 — 来自 https://b2proxy / bestgo.work 控制台
const PROVIDER = {
  hostname: "us.rrp.bestgo.work",
  port: 10000,
  user: "USER318898",
  password: "9038b6",
  sessAuto: 1,
};

// ═══════════════════════════════════════════════════════════════
// 其余可调参数
// ═══════════════════════════════════════════════════════════════

const GROUP_SELECTOR = "🌊 Windsurf";        // 主选择器 (规则指向此组)
const GROUP_POOL_AUTO = "🏠 住宅自动";        // 全池 url-test
const GROUP_CHAIN = "♻️ 链式中转";            // 住宅节点 dialer-proxy 上游

// 域名规则 (windsurf 全链路)
const DOMAIN_RULES = [
  "DOMAIN-SUFFIX,windsurf.com",
  "DOMAIN-SUFFIX,codeium.com",
  "DOMAIN-SUFFIX,exafunction.com",
   "DOMAIN-SUFFIX,ippure.com",
];

// 健康检测
const HEALTH_URL = "http://www.gstatic.com/generate_204";
const HEALTH_INTERVAL = 300;
const HEALTH_TOLERANCE = 100;
const HEALTH_TIMEOUT = 3000;

// 链式中转候选过滤 — 排除特殊节点/信息节点/住宅自己/主组
const CHAIN_EXCLUDE_RE =
  /剩余|到期|流量|官网|套餐|续费|Traffic|Expire|GB|住宅|residential|DIRECT|REJECT|🏠|🌊|♻️|节点信息/i;

// 国家代码 → 显示名 + 国旗 (用于分组命名)
const REGION_LABEL = {
  US: "🇺🇸 美国住宅", GB: "🇬🇧 英国住宅", JP: "🇯🇵 日本住宅",
  SG: "🇸🇬 新加坡住宅", HK: "🇭🇰 香港住宅", TW: "🇹🇼 台湾住宅",
  KR: "🇰🇷 韩国住宅", DE: "🇩🇪 德国住宅", FR: "🇫🇷 法国住宅",
  NL: "🇳🇱 荷兰住宅", CA: "🇨🇦 加拿大住宅", AU: "🇦🇺 澳洲住宅",
  IN: "🇮🇳 印度住宅", BR: "🇧🇷 巴西住宅", RU: "🇷🇺 俄罗斯住宅",
  IT: "🇮🇹 意大利住宅", ES: "🇪🇸 西班牙住宅", CH: "🇨🇭 瑞士住宅",
  SE: "🇸🇪 瑞典住宅", NO: "🇳🇴 挪威住宅",
};

const REGION_FLAG = {
  US: "🇺🇸", GB: "🇬🇧", JP: "🇯🇵", SG: "🇸🇬", HK: "🇭🇰",
  TW: "🇹🇼", KR: "🇰🇷", DE: "🇩🇪", FR: "🇫🇷", NL: "🇳🇱",
  CA: "🇨🇦", AU: "🇦🇺", IN: "🇮🇳", BR: "🇧🇷", RU: "🇷🇺",
  IT: "🇮🇹", ES: "🇪🇸", CH: "🇨🇭", SE: "🇸🇪", NO: "🇳🇴",
};

// ═══════════════════════════════════════════════════════════════
// 主入口
// ═══════════════════════════════════════════════════════════════

function main(config) {
  config.proxies = config.proxies || [];
  config["proxy-groups"] = config["proxy-groups"] || [];
  config.rules = config.rules || [];

  // 1. 动态生成住宅节点 (随机 session → 新 IP)
  const residentials = generateResidentialPool();

  // 2. 注入 proxies (新节点放前面, 用户原有节点保留)
  injectProxies(config, residentials);

  // 3. 挑链式中转候选 (从用户已有的节点中选, 排除住宅自己)
  const chainCandidates = pickChainCandidates(config.proxies, residentials);

  // 4. 按地区分桶
  const regionMap = bucketByRegion(residentials);

  // 5. 建组 + 注入 (去重)
  const newGroups = buildGroups(residentials, regionMap, chainCandidates);
  upsertGroups(config, newGroups);

  // 6. 加规则 (顶部插入)
  prependRules(config, buildRules());

  return config;
}

// ═══════════════════════════════════════════════════════════════
// 住宅节点生成器
// ═══════════════════════════════════════════════════════════════

// 生成 8 位随机 session ID (服务商基于 session 分配独立住宅 IP)
function randomSession() {
  return Math.floor(Math.random() * 89999999) + 1e7;
}

// 构建单个住宅节点
function buildResidentialProxy({ region, sessTime, index }) {
  const session = randomSession();
  const idx = String(index).padStart(2, "0");
  const flag = REGION_FLAG[region] || "🏠";
  const username =
    `${PROVIDER.user}-zone-custom-region-${region}` +
    `-session-${session}-sessTime-${sessTime}-sessAuto-${PROVIDER.sessAuto}`;

  return {
    name: `${flag} 住宅-${region}-${idx}`,
    type: "socks5",
    server: PROVIDER.hostname,
    port: PROVIDER.port,
    username,
    password: PROVIDER.password,
    udp: false,
    "dialer-proxy": GROUP_CHAIN,
  };
}

// 按 POOL_CONFIG 生成全池
function generateResidentialPool() {
  const pool = [];
  for (const { region, count, sessTime } of POOL_CONFIG) {
    for (let i = 1; i <= count; i++) {
      pool.push(buildResidentialProxy({ region, sessTime, index: i }));
    }
  }
  return pool;
}

// ═══════════════════════════════════════════════════════════════
// 节点注入 / 分组
// ═══════════════════════════════════════════════════════════════

// 注入到 config.proxies (按 name 去重 — 已存在则覆盖, 实现"重载即换 IP")
function injectProxies(config, residentials) {
  const existing = new Map(config.proxies.map((p) => [p.name, p]));
  for (const p of residentials) {
    existing.set(p.name, p);
  }
  config.proxies = Array.from(existing.values());
}

// 推断节点所属国家 (从 username 里抓 region-XX)
function detectRegion(proxy) {
  const m =
    proxy.username && String(proxy.username).match(/region-([A-Z]{2})/i);
  return m ? m[1].toUpperCase() : "OTHER";
}

// 按国家分桶
function bucketByRegion(residentials) {
  const map = {};
  for (const p of residentials) {
    const region = detectRegion(p);
    if (!map[region]) map[region] = [];
    map[region].push(p.name);
  }
  return map;
}

// 挑链式中转候选 — 从现有可用节点选 (排除住宅自己和特殊项)
function pickChainCandidates(allProxies, residentials) {
  const residentialNames = new Set(residentials.map((p) => p.name));
  return allProxies
    .map((p) => p.name)
    .filter(
      (n) => n && !residentialNames.has(n) && !CHAIN_EXCLUDE_RE.test(n)
    );
}

// ═══════════════════════════════════════════════════════════════
// 组装 proxy-groups
// ═══════════════════════════════════════════════════════════════

function buildGroups(residentials, regionMap, chainCandidates) {
  const groups = [];
  const allNames = residentials.map((p) => p.name);

  // 1. 链式中转 — 住宅节点的 dialer-proxy 上游
  groups.push({
    name: GROUP_CHAIN,
    type: "url-test",
    proxies: chainCandidates.length ? chainCandidates : ["DIRECT"],
    url: HEALTH_URL,
    interval: HEALTH_INTERVAL,
    tolerance: HEALTH_TOLERANCE,
    timeout: HEALTH_TIMEOUT,
    lazy: false,
  });

  // 2. 全池自动选最快
  groups.push({
    name: GROUP_POOL_AUTO,
    type: "url-test",
    proxies: allNames,
    url: HEALTH_URL,
    interval: HEALTH_INTERVAL,
    tolerance: HEALTH_TOLERANCE,
    timeout: HEALTH_TIMEOUT,
    lazy: false,
  });

  // 3. 按地区分组
  const regionGroups = [];
  for (const [region, names] of Object.entries(regionMap)) {
    if (names.length === 0) continue;
    const groupName = REGION_LABEL[region] || `🏠 ${region}`;
    regionGroups.push(groupName);
    groups.push({
      name: groupName,
      type: "url-test",
      proxies: names,
      url: HEALTH_URL,
      interval: HEALTH_INTERVAL,
      tolerance: HEALTH_TOLERANCE,
      timeout: HEALTH_TIMEOUT,
      lazy: true,
    });
  }

  // 4. 主选择器 — 规则指向此组
  groups.push({
    name: GROUP_SELECTOR,
    type: "select",
    proxies: [GROUP_POOL_AUTO, ...regionGroups, ...allNames, "DIRECT"],
  });

  return groups;
}

// 注入组到 config (去重 — 已存在则用新的覆盖, 保证 url-test 列表是最新的)
function upsertGroups(config, newGroups) {
  const newNames = new Set(newGroups.map((g) => g.name));
  // 先剔除同名旧组 (避免引用已被替换的旧节点)
  config["proxy-groups"] = config["proxy-groups"].filter(
    (g) => !newNames.has(g.name)
  );
  // 顶部插入新组
  config["proxy-groups"] = [...newGroups, ...config["proxy-groups"]];
}

// ═══════════════════════════════════════════════════════════════
// 规则注入
// ═══════════════════════════════════════════════════════════════

function buildRules() {
  return DOMAIN_RULES.map((r) => `${r},${GROUP_SELECTOR}`);
}

function prependRules(config, rules) {
  const set = new Set(config.rules);
  const toInsert = rules.filter((r) => !set.has(r));
  config.rules = [...toInsert, ...config.rules];
}
