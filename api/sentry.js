import axios from "axios";
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
  const utcTime = new Date(timestamp);
  return formatTimeStamp(utcTime.getTime() / 1000);
};

const handleCreatedError = (body) => {
  const event = body?.data?.issue || {};
  const title = event.title || "未知错误";
  const url = event.web_url || "无详情链接";
  const time = transformTimestamp(event.firstSeen || event.lastSeen);
  const project = event?.project?.name || "未识别项目";
  return {
    title,
    url,
    time,
    project,
  };
};

const handleTriggerError = (body) => {
  const event = body?.data?.event || {};
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
    const body = req.body || {};
    let formatedResult = null;
    if (body.action === "created") {
      formatedResult = handleCreatedError(body);
    } else if (body.action === "triggered") {
      formatedResult = handleTriggerError(body);
    } else {
      console.log(body);
      throw new Error("未知事件类型");
    }
    const { title, url, time, project } = formatedResult;

    // 钉钉Webhook地址（安全起见，建议用环境变量）
    const DINGTALK_WEBHOOK =
      process.env.DINGTALK_WEBHOOK ||
      "https://oapi.dingtalk.com/robot/send?access_token=2891d3d72cb6404489fe284eed31849ade97500936f7005625b074b9d809d7fa";

    // 检查Webhook地址是否有效
    if (!DINGTALK_WEBHOOK || !DINGTALK_WEBHOOK.includes("access_token")) {
      throw new Error("钉钉Webhook地址无效");
    }

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
      throw new Error(`钉钉API错误: ${response.data.errmsg}`);
    }

    res.status(200).json({ ok: true, message: "消息发送成功" });
  } catch (error) {
    console.error("Webhook转发失败：", error.message);
    console.error("错误详情:", error.response?.data || error);

    res.status(500).json({
      error: "转发失败",
      details: error.message,
      dingtalkResponse: error.response?.data,
    });
  }
}
