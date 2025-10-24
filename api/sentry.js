import axios from "axios";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const formatTimeStamp = (timestamp) => {
    if (!timestamp) {
      return "未知时间";
    }
    const date = new Date(timestamp * 1000);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
  };

  try {
    const body = req.body || {};
    const event = body?.data?.event || {};
    const title = event.title || "未知错误";
    const project = event.project || "未识别项目";
    const url = event.web_url || event.url;
    const env = event.environment || "unknown";
    const time = formatTimeStamp(event.timestamp);
    console.log(event, "event");
    console.log(event.metadata, "metadata");
    console.log(event.modules, "modules");
    console.log(event.user, "user");
    console.log(event.exception, "exception");
    console.log(event.contexts, "contexts");
    console.log(event.extra, "extra");
    // 钉钉Webhook地址（安全起见，建议用环境变量）
    const DINGTALK_WEBHOOK =
      process.env.DINGTALK_WEBHOOK ||
      "https://oapi.dingtalk.com/robot/send?access_token=2891d3d72cb6404489fe284eed31849ade97500936f7005625b074b9d809d7fa";

    // 检查Webhook地址是否有效
    if (!DINGTALK_WEBHOOK || !DINGTALK_WEBHOOK.includes("access_token")) {
      throw new Error("钉钉Webhook地址无效");
    }

    // 钉钉消息内容（必须包含自定义关键词，如"警告"）
    const messageContent = `🚨 Sentry错误告警\n项目: ${project}\n环境: ${env}\n标题: ${title}\n详情: ${url}\n时间: ${time}`;

    // 确保消息包含关键词（根据你的机器人设置调整）
    const keyword = "警告"; // 替换为你的机器人实际设置的关键词
    const finalContent = messageContent.includes(keyword)
      ? messageContent
      : `${keyword} ${messageContent}`;

    console.log("准备发送钉钉消息:", finalContent);

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

    console.log("钉钉响应状态:", response.status);
    console.log("钉钉响应数据:", response.data);

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
