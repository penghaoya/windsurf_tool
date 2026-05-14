// Clash Verge Rev / Clash Meta (mihomo) Override Script
// Windsurf 多账号防关联分流 + IP 池自动轮转
//
// 核心目标: 多账号切换时自动切换出口 IP，防止 Windsurf 通过 IP 关联账号导致集体限流
//
// 架构:
//   ┌─────────────┐   切号时 PUT API   ┌─────────────────────┐
//   │ windsurf-    │ ───────────────→  │  Clash Meta          │
//   │ tools VSIX   │                    │  🌊 Windsurf Slots   │
//   │ (clashBridge)│ ←─────────────── │  slot-0 ~ slot-N     │
//   └─────────────┘   200 OK           └─────────────────────┘
//
// 使用方式:
//   Clash Verge Rev → 订阅 → 编辑 → Script → 粘贴此脚本
//   或: 配置 → 全局扩展脚本 → 粘贴此脚本
//
// 配合 windsurf-tools:
//   设置 → wam.clashApiUrl = "http://127.0.0.1:9090" (Clash RESTful API 地址)
//   设置 → wam.clashApiSecret = "your-secret" (如有)
//   切号时自动调 Clash API 切节点，实现账号-IP 绑定

// ═══ 可调参数 ═══
const SLOT_COUNT = 8;                   // IP 槽位数 (≥ 你的账号数)
const HEALTH_URL = "https://cp.cloudflare.com";  // 不要用 server.codeium.com (gRPC, GET 不返回200)
const HEALTH_INTERVAL = 180;            // 测速间隔 (秒)
const HEALTH_TOLERANCE = 100;           // 延迟容差 (ms), 差值在此范围内不切节点
const HEALTH_TIMEOUT = 3000;            // 测速超时 (ms)

function main(config) {
  // ============================================================
  // 1. 节点分类 — 按地区分桶，构建 IP 多样性池
  // ============================================================
  const allProxies = (config.proxies || []).map((p) => p.name);

  const EXCLUDE_RE =
    /剩余|到期|官网|流量|套餐|续费|Traffic|Expire|DIRECT|REJECT|广告|🏠/i;
  const availableProxies = allProxies.filter((n) => !EXCLUDE_RE.test(n));

  const REGION_PATTERNS = [
    { name: "US", re: /美国|US|United\s*States|🇺🇸/i },
    { name: "JP", re: /日本|JP|Japan|🇯🇵/i },
    { name: "SG", re: /新加坡|SG|Singapore|🇸🇬/i },
    { name: "HK", re: /香港|HK|Hong\s*Kong|🇭🇰/i },
    { name: "TW", re: /台湾|TW|Taiwan|🇼/i },
    { name: "KR", re: /韩国|KR|Korea|🇰🇷/i },
    { name: "EU", re: /德国|英国|法国|荷兰|DE|UK|FR|NL|EU|Europe|🇩🇪|🇬🇧|🇫🇷/i },
  ];

  const regionBuckets = {};
  for (const { name, re } of REGION_PATTERNS) {
    regionBuckets[name] = availableProxies.filter((n) => re.test(n));
  }

  // 未匹配任何地区的节点
  const classified = new Set(Object.values(regionBuckets).flat());
  regionBuckets["OTHER"] = availableProxies.filter((n) => !classified.has(n));

  // Windsurf 优选地区 (服务端在美国, US 延迟最优)
  const PREFERRED_ORDER = ["US", "JP", "SG", "HK", "TW", "KR", "EU", "OTHER"];
  const windsurfPool = PREFERRED_ORDER.flatMap((r) => regionBuckets[r] || []);
  const windsurfCandidates = windsurfPool.length >= 2 ? windsurfPool : availableProxies;

  // ============================================================
  // 2. IP 槽位系统 — 每个账号绑定独立槽位，出口 IP 物理隔离
  // ============================================================
  //
  // 原理: 创建 N 个 select 类型代理组 (slot-0 ~ slot-N)
  //       windsurf-tools 切号时调 Clash API 给对应 slot 选不同节点
  //       实现: 账号 A → slot-0 → 美国节点1
  //            账号 B → slot-1 → 日本节点2
  //            账号 C → slot-2 → 新加坡节点3
  //
  // 即使不配合扩展，slot 也默认 url-test 自动选最快节点

  // 为每个 slot 按 round-robin 方式分配不同的默认节点顺序
  // 确保不同 slot 初始就指向不同节点
  function rotateArray(arr, offset) {
    if (arr.length === 0) return arr;
    const n = offset % arr.length;
    return [...arr.slice(n), ...arr.slice(0, n)];
  }

  const slotGroups = [];
  for (let i = 0; i < SLOT_COUNT; i++) {
    slotGroups.push({
      name: `� Windsurf Slot-${i}`,
      type: "url-test",
      proxies: windsurfCandidates.length
        ? rotateArray(windsurfCandidates, i * Math.max(1, Math.floor(windsurfCandidates.length / SLOT_COUNT)))
        : ["DIRECT"],
      url: HEALTH_URL,
      interval: HEALTH_INTERVAL,
      tolerance: HEALTH_TOLERANCE,
      lazy: i >= 3,
      timeout: HEALTH_TIMEOUT,
      "expected-status": "200-204",
    });
  }

  // ============================================================
  // 3. 主控代理组
  // ============================================================
  const proxyGroups = [
    // 当前激活槽位 — windsurf-tools 通过 API 切换此组指向哪个 slot
    {
      name: "🌊 Windsurf",
      type: "select",
      proxies: [
        ...slotGroups.map((g) => g.name),
        "🌊 Windsurf Auto",
        "🌊 Windsurf LB",
        ...availableProxies,
        "DIRECT",
      ],
    },

    // 自动选最快 (不配合扩展时的 fallback)
    {
      name: "🌊 Windsurf Auto",
      type: "url-test",
      proxies: windsurfCandidates.length ? windsurfCandidates : ["DIRECT"],
      url: HEALTH_URL,
      interval: HEALTH_INTERVAL,
      tolerance: HEALTH_TOLERANCE,
      lazy: false,
      timeout: HEALTH_TIMEOUT,
    },

    // 负载均衡 — 每条连接随机分配节点 (IP 自然分散, 无需扩展配合)
    {
      name: "🌊 Windsurf LB",
      type: "load-balance",
      proxies: windsurfCandidates.length ? windsurfCandidates : ["DIRECT"],
      url: HEALTH_URL,
      interval: HEALTH_INTERVAL,
      lazy: false,
      strategy: "round-robin",
    },

    // Fallback — 主节点挂了自动切
    {
      name: "🌊 Windsurf Fallback",
      type: "fallback",
      proxies: windsurfCandidates.length
        ? [...windsurfCandidates, "DIRECT"]
        : ["DIRECT"],
      url: HEALTH_URL,
      interval: 120,
      lazy: false,
      timeout: HEALTH_TIMEOUT,
    },

    // Firebase 认证 — 必须和主 Windsurf 组走同一出口 IP！
    // 否则: Firebase 登录 IP-A ≠ Windsurf 验证 IP-B → token 被拒
    {
      name: "🔐 Firebase Auth",
      type: "select",
      proxies: [
        "🌊 Windsurf",  // 默认跟随主组 (保证 IP 一致)
        "🌊 Windsurf Auto",
        ...availableProxies,
        "DIRECT",
      ],
    },

    // 各 IP 槽位
    ...slotGroups,
  ];

  // ============================================================
  // 4. 分流规则 — Windsurf 全链路
  // ============================================================
  const windsurfRules = [
    // --- Windsurf Core (gRPC + Connect-RPC) ---
    "DOMAIN-SUFFIX,codeium.com,🌊 Windsurf",
    "DOMAIN-SUFFIX,windsurf.com,🌊 Windsurf",
    "DOMAIN-SUFFIX,windsurf.ai,🌊 Windsurf",
    "DOMAIN-SUFFIX,exafunction.com,🌊 Windsurf",

    // --- Firebase Auth (独立通道, 保持登录态稳定) ---
    "DOMAIN,identitytoolkit.googleapis.com,🔐 Firebase Auth",
    "DOMAIN,securetoken.googleapis.com,🔐 Firebase Auth",
    "DOMAIN-SUFFIX,firebaseapp.com,🔐 Firebase Auth",
    "DOMAIN-SUFFIX,firebase.googleapis.com,🔐 Firebase Auth",
    "DOMAIN-SUFFIX,cloudfunctions.net,🔐 Firebase Auth",
    "DOMAIN,firebaseinstallations.googleapis.com,🔐 Firebase Auth",

    // --- Windsurf Telemetry (走主通道, 保持 IP 一致性) ---
    "DOMAIN-SUFFIX,segment.io,🌊 Windsurf",
    "DOMAIN-SUFFIX,segment.com,🌊 Windsurf",
    "DOMAIN-SUFFIX,sentry.io,🌊 Windsurf",

    // --- VS Code Marketplace ---
    "DOMAIN-SUFFIX,visualstudio.com,🌊 Windsurf Fallback",
    "DOMAIN-SUFFIX,vscode-cdn.net,🌊 Windsurf Fallback",
    "DOMAIN-SUFFIX,gallerycdn.vsassets.io,🌊 Windsurf Fallback",
    "DOMAIN,marketplace.visualstudio.com,🌊 Windsurf Fallback",

    // --- GitHub ---
    "DOMAIN-SUFFIX,github.com,🌊 Windsurf Fallback",
    "DOMAIN-SUFFIX,githubusercontent.com,🌊 Windsurf Fallback",
    "DOMAIN-SUFFIX,github.io,🌊 Windsurf Fallback",
    "DOMAIN-SUFFIX,githubassets.com,🌊 Windsurf Fallback",

    // --- AI Model Providers ---
    "DOMAIN-SUFFIX,anthropic.com,🌊 Windsurf",
    "DOMAIN-SUFFIX,openai.com,🌊 Windsurf",
    "DOMAIN-SUFFIX,oaiusercontent.com,🌊 Windsurf",
  ];

  // ============================================================
  // 5. 合并到原有配置
  // ============================================================
  if (!config["proxy-groups"]) config["proxy-groups"] = [];
  config["proxy-groups"] = [...proxyGroups, ...config["proxy-groups"]];

  if (!config.rules) config.rules = [];
  config.rules = [...windsurfRules, ...config.rules];

  // ============================================================
  // 6. DNS 防污染
  // ============================================================
  if (!config.dns) config.dns = {};
  config.dns["enable"] = true;
  config.dns["enhanced-mode"] = "fake-ip";
  config.dns["fake-ip-filter"] = [
    ...(config.dns["fake-ip-filter"] || []),
    "*.codeium.com",
    "*.windsurf.com",
  ];

  if (!config.dns["nameserver-policy"]) config.dns["nameserver-policy"] = {};
  Object.assign(config.dns["nameserver-policy"], {
    "+.codeium.com": "https://1.1.1.1/dns-query",
    "+.windsurf.com": "https://1.1.1.1/dns-query",
    "+.googleapis.com": "https://1.1.1.1/dns-query",
    "+.firebaseapp.com": "https://1.1.1.1/dns-query",
  });

  // ============================================================
  // 7. 连接行为优化 — 降低 IP 关联风险
  // ============================================================
  // TCP 并发优化 (mihomo 特性)
  config["tcp-concurrent"] = true;

  // TLS 指纹随机化 (mihomo 特性, 降低 TLS 指纹关联)
  config["global-client-fingerprint"] = "random";

  // 统一 sniffer 避免 SNI 泄漏真实域名
  if (!config.sniffer) config.sniffer = {};
  config.sniffer.enable = true;
  config.sniffer["force-dns-mapping"] = true;
  config.sniffer["parse-pure-ip"] = true;
  config.sniffer.sniff = {
    TLS: { ports: [443, 8443] },
    HTTP: { ports: [80, 8080] },
  };

  return config;
}
