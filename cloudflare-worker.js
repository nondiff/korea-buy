export default {
  async fetch(request, env) {
    // 設置 CORS 標頭，允許前端網域跨網域存取
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*", // 部署後您可以改為您的 github.io 網址以提升安全性
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    // 處理瀏覽器的 OPTIONS 預檢請求
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // 處理圖片的 GET 請求：從 R2 讀取並回傳
    if (request.method === "GET" && url.pathname.startsWith("/images/")) {
      const filename = url.pathname.substring(8); // 去除 "/images/"
      if (!env.MY_BUCKET) {
        return new Response("R2 儲存桶 'MY_BUCKET' 未綁定，請在 Cloudflare 控制台進行設定。", {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "text/plain" }
        });
      }
      try {
        const object = await env.MY_BUCKET.get(filename);
        if (object === null) {
          return new Response("Image Not Found", {
            status: 404,
            headers: { ...corsHeaders, "Content-Type": "text/plain" }
          });
        }
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        headers.set("Access-Control-Allow-Origin", "*");
        headers.set("Cache-Control", "public, max-age=31536000"); // 瀏覽器與 Notion 快取 1 年
        return new Response(object.body, {
          headers
        });
      } catch (err) {
        return new Response(`讀取圖片出錯: ${err.message || String(err)}`, {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "text/plain" }
        });
      }
    }

    // 只允許 POST 請求（GET 只有 /images/ 開頭會被放行）
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

      let imageUrl = null;
      let uploadErrorMessage = "";

      // 如果有上傳圖片檔案 (Base64)
      if (requestData.imageFile) {
        try {
          const base64String = requestData.imageFile;

          // 1. 優先嘗試上傳至 GitHub (100% 免費且穩定，直接 commits 到您的儲存庫)
          if (env.GITHUB_TOKEN) {
            try {
              const owner = env.GITHUB_OWNER || "nondiff";
              const repo = env.GITHUB_REPO || "korea-buy";
              const branch = env.GITHUB_BRANCH || "main";
              
              const cleanBase64 = base64String.replace(/^data:image\/\w+;base64,/, "");
              const base64Parts = base64String.split(',');
              if (base64Parts.length < 2) {
                throw new Error("Base64 資料格式不正確");
              }
              const mimeType = base64Parts[0].match(/:(.*?);/)[1];
              const fileExtension = mimeType.split('/')[1] || "jpg";
              const filename = `image-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.${fileExtension}`;

              const githubUrl = `https://api.github.com/repos/${owner}/${repo}/contents/images/${filename}`;
              const githubResponse = await fetch(githubUrl, {
                method: "PUT",
                headers: {
                  "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
                  "Content-Type": "application/json",
                  "User-Agent": "Cloudflare-Worker-Korea-Buy"
                },
                body: JSON.stringify({
                  message: `Upload product image ${filename} from mobile buy log`,
                  content: cleanBase64,
                  branch: branch
                })
              });

              if (githubResponse.ok) {
                imageUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/images/${filename}`;
              } else {
                const errData = await githubResponse.json().catch(() => ({}));
                uploadErrorMessage += `GitHub 上傳失敗 (HTTP ${githubResponse.status}): ${errData.message || "未知 GitHub 錯誤"}。`;
              }
            } catch (gitErr) {
              uploadErrorMessage += `GitHub 上傳過程出錯: ${gitErr.message || String(gitErr)}。`;
            }
          } else {
            uploadErrorMessage += "未設定環境變數 GITHUB_TOKEN。";
          }

          // 2. 備用嘗試上傳至 Cloudflare R2
          if (!imageUrl) {
            if (env.MY_BUCKET) {
              try {
                const base64Parts = base64String.split(',');
                if (base64Parts.length < 2) {
                  throw new Error("Base64 資料格式不正確");
                }
                const mimeType = base64Parts[0].match(/:(.*?);/)[1];
                const base64Data = base64Parts[1];
                
                // 解碼 Base64 為 Binary Uint8Array
                const byteCharacters = atob(base64Data);
                const byteNumbers = new Array(byteCharacters.length);
                for (let i = 0; i < byteCharacters.length; i++) {
                  byteNumbers[i] = byteCharacters.charCodeAt(i);
                }
                const byteArray = new Uint8Array(byteNumbers);

                // 產生隨機且唯一的檔名
                const fileExtension = mimeType.split('/')[1] || "jpg";
                const filename = `image-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.${fileExtension}`;

                // 上傳至 Cloudflare R2
                await env.MY_BUCKET.put(filename, byteArray, {
                  httpMetadata: { contentType: mimeType }
                });

                // 取得目前的 Worker 網域作為公開存取連結
                const workerOrigin = url.origin;
                imageUrl = `${workerOrigin}/images/${filename}`;
              } catch (r2Err) {
                uploadErrorMessage += ` Cloudflare R2 上傳失敗: ${r2Err.message || String(r2Err)}。`;
              }
            } else {
              uploadErrorMessage += " 未設定 R2 儲存桶 MY_BUCKET。";
            }
          }

          // 3. 備用使用 ImgBB
          if (!imageUrl) {
            if (env.IMGBB_API_KEY) {
              try {
                const cleanBase64 = base64String.replace(/^data:image\/\w+;base64,/, "");
                const formData = new FormData();
                formData.append("image", cleanBase64);

                const imgbbResponse = await fetch(`https://api.imgbb.com/1/upload?key=${env.IMGBB_API_KEY}`, {
                  method: "POST",
                  body: formData
                });

                if (imgbbResponse.ok) {
                  const imgbbData = await imgbbResponse.json();
                  imageUrl = imgbbData.data?.url;
                  if (!imageUrl) {
                    uploadErrorMessage += " ImgBB 上傳成功但未回傳圖片網址。";
                  }
                } else {
                  const errText = await imgbbResponse.text();
                  uploadErrorMessage += ` ImgBB 上傳失敗 (HTTP ${imgbbResponse.status}): ${errText.substring(0, 150)}。`;
                }
              } catch (imgbbErr) {
                uploadErrorMessage += ` ImgBB 上傳過程出錯: ${imgbbErr.message || String(imgbbErr)}。`;
              }
            } else {
              uploadErrorMessage += " 未設定環境變數 IMGBB_API_KEY。";
            }
          }

          // 4. 最後備份上傳到 Catbox
          if (!imageUrl) {
            try {
              const base64Parts = base64String.split(',');
              if (base64Parts.length < 2) {
                throw new Error("Base64 資料格式不正確");
              }
              const mimeType = base64Parts[0].match(/:(.*?);/)[1];
              const base64Data = base64Parts[1];
              
              // 解碼 Base64 為 Binary Uint8Array
              const byteCharacters = atob(base64Data);
              const byteNumbers = new Array(byteCharacters.length);
              for (let i = 0; i < byteCharacters.length; i++) {
                byteNumbers[i] = byteCharacters.charCodeAt(i);
              }
              const byteArray = new Uint8Array(byteNumbers);
              const fileBlob = new Blob([byteArray], { type: mimeType });

              const formData = new FormData();
              formData.append("reqtype", "fileupload");
              formData.append("fileToUpload", fileBlob, "upload.jpg");

              const catboxResponse = await fetch("https://catbox.moe/user/api.php", {
                method: "POST",
                body: formData
              });
              
              if (catboxResponse.ok) {
                const responseText = await catboxResponse.text();
                const trimmedResponse = responseText.trim();
                if (trimmedResponse.startsWith("http")) {
                  imageUrl = trimmedResponse;
                } else {
                  uploadErrorMessage += ` Catbox 備用上傳未回傳網址: ${trimmedResponse.substring(0, 150)}。`;
                }
              } else {
                const errText = await catboxResponse.text();
                uploadErrorMessage += ` Catbox 備用上傳失敗 (HTTP ${catboxResponse.status}): ${errText.substring(0, 150)}。`;
              }
            } catch (catboxErr) {
              uploadErrorMessage += ` Catbox 備用上傳過程出錯: ${catboxErr.message || String(catboxErr)}。`;
            }
          }
        } catch (uploadErr) {
          console.error("圖片上傳失敗:", uploadErr);
          uploadErrorMessage += ` 圖片處理/上傳過程發生例外錯誤: ${uploadErr.message || String(uploadErr)}。`;
        }
      }

      // 如果成功取得圖片網址，將其寫入 properties 的 Image 欄位
      if (imageUrl && imageUrl.startsWith("http") && requestData.properties) {
        requestData.properties["Image"] = {
          "files": [
            {
              "name": "手機上傳圖片.jpg",
              "type": "external",
              "external": {
                "url": imageUrl
              }
            }
          ]
        };
      }

      // 如果請求包含 action: "update" 與 pageId，則進行頁面屬性修改 (PATCH)
      if (requestData.action === "update" && requestData.pageId) {
        notionUrl = `https://api.notion.com/v1/pages/${requestData.pageId}`;
        method = "PATCH";
        bodyPayload = JSON.stringify({ properties: requestData.properties });
      } else if (requestData.action === "createPage") {
        // 新增資料庫頁面 (POST)
        notionUrl = `https://api.notion.com/v1/pages`;
        method = "POST";
        bodyPayload = JSON.stringify({
          parent: { database_id: databaseId },
          properties: requestData.properties
        });
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

      // 如果有嘗試上傳圖片，將結果或錯誤附加到回應中，方便前端診斷
      if (requestData.imageFile && data && typeof data === "object") {
        data.imageUrl = imageUrl;
        if (!imageUrl) {
          data.imageUploadError = uploadErrorMessage || "圖片上傳失敗，且無詳細錯誤訊息";
        }
      }

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
