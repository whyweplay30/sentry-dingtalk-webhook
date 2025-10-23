import axios from "axios";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body || {};
    const event = body?.data?.event || {};
    const title = event.title || "未知错误";
    const project = event.project || "未识别项目";
    const url = event.web_url || "无";
    const env = event.environment || "unknown";

    // 钉钉Webhook地址（安全起见，建议用环境变量）
    const DINGTALK_WEBHOOK =
      process.env.DINGTALK_WEBHOOK ||
      "https://oapi.dingtalk.com/robot/send?access_token=2891d3d72cb6404489fe284eed31849ade97500936f7005625b074b9d809d7fa";
    // 转发到钉钉
    await axios.post(DINGTALK_WEBHOOK, {
      msgtype: "text",
      text: {
        content: `🚨 Sentry错误告警\n项目: ${project}\n环境: ${env}\n标题: ${title}\n详情: ${url}`,
      },
    });

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Webhook转发失败：", error.message);
    res.status(500).json({ error: "转发失败" });
  }
}
