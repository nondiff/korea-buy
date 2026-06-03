export default {
  async fetch(request, env) {
    // 設置 CORS 標頭，允許前端網域跨網域存取
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*", // 部署後您可以改為您的 github.io 網址以提升安全性
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // 處理瀏覽器的 OPTIONS 預檢請求
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 只允許 POST 請求
    if (request.method !== "POST") {
      return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // 從 Cloudflare Worker 的環境變數中讀取 Token 與 Database ID
    const token = env.NOTION_TOKEN;
    const databaseId = env.DATABASE_ID;

    if (!token || !databaseId) {
      return new Response(
        JSON.stringify({ error: "Worker 尚未設定環境變數 NOTION_TOKEN 或 DATABASE_ID。" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    try {
      // 嘗試解析 JSON 請求體
      let requestData = {};
      try {
        requestData = await request.json();
      } catch (e) {
        // 請求體非 JSON 或為空
      }

      let notionUrl;
      let method;
      let bodyPayload;

      // 如果請求包含 action: "update" 與 pageId，則進行頁面屬性修改 (PATCH)
      if (requestData.action === "update" && requestData.pageId) {
        notionUrl = `https://api.notion.com/v1/pages/${requestData.pageId}`;
        method = "PATCH";
        bodyPayload = JSON.stringify({ properties: requestData.properties });
      } else if (requestData.action === "retrieveSchema") {
        // 取得資料庫綱要 (GET)
        notionUrl = `https://api.notion.com/v1/databases/${databaseId}`;
        method = "GET";
        bodyPayload = undefined;
      } else {
        // 否則預設為查詢資料庫 (POST)
        notionUrl = `https://api.notion.com/v1/databases/${databaseId}/query`;
        method = "POST";
        bodyPayload = requestData.query ? JSON.stringify(requestData.query) : undefined;
      }

      // 呼叫 Notion 官方 API
      const fetchHeaders = {
        "Authorization": `Bearer ${token}`,
        "Notion-Version": "2022-06-28"
      };

      if (method !== "GET") {
        fetchHeaders["Content-Type"] = "application/json";
      }

      const fetchOptions = {
        method: method,
        headers: fetchHeaders
      };

      if (method !== "GET" && bodyPayload !== undefined) {
        fetchOptions.body = bodyPayload;
      }

      const response = await fetch(notionUrl, fetchOptions);

      const data = await response.json();

      return new Response(JSON.stringify(data), {
        status: response.status,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    } catch (error) {
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json"
        }
      });
    }
  }
};
