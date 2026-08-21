// survey.html 的数据读写（通过 fetch 调用后端 REST API）
// 不再需要 CloudBase SDK，不再需要匿名登录，直接 fetch 同源 API。
// 如果页面从文件系统打开（非 http），自动回落到 localStorage。

window.CLOUD_CONFIG = {
  apiBase: "", // 空 = 同源
};

window.surveyCloud = {
  // 从 http(s) 服务器加载时启用，file:// 协议时回落 localStorage
  enabled: function () {
    return typeof location !== "undefined" && location.protocol.indexOf("http") === 0;
  },
  load: async function (actId) {
    var base = window.CLOUD_CONFIG.apiBase || "";
    var res = await fetch(base + "/api/survey/" + encodeURIComponent(actId));
    return await res.json();
  },
  submit: async function (actId, record) {
    var base = window.CLOUD_CONFIG.apiBase || "";
    var res = await fetch(base + "/api/survey/" + encodeURIComponent(actId), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ record: record }),
    });
    return await res.json();
  },
};
