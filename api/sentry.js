import axios from "axios";

// 去重窗口，默认 10 分钟（可通过环境变量覆盖，单位毫秒）
const DEDUPE_WINDOW_MS = Number(process.env.DEDUPE_WINDOW_MS) || 10 * 60 * 1000;

// 仅使用内存缓存（部署在 Vercel 时跨实例不可用，但满足短期去重需求）
// 缓存条目结构：{ ts: number, status: 'sending' | 'sent', timeoutId?: Timeout }
const inMemoryCache = {};

// 发送标记的最大等待时间（ms），超过后自动清除 sending 标记以避免长期占用
const SENDING_TIMEOUT_MS = Number(process.env.SENDING_TIMEOUT_MS) || 30 * 1000; // 默认 30 秒

function isDuplicate(key) {
  const now = Date.now();
  const entry = inMemoryCache[key];
  if (!entry) return false;
  // 如果正在发送中，认为是重复请求，直接合并
  if (entry.status === "sending") return true;
  // 如果已发送且在去重窗口内，也认为重复
  if (now - entry.ts < DEDUPE_WINDOW_MS) return true;

  // 已超出去重窗口：清理该条目并返回非重复
  // 清理同时清除可能存在的 timeout
  if (entry.timeoutId) {
    try {
      clearTimeout(entry.timeoutId);
    } catch (e) {}
  }
  delete inMemoryCache[key];
  return false;
}

function markSending(key) {
  // 在赴异步网络请求前立即标记为 sending（同步操作，减少竞态）
  // 如果已有旧条目，先清理旧的 timeout
  const old = inMemoryCache[key];
  if (old && old.timeoutId) {
    try {
      clearTimeout(old.timeoutId);
    } catch (e) {}
  }
  // 设置 sending 状态并安排一个超时，超时后清除该 sending 标记
  const timeoutId = setTimeout(() => {
    const e = inMemoryCache[key];
    if (e && e.status === "sending") {
      delete inMemoryCache[key];
    }
  }, SENDING_TIMEOUT_MS);
  inMemoryCache[key] = { ts: Date.now(), status: "sending", timeoutId };
}

function markSent(key) {
  // 发送成功：清除任何旧 timeout 并安排在去重窗口后自动删除这一条目
  const old = inMemoryCache[key];
  if (old && old.timeoutId) {
    try {
      clearTimeout(old.timeoutId);
    } catch (e) {}
  }
  const timeoutId = setTimeout(() => {
    // 在去重窗口过期后删除缓存条目，释放内存
    delete inMemoryCache[key];
  }, DEDUPE_WINDOW_MS);
  inMemoryCache[key] = { ts: Date.now(), status: "sent", timeoutId };
}

function clearSending(key) {
  // 如果请求失败，清除 sending 标记，允许重试
  const entry = inMemoryCache[key];
  if (entry) {
    if (entry.timeoutId) {
      try {
        clearTimeout(entry.timeoutId);
      } catch (e) {}
    }
    // 仅清除当仍为 sending，避免覆盖已标记为 sent
    if (entry.status === "sending") {
      delete inMemoryCache[key];
    }
  }
}

const formatTimeStamp = (timestamp) => {
  if (!timestamp) {
    return "未知时间";
  }
  // 将时间戳转换为UTC+8时区（中国标准时间）
  const date = new Date(timestamp * 1000);

  // 获取UTC时间并加上8小时（UTC+8）
  const utcHours = date.getUTCHours();
  const beijingHours = (utcHours + 8) % 24;

  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(beijingHours).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");

  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
};

const transformTimestamp = (timestamp) => {
  let utcTime = "";
  if (typeof timestamp === "number") {
    utcTime = timestamp;
  } else {
    utcTime = new Date(timestamp).getTime() / 1000;
  }
  return formatTimeStamp(utcTime);
};

// 处理data里面的内容
const handleBody = (body) => {
  const targetKey = Object.keys(body?.data || {})[0];
  return body?.data?.[targetKey] || {};
};

const handleCreatedError = (body) => {
  const event = handleBody(body);
  const title = event.title || "未知错误";
  const url = event.web_url || "无详情链接";
  const time = transformTimestamp(
    event.firstSeen || event.lastSeen || event.timestamp
  );
  const projectName = event?.url?.match(/\/projects\/[^\/]+\/([^\/]+)\//)?.[1];
  const project = event?.project?.name || projectName || "未识别项目";
  return {
    title,
    url,
    time,
    project,
  };
};

const handleTriggerError = (body) => {
  const event = handleBody(body);
  const title = event.title || "未知错误";
  const url = event.web_url || "无详情链接";
  const time = formatTimeStamp(event.timestamp);
  const projectName = event?.url?.match(/\/projects\/[^\/]+\/([^\/]+)\//)?.[1];
  const project = projectName || "未识别项目";
  return {
    title,
    url,
    time,
    project,
  };
};

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // 仅记录请求体，避免将包含敏感 access_token 的查询参数写入日志
    console.log("sentry发出的数据:", JSON.stringify(req.body));
    const body = req.body || {};
    let formatedResult = null;
    if (body.action === "created") {
      formatedResult = handleCreatedError(body);
    } else if (body.action === "triggered") {
      formatedResult = handleTriggerError(body);
    } else {
      // throw new Error("未知事件类型");
      return;
    }
    const { title, url, time, project } = formatedResult;

    // 计算去重 Key：优先使用 issue_id（若存在），否则使用 project+title
    const rawEvent = handleBody(body) || {};
    const issueId = rawEvent.issue_id || rawEvent.id;
    const dedupeKey = issueId;

    if (isDuplicate(dedupeKey)) {
      console.log(
        `去重：${dedupeKey} 在 ${DEDUPE_WINDOW_MS}ms 窗口内已发送，跳过发送.`
      );
      return res.status(200).json({
        ok: true,
        deduped: true,
        message: "重复告警已合并，未再次发送钉钉",
      });
    }
    // 标记为发送中（内存缓存），在发送前同步设置以减少竞态
    markSending(dedupeKey);

    // 支持通过请求 query 参数动态指定钉钉 webhook（例如 ?dingApi=<url>），优先使用该参数，其次是环境变量
    // 安全注意：不要在公开日志中打印该参数或包含 access_token 的完整 URL
    const dingParamFromQuery = (req.query && req.query.dingApi) || null;

    // fallback: 如果没有 req.query（某些环境），尝试从 req.url 中解析
    let dingParamFromUrl = null;
    try {
      const raw = req.url || "";
      const q = raw.split("?")[1] || "";
      const params = new URLSearchParams(q);
      dingParamFromUrl = params.get("dingApi");
    } catch (e) {
      dingParamFromUrl = null;
    }

    const dynamicDing = dingParamFromQuery || dingParamFromUrl;
    const DINGTALK_WEBHOOK = decodeURIComponent(dynamicDing);

    // 检查Webhook地址是否有效
    if (!DINGTALK_WEBHOOK || !DINGTALK_WEBHOOK.includes("access_token")) {
      throw new Error("钉钉Webhook地址无效");
    }

    console.log(DINGTALK_WEBHOOK)

    // 钉钉消息内容（必须包含自定义关键词，如"警告"）
    const messageContent = `🚨 Sentry错误告警\n项目: ${project}\n标题: ${title}\n详情: ${url}\n时间: ${time}`;

    // 确保消息包含关键词（根据你的机器人设置调整）
    const keyword = "警告"; // 替换为你的机器人实际设置的关键词
    const finalContent = messageContent.includes(keyword)
      ? messageContent
      : `${keyword} ${messageContent}`;
  
    // 转发到钉钉（添加必要的请求头）
    const response = await axios.post(
      DINGTALK_WEBHOOK,
      {
        msgtype: "text",
        text: {
          content: finalContent,
        },
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
        timeout: 10000, // 10秒超时
      }
    );

    // 检查钉钉API响应
    if (response.data.errcode !== 0) {
      // 发送失败，清除 sending 标记，允许重试
      clearSending(dedupeKey);
      throw new Error(`钉钉API错误: ${response.data.errmsg}`);
    }

    // 发送成功，标记为已发送（用于去重窗口）
    markSent(dedupeKey);

    res.status(200).json({ ok: true, message: "消息发送成功" });
  } catch (error) {
    // 如果存在 sending 标记且发生了错误，清除以允许后续重试
    try {
      const rawEventFail = handleBody(req.body || {}) || {};
      const issueIdFail =
        rawEventFail.issue_id ||
        rawEventFail.id ||
        rawEventFail.issue?.id ||
        rawEventFail.event_id;
      const dedupeKeyFail = issueIdFail
        ? `${
            (req.body && (req.body.project || "")) || "unknown"
          }:${issueIdFail}`
        : undefined;
      if (dedupeKeyFail) clearSending(dedupeKeyFail);
    } catch (e) {
      // ignore
    }
    console.error("错误详情:", error.response?.data || error);
    res.status(500).json({
      error: "转发失败",
      details: error.message,
      dingtalkResponse: error.response?.data,
    });
  }
}
