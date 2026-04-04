/**
 * Protobuf 编解码工具
 * 纯函数模块 — 从 auth.js 拆分，零状态依赖
 *
 * 逆向自 Windsurf @exa/chat-client:
 *   GetPlanStatusResponse / CheckUserMessageRateLimitRequest / Response
 */

// ========== Low-Level Varint ==========

export function readVarint(data, pos) {
  let result = 0, shift = 0;
  while (pos < data.length) {
    const b = data[pos++];
    if (shift < 28) {
      result |= (b & 0x7f) << shift;
    } else {
      result += (b & 0x7f) * (2 ** shift);
    }
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result, nextPos: pos };
}

export function encodeVarintBuf(value) {
  const bytes = [];
  let v = value;
  while (v > 127) { bytes.push((v & 0x7f) | 0x80); v >>>= 7; }
  bytes.push(v & 0x7f);
  return Buffer.from(bytes);
}

// ========== Generic Protobuf Message Parser ==========

/** Parse a single protobuf message level into { fieldNum: [{ value?, bytes?, string? }] } */
export function parseProtoMsg(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const fields = {};
  let pos = 0;
  while (pos < bytes.length) {
    // v5.11.0 FIX: Read tag as varint (fields ≥16 use multi-byte varint tags)
    // Previous bug: single-byte read corrupted fieldNum for field 16+ (e.g. billingStrategy=f35)
    const tagResult = readVarint(bytes, pos);
    const tag = tagResult.value;
    pos = tagResult.nextPos;
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x07;
    if (fieldNum === 0 || fieldNum > 1000 || pos > bytes.length) break;
    switch (wireType) {
      case 0: {
        const r = readVarint(bytes, pos);
        if (!fields[fieldNum]) fields[fieldNum] = [];
        fields[fieldNum].push({ value: r.value });
        pos = r.nextPos;
        break;
      }
      case 2: {
        const r = readVarint(bytes, pos);
        const len = r.value;
        pos = r.nextPos;
        if (len < 0 || len > 65536 || pos + len > bytes.length) { pos = bytes.length; break; }
        const data = bytes.slice(pos, pos + len);
        let str = null;
        try { const s = Buffer.from(data).toString('utf8'); if (/^[\x20-\x7e]+$/.test(s)) str = s; } catch {}
        if (!fields[fieldNum]) fields[fieldNum] = [];
        fields[fieldNum].push({ bytes: data, string: str, length: len });
        pos += len;
        break;
      }
      case 1: {
        if (pos + 8 > bytes.length) { pos = bytes.length; break; }
        if (!fields[fieldNum]) fields[fieldNum] = [];
        fields[fieldNum].push({ bytes: bytes.slice(pos, pos + 8) });
        pos += 8;
        break;
      }
      case 5: {
        if (pos + 4 > bytes.length) { pos = bytes.length; break; }
        if (!fields[fieldNum]) fields[fieldNum] = [];
        fields[fieldNum].push({ bytes: bytes.slice(pos, pos + 4) });
        pos += 4;
        break;
      }
      default: pos = bytes.length;
    }
  }
  return fields;
}

// ========== String Encode/Decode ==========

export function parseProtoString(buf) {
  const bytes = new Uint8Array(buf);
  if (bytes.length < 3 || bytes[0] !== 0x0a) return null;
  let pos = 1;
  const lenResult = readVarint(bytes, pos);
  pos = lenResult.nextPos;
  const len = lenResult.value;
  if (pos + len > bytes.length) return null;
  return Buffer.from(bytes.slice(pos, pos + len)).toString('utf8');
}

export function encodeProtoString(value, fieldNumber = 1) {
  const tokenBytes = Buffer.from(value, 'utf8');
  const tag = (fieldNumber << 3) | 2; // wire type 2 = length-delimited
  const lengthBytes = [];
  let len = tokenBytes.length;
  while (len > 127) { lengthBytes.push((len & 0x7f) | 0x80); len >>= 7; }
  lengthBytes.push(len);
  const buf = Buffer.alloc(1 + lengthBytes.length + tokenBytes.length);
  buf[0] = tag;
  Buffer.from(lengthBytes).copy(buf, 1);
  tokenBytes.copy(buf, 1 + lengthBytes.length);
  return buf;
}

// ========== Credits Parser (legacy flat scan) ==========

export function parseCredits(buf) {
  const bytes = new Uint8Array(buf);
  let used = 0, total = 100;
  // Full buffer scan for field 6 (tag=0x30) and field 8 (tag=0x40)
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === 0x30) {
      const r = readVarint(bytes, i + 1);
      if (r.value > 0 && r.value <= 100000) used = r.value / 100;
    }
    if (bytes[i] === 0x40) {
      const r = readVarint(bytes, i + 1);
      if (r.value > 0 && r.value <= 100000) total = r.value / 100;
    }
  }
  return Math.round(total - used);
}

// ========== GetPlanStatusResponse Parser ==========
//
// GetPlanStatusResponse { f1: PlanStatus }
// PlanStatus { f1: PlanInfo, f2: plan_start, f3: plan_end,
//   f4: available_flex_credits, f5: used_flow_credits,
//   f6: used_prompt_credits(int32/100), f7: used_flex_credits,
//   f8: available_prompt_credits(int32/100), f9: available_flow_credits,
//   f10: TopUpStatus, f11: was_reduced_by_orphaned, f12: grace_period_status, f13: grace_period_end }
// PlanInfo { f1: teams_tier, f2: plan_name(str), f6: max_num_premium_chat_messages(int64),
//   f12: monthly_prompt_credits, f13: monthly_flow_credits, f14: monthly_flex_credit_purchase_amount,
//   f16: is_enterprise, f17: is_teams, f18: can_buy_more_credits, f32: has_paid_features }
// TopUpStatus { f1: transaction_status, f2: top_up_enabled, f3: monthly_top_up_amount,
//   f4: top_up_spent, f5: top_up_increment, f6: top_up_criteria_met }

/**
 * Structure-aware usage info parser based on reverse-engineered Windsurf protobuf.
 * Returns: { mode, credits, plan, maxPremiumMessages, monthlyCredits, topUp, ... }
 */
export function parseUsageInfo(buf) {
  const result = {
    mode: 'unknown',
    credits: null,              // remaining prompt credits (available - used)
    plan: null,                 // plan_name string ("Free", "Pro", etc.)
    maxPremiumMessages: null,   // max_num_premium_chat_messages (daily limit for premium models)
    monthlyPromptCredits: null, // monthly_prompt_credits allocation
    monthlyFlowCredits: null,   // monthly_flow_credits allocation
    availablePromptCredits: null,
    usedPromptCredits: null,
    availableFlowCredits: null,
    usedFlowCredits: null,
    availableFlexCredits: null,
    usedFlexCredits: null,
    canBuyMore: null,
    isTeams: null,
    isEnterprise: null,
    hasPaidFeatures: null,
    topUp: null,                // { enabled, spent, increment, monthlyAmount }
    planStart: null,
    planEnd: null,
    gracePeriodStatus: null,
    daily: null,                // { used, total, remaining } if detectable
    weekly: null,
    resetTime: null,
    weeklyReset: null,
    extraBalance: null,
  };

  try {
    // Level 0: GetPlanStatusResponse → field 1 = PlanStatus (nested message)
    const outer = parseProtoMsg(buf);
    const planStatusEntry = outer[1]?.[0];
    if (!planStatusEntry?.bytes) {
      // Fallback: flat scan (legacy)
      result.credits = parseCredits(buf);
      if (result.credits !== null) result.mode = 'credits';
      return result;
    }

    // Level 1: PlanStatus fields
    const ps = parseProtoMsg(planStatusEntry.bytes);
    result.usedPromptCredits = ps[6]?.[0]?.value;
    result.availablePromptCredits = ps[8]?.[0]?.value;
    result.usedFlowCredits = ps[5]?.[0]?.value;
    result.availableFlowCredits = ps[9]?.[0]?.value;
    result.availableFlexCredits = ps[4]?.[0]?.value;
    result.usedFlexCredits = ps[7]?.[0]?.value;
    result.gracePeriodStatus = ps[12]?.[0]?.value;

    // Credits calculation (values stored as credits*100)
    const avail = result.availablePromptCredits;
    const used = result.usedPromptCredits;
    if (avail !== undefined && avail !== null) {
      const usedVal = used || 0;
      result.credits = Math.round(avail / 100 - usedVal / 100);
      result.mode = 'credits';
    }

    // Level 2: PlanInfo (PlanStatus field 1)
    const planInfoEntry = ps[1]?.[0];
    if (planInfoEntry?.bytes) {
      const pi = parseProtoMsg(planInfoEntry.bytes);
      result.plan = pi[2]?.[0]?.string || null;
      result.maxPremiumMessages = pi[6]?.[0]?.value || null;
      result.monthlyPromptCredits = pi[12]?.[0]?.value || null;
      result.monthlyFlowCredits = pi[13]?.[0]?.value || null;
      result.canBuyMore = pi[18]?.[0]?.value === 1;
      result.isTeams = pi[17]?.[0]?.value === 1;
      result.isEnterprise = pi[16]?.[0]?.value === 1;
      result.hasPaidFeatures = pi[32]?.[0]?.value === 1;
      result.isDevin = pi[36]?.[0]?.value === 1;  // v1.108.2: isDevin flag

      // Parse billing_strategy (field 35) — CREDITS=1, QUOTA=2, ACU=3
      const bs = pi[35]?.[0]?.value;
      result.billingStrategy = bs === 1 ? 'credits' : bs === 2 ? 'quota' : bs === 3 ? 'acu' : null;

      // Log plan info for debugging quota detection
      console.log(`WAM: [PLAN] name=${result.plan} billing=${result.billingStrategy} maxPremium=${result.maxPremiumMessages} monthly=${result.monthlyPromptCredits} credits=${result.credits} canBuy=${result.canBuyMore} isDevin=${result.isDevin}`);
    }

    // Level 2: TopUpStatus (PlanStatus field 10)
    const topUpEntry = ps[10]?.[0];
    if (topUpEntry?.bytes) {
      const tu = parseProtoMsg(topUpEntry.bytes);
      result.topUp = {
        enabled: tu[2]?.[0]?.value === 1,
        monthlyAmount: tu[3]?.[0]?.value || 0,
        spent: tu[4]?.[0]?.value || 0,
        increment: tu[5]?.[0]?.value || 0,
        criteriaMet: tu[6]?.[0]?.value === 1,
      };
    }

    // Timestamps (PlanStatus field 2=plan_start, field 3=plan_end, field 13=grace_end)
    // These are Timestamp messages with field 1=seconds, field 2=nanos
    for (const [field, key] of [[2, 'planStart'], [3, 'planEnd'], [13, 'gracePeriodEnd']]) {
      const tsEntry = ps[field]?.[0];
      if (tsEntry?.bytes) {
        const ts = parseProtoMsg(tsEntry.bytes);
        if (ts[1]?.[0]?.value) result[key] = ts[1][0].value * 1000; // seconds → ms
      }
    }

    // v7.4: Log plan dates for UFEF debugging
    if (result.planStart || result.planEnd) {
      console.log(`WAM: [PLAN_DATES] start=${result.planStart ? new Date(result.planStart).toLocaleDateString() : 'n/a'} end=${result.planEnd ? new Date(result.planEnd).toLocaleDateString() : 'n/a'} grace=${result.gracePeriodEnd ? new Date(result.gracePeriodEnd).toLocaleDateString() : 'n/a'} daysRemaining=${result.planEnd ? Math.ceil((result.planEnd - Date.now()) / 86400000) : '?'}`);
    }

    // ═══ QUOTA fields (PlanStatus f14-f18, added 2026-03-18 pricing reform) ═══
    // These are the REAL gate under billingStrategy=QUOTA — daily+weekly % limits
    const dailyPct = ps[14]?.[0]?.value;    // daily_quota_remaining_percent (0-100)
    const weeklyPct = ps[15]?.[0]?.value;   // weekly_quota_remaining_percent (0-100)
    const overageMicros = ps[16]?.[0]?.value; // overage_balance_micros (int64, USD÷1M)
    const dailyResetUnix = ps[17]?.[0]?.value;  // daily_quota_reset_at_unix
    const weeklyResetUnix = ps[18]?.[0]?.value; // weekly_quota_reset_at_unix

    if (dailyPct !== undefined && dailyPct !== null) {
      result.daily = {
        used: Math.max(0, Math.min(100, 100 - dailyPct)),
        total: 100,
        remaining: dailyPct,
      };
    }
    if (weeklyPct !== undefined && weeklyPct !== null) {
      result.weekly = {
        used: Math.max(0, Math.min(100, 100 - weeklyPct)),
        total: 100,
        remaining: weeklyPct,
      };
    }
    if (dailyResetUnix) result.resetTime = dailyResetUnix * 1000;
    if (weeklyResetUnix) result.weeklyReset = weeklyResetUnix * 1000;
    if (overageMicros !== undefined) result.extraBalance = overageMicros / 1000000; // → USD

    // ═══ Mode detection (billing_strategy > heuristic) ═══
    if (result.billingStrategy === 'quota' || result.billingStrategy === 'acu') {
      result.mode = 'quota';
    } else if (result.billingStrategy === 'credits') {
      result.mode = 'credits';
    } else if (result.daily && result.daily.remaining !== null) {
      // Fallback: if daily quota fields present, it's quota mode
      result.mode = 'quota';
    } else if (result.maxPremiumMessages && result.maxPremiumMessages > 0) {
      result.mode = result.credits !== null ? 'credits' : 'quota';
    }

    console.log(`WAM: [QUOTA] mode=${result.mode} daily=${dailyPct}% weekly=${weeklyPct}% overage=$${result.extraBalance?.toFixed(2) || '0'} reset=${dailyResetUnix ? new Date(dailyResetUnix*1000).toLocaleTimeString() : 'n/a'}`);

  } catch (e) {
    console.log('WAM: [PARSE] structure parse error, falling back:', e.message);
    result.credits = parseCredits(buf);
    if (result.credits !== null) result.mode = 'credits';
  }

  return result;
}

// ========== CheckUserMessageRateLimit Encode/Decode ==========

/**
 * Encode CheckUserMessageRateLimitRequest protobuf
 * Structure (逆向自 @exa/chat-client index.js):
 *   field 1 (metadata): nested message { field 1 (api_key): string }
 *   field 3 (model_uid): string
 */
export function encodeCheckRateLimitRequest(apiKey, modelUid) {
  // Inner: metadata message with api_key as field 1
  const apiKeyBytes = Buffer.from(apiKey, 'utf8');
  const innerTag = 0x0a; // field 1, wire type 2
  const innerLen = encodeVarintBuf(apiKeyBytes.length);
  const metadataPayload = Buffer.concat([Buffer.from([innerTag]), innerLen, apiKeyBytes]);

  // Outer field 1: metadata (wire type 2 = length-delimited)
  const outerTag1 = 0x0a; // field 1, wire type 2
  const outerLen1 = encodeVarintBuf(metadataPayload.length);

  // Outer field 3: model_uid (wire type 2 = length-delimited)
  const modelBytes = Buffer.from(modelUid, 'utf8');
  const outerTag3 = 0x1a; // field 3, wire type 2 = (3 << 3) | 2
  const outerLen3 = encodeVarintBuf(modelBytes.length);

  return Buffer.concat([
    Buffer.from([outerTag1]), outerLen1, metadataPayload,
    Buffer.from([outerTag3]), outerLen3, modelBytes,
  ]);
}

/**
 * Parse CheckUserMessageRateLimitResponse protobuf
 * Fields (逆向自 @exa/chat-client):
 *   field 1: has_capacity (bool, T:8)
 *   field 2: message (string, T:9)
 *   field 3: messages_remaining (int32, T:5)
 *   field 4: max_messages (int32, T:5)
 *   field 5: resets_in_seconds (int64, T:3)
 */
export function parseCheckRateLimitResponse(buf) {
  const result = {
    hasCapacity: true,
    message: '',
    messagesRemaining: -1,
    maxMessages: -1,
    resetsInSeconds: 0,
  };
  try {
    const fields = parseProtoMsg(buf);
    // field 1: has_capacity (bool as varint — 0=false, 1=true)
    if (fields[1]?.[0]?.value !== undefined) {
      result.hasCapacity = fields[1][0].value !== 0;
    }
    // field 2: message (string)
    if (fields[2]?.[0]?.string) {
      result.message = fields[2][0].string;
    } else if (fields[2]?.[0]?.bytes) {
      try { result.message = Buffer.from(fields[2][0].bytes).toString('utf8'); } catch {}
    }
    // field 3: messages_remaining (int32)
    if (fields[3]?.[0]?.value !== undefined) {
      result.messagesRemaining = fields[3][0].value;
    }
    // field 4: max_messages (int32)
    if (fields[4]?.[0]?.value !== undefined) {
      result.maxMessages = fields[4][0].value;
    }
    // field 5: resets_in_seconds (int64 — may be varint or fixed64)
    if (fields[5]?.[0]?.value !== undefined) {
      result.resetsInSeconds = fields[5][0].value;
    } else if (fields[5]?.[0]?.bytes) {
      // Fixed64 encoding — read as little-endian uint64
      const b = fields[5][0].bytes;
      if (b.length >= 8) {
        result.resetsInSeconds = b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24);
      }
    }
  } catch (e) {
    console.log('WAM: _parseCheckRateLimitResponse error:', e.message);
  }
  return result;
}
