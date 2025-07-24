// ========================================================================
// app.js (PWA 完整重构版)
// ========================================================================

// ========================================================================
// 1. 全局函数与模块
// 这些代码在脚本加载时立即执行，不依赖DOM
// ========================================================================

// IndexedDB 键值对存储模块 (修正版，确保连接关闭)
const db = (() => {
    const DB_NAME = 'EfficienTodoDB';
    const DB_VERSION = 3; 
    const STORE_NAME = 'data';

    // 不再持有全局的 dbInstance promise
    function getDB() {
        return new Promise((resolve, reject) => {
            const openreq = indexedDB.open(DB_NAME, DB_VERSION);
            openreq.onerror = (event) => reject(event.target.error || 'IndexedDB open error');
            openreq.onsuccess = (event) => resolve(event.target.result);
            openreq.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    db.createObjectStore(STORE_NAME);
                }
            };
        });
    }



    function promisifyRequest(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = (event) => reject(event.target.error || 'IndexedDB request error');
        });
    }

    // withStore 保持不变
    async function withStore(type, callback) {
        const db = await getDB(); // 每次操作都重新获取DB连接
        const tx = db.transaction(STORE_NAME, type);
        const store = tx.objectStore(STORE_NAME);
        
        let res;
        try {
            res = await callback(store);
        } catch (error) {
            console.error("Error in withStore callback:", error);
            try { tx.abort(); } catch (e) {}
            db.close(); // 确保出错时也关闭连接
            throw error;
        }

        return new Promise((resolve, reject) => {
            tx.oncomplete = () => {
                db.close(); // 【关键】事务完成后关闭连接
                resolve(res);
            };
            tx.onerror = (event) => {
                db.close(); // 【关键】事务错误时也关闭连接
                reject(event.target.error);
            };
            tx.onabort = (event) => {
                db.close(); // 【关键】事务中止时也关闭连接
                reject(event.target.error || new Error("Transaction aborted"));
            };
        });
    }

    return {
        get: async (key) => withStore('readonly', store => promisifyRequest(store.get(key))),
        set: async (key, value) => withStore('readwrite', store => promisifyRequest(store.put(value, key))),
    };
})();

function robustJsonParse(content) {
    try {
        return JSON.parse(content);
    } catch (jsonError) {
        console.warn("AI returned non-JSON content, attempting to extract from markdown.", content);
        const jsonMatch = content.match(/```json\n([\s\S]*?)\n```/);
        if (jsonMatch && jsonMatch[1]) {
            try {
                return JSON.parse(jsonMatch[1]);
            } catch (nestedJsonError) {
                throw new Error("AI 返回了被包裹但格式无效的JSON。");
            }
        }
        throw new Error("AI未能返回有效的JSON内容。");
    }
}

function maskApiKey(key) {
    if (!key || key.length < 20) return '****';
    const prefix = key.substring(0, 8);
    const suffix = key.substring(key.length - 6);
    return `${prefix}...${suffix}`;
}

const aiAssistant = {
    REPORT_SYSTEM_PROMPT: `
You are a professional assistant helping a user write concise and insightful work reports in Chinese. Based on the provided raw data, which includes both completed and uncompleted tasks, generate a report.

The report should follow this structure:
1.  **核心工作总结 (Core Work Summary)**:
    - ONLY summarize tasks marked with "(status: completed)".
    - List the key achievements. Use bullet points. Be concise and professional.
2.  **遇到的问题与反思 (Challenges & Reflections)**:
    - Analyze ALL tasks. If there are many tasks with "fix", "bug", "research" tags, you can mention challenges were overcome.
    - If there are uncompleted tasks that have been pending for a while (based on context), you can gently mention them as potential roadblocks.
    - If everything seems fine, just state "各项工作进展顺利 (All tasks progressed smoothly)".
3.  **下阶段工作计划 (Next Steps)**:
    - Focus on tasks marked with "(status: uncompleted)".
    - List the most important upcoming tasks.
4.  **财务简报 (Financial Briefing)**:
    - If expense data is provided, briefly summarize it.

Your tone should be professional, positive, and encouraging. Respond ONLY with the generated report content in Markdown format. Do not add any extra explanations.
`,

    SYSTEM_PROMPT: `
You are an expert task parser for a to-do list application called "高效待办清单". Your job is to take a user's natural language input and convert it into a structured JSON object. You must ONLY return the JSON object, with no other text, explanations, or markdown formatting.
The JSON object must have a "module" key and a "data" key. The "module" key must be one of "monthly", "future", "ledger", "daily", or "unknown".
The "data" object structure depends on the module:
1. If module is "monthly": {"text": (string), "tags": (array of strings), "priority": (number, 1-3)}
2. If module is "future": {"text": (string), "reminder": (string, "YYYY-MM-DDTHH:mm")}
3. If module is "ledger": {"date": (string, "YYYY-MM-DD"), "item": (string), "amount": (number), "payment": (string, optional)}
4. If module is "daily": {"text": (string), "cycle": (string, 'daily'/'once'/'mon'...'sun')}
Today is ${getTodayString()}. The current year is ${new Date().getFullYear()}.
ALWAYS return only the raw JSON.
`,

     // --- 1. Key和模型选择的管理 ---
    // 【MODIFIED】Added 'deepseek'
    getKeys: () => ({
        openai: localStorage.getItem('openai_api_key'),
        gemini: localStorage.getItem('gemini_api_key'),
        deepseek: localStorage.getItem('deepseek_api_key') 
    }),
    saveKey: (provider, key) => localStorage.setItem(`${provider}_api_key`, key),
    
    // 【MODIFIED】Default to 'deepseek' if available, otherwise 'openai'
    getSelectedModel: () => localStorage.getItem('selected_ai_model') || 'deepseek', 
    setSelectedModel: (model) => localStorage.setItem('selected_ai_model', model),

     // 【MODIFIED】Unified entry point now handles 'deepseek'
    generateAIResponse: async function(userInput, systemPrompt) {
        const selectedModel = this.getSelectedModel();
        if (selectedModel.startsWith('openai')) {
            return this.parseWithOpenAI(userInput, systemPrompt);
        } else if (selectedModel.startsWith('gemini')) {
            return this.parseWithGemini(userInput, systemPrompt);
        } else if (selectedModel.startsWith('deepseek')) { // New case for DeepSeek
            return this.parseWithDeepSeek(userInput, systemPrompt);
        } else {
            throw new Error('未选择有效的AI模型。');
        }
    },
    
    // Unchanged
    parseWithOpenAI: async function(userInput, systemPrompt) {
        const apiKey = this.getKeys().openai;
        if (!apiKey) throw new Error('OpenAI API Key 未设置。');
        
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: 'o3-mini-2025-01-31',
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userInput }
                ],
            })
        });

        if (!response.ok) throw new Error(`OpenAI Error: ${(await response.json()).error.message}`);
        const result = await response.json();
        return result.choices[0].message.content;
    },

    // Unchanged
    parseWithGemini: async function(userInput, systemPrompt) {
        const apiKey = this.getKeys().gemini;
        if (!apiKey) throw new Error('Gemini API Key 未设置。');

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`;
        const requestBody = {
            "contents": [{ "parts": [{ "text": userInput }] }],
            "systemInstruction": { "parts": [{ "text": systemPrompt }] },
            "generationConfig": {
                "temperature": systemPrompt === this.REPORT_SYSTEM_PROMPT ? 0.7 : 0.2
            }
        };

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) throw new Error(`Gemini Error: ${(await response.json()).error.message}`);
        const result = await response.json();
        return result.candidates[0].content.parts[0].text;
    },

    // 【NEW】Function to handle DeepSeek API (OpenAI compatible)
    parseWithDeepSeek: async function(userInput, systemPrompt) {
        const apiKey = this.getKeys().deepseek;
        if (!apiKey) throw new Error('DeepSeek API Key 未设置。');
        
        // Using DeepSeek's endpoint
        const response = await fetch('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: 'deepseek-chat', // Using the recommended chat model
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userInput }
                ],
            })
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`DeepSeek Error: ${errorData.error.message || `HTTP ${response.status}`}`);
        }
        const result = await response.json();
        return result.choices[0].message.content;
    }
};

// 在 popup.js 中，用这个完整的版本替换现有的 getReportData 函数

// 在 popup.js 中，用这个完整的、修复了语法错误的版本替换现有的 getReportData 函数

/**
 * 根据报告类型，准备要发送给AI的原始数据
 * @param {string} reportType - e.g., 'daily_today', 'weekly_this', 'monthly_last'
 * @returns {{title: string, data: string} | null}
 */
function getReportData(reportType) {
    const now = new Date();
    let startDate, endDate;
    let title = "";
    let isCurrentPeriod = false;

    // 1. 根据 reportType 计算日期范围
    switch (reportType) {
        case 'daily_today': { // 使用花括号创建块级作用域
            startDate = new Date(new Date().setHours(0, 0, 0, 0));
            endDate = new Date(new Date().setHours(23, 59, 59, 999));
            title = `${getTodayString()} 工作日报`;
            isCurrentPeriod = true;
            break;
        }

        case 'weekly_this': { // 使用花括号创建块级作用域
            const currentDay = now.getDay();
            const firstDayOfWeek = now.getDate() - currentDay + (currentDay === 0 ? -6 : 1);
            startDate = new Date(new Date(now).setDate(firstDayOfWeek));
            startDate.setHours(0, 0, 0, 0);
            endDate = new Date(startDate);
            endDate.setDate(startDate.getDate() + 6);
            endDate.setHours(23, 59, 59, 999);
            title = "本周工作周报";
            isCurrentPeriod = true; // 本周也是当前时段
            break;
        }

        case 'weekly_last': { // 使用花括号创建块级作用域
            const currentDay = now.getDay();
            const firstDayOfLastWeek = now.getDate() - currentDay + (currentDay === 0 ? -6 : 1) - 7;
            startDate = new Date(new Date(now).setDate(firstDayOfLastWeek));
            startDate.setHours(0, 0, 0, 0);
            endDate = new Date(startDate);
            endDate.setDate(startDate.getDate() + 6);
            endDate.setHours(23, 59, 59, 999);
            title = "上周工作周报";
            break;
        }

        case 'monthly_this': { // 使用花括号创建块级作用域
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            endDate = new Date(new Date(now.getFullYear(), now.getMonth() + 1, 0).setHours(23, 59, 59, 999));
            title = "本月工作月报";
            isCurrentPeriod = true;
            break;
        }
            
        case 'monthly_last': { // 使用花括号创建块级作用域
            startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            endDate = new Date(new Date(now.getFullYear(), now.getMonth(), 0).setHours(23, 59, 59, 999));
            title = "上月工作月报";
            break;
        }

        case 'yearly_this': { // 使用花括号创建块级作用域
            startDate = new Date(now.getFullYear(), 0, 1);
            endDate = new Date(new Date(now.getFullYear(), 11, 31).setHours(23, 59, 59, 999));
            title = `${now.getFullYear()}年年度报告`;
            isCurrentPeriod = true;
            break;
        }

        default:
            console.error("未知的报告类型:", reportType);
            return null;
    }

    // 2. 收集所有相关数据（不筛选完成状态）
    const allRelevantTasks = new Map();
    const ledgerEntries = [];

    const processTask = (task) => {
        if (!task || !task.id) return; // 确保任务和ID有效
        const relevantDateStr = task.completionDate || task.creationDate || (isCurrentPeriod ? getTodayString() : null);
        if (relevantDateStr) {
            const d = new Date(relevantDateStr);
            if (d >= startDate && d <= endDate) {
                if (!allRelevantTasks.has(task.id)) {
                    allRelevantTasks.set(task.id, task);
                }
            }
        }
    };
    
    [
        ...(allTasks.monthly || []),
        ...(Object.values(allTasks.history || {})).flat(),
        ...(allTasks.daily || [])
    ].forEach(processTask);
    
    if (isCurrentPeriod) {
        (allTasks.monthly || []).forEach(task => {
            if (!task.completed && !allRelevantTasks.has(task.id)) {
                allRelevantTasks.set(task.id, task);
            }
        });
    }

    [
        ...(allTasks.ledger || []),
        ...(Object.values(allTasks.ledgerHistory || {})).flat()
    ].forEach(entry => {
        if (entry.date) {
            const d = new Date(entry.date);
            if (d >= startDate && d <= endDate) {
                ledgerEntries.push(entry);
            }
        }
    });

    const tasks = Array.from(allRelevantTasks.values());

    // 3. 将数据格式化为纯文本，并明确标注状态
    let formattedText = `## 任务清单:\n`;
    if (tasks.length > 0) {
        tasks.forEach(t => {
            const status = t.completed ? 'completed' : 'uncompleted';
            let taskLine = `- ${t.text} (status: ${status})`;
            if (t.tags?.length > 0) {
                taskLine += ` (tags: ${t.tags.join(', ')})`;
            }
            formattedText += `${taskLine}\n`;
        });
    } else {
        formattedText += "- 本时段无相关任务。\n";
    }

}

/**
 * Generates a cryptographically secure random string for the code verifier.
 * @param {number} length The length of the string to generate.
 * @returns {string} A random string.
 */
function generateCodeVerifier(length) {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    for (let i = 0; i < length; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

/**
 * Hashes the code verifier using SHA-256 and encodes it in Base64URL format.
 * @param {string} verifier The code verifier string.
 * @returns {Promise<string>} The Base64URL-encoded code challenge.
 */
async function generateCodeChallenge(verifier) {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const digest = await window.crypto.subtle.digest('SHA-256', data);
    
    return window.btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

// ========================================================================
// 修正后的 Google Drive 同步模块
// ========================================================================

const driveSync = {
    CLIENT_ID: '325408458040-bp083eplhebaj5eoe2m9go2rdiir9l6c.apps.googleusercontent.com',
    API_KEY: 'AIzaSyAHn27YYXEIwQuLRWi1lh2A48ffmr_wKcQ',
    SCOPES: 'https://www.googleapis.com/auth/drive.file',
    DISCOVERY_DOCS: ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"],
    DRIVE_FILE_NAME: 'efficienTodoData.json',
    driveFileId: null,

    // 【重要】请确保这个URL是你自己的Cloudflare Worker地址
    PROXY_URL: 'https://google-auth-proxy.martinlinzhiwu.workers.dev',

    // 【新】授权函数：引导用户去Google授权
    authenticate: async function() {
        console.log("driveSync.authenticate: 启动授权码流程 (PKCE)。");
        const codeVerifier = generateCodeVerifier(128);
        await db.set('google_code_verifier', codeVerifier);
        const codeChallenge = await generateCodeChallenge(codeVerifier);

        const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
        authUrl.searchParams.append('client_id', driveSync.CLIENT_ID);
        authUrl.searchParams.append('redirect_uri', window.location.origin + window.location.pathname);
        authUrl.searchParams.append('response_type', 'code');
        authUrl.searchParams.append('scope', driveSync.SCOPES);
        authUrl.searchParams.append('code_challenge_method', 'S256');
        authUrl.searchParams.append('code_challenge', codeChallenge);
        authUrl.searchParams.append('access_type', 'offline'); // 请求刷新令牌
        authUrl.searchParams.append('prompt', 'consent'); // 确保用户看到授权界面

        window.location.href = authUrl.toString();
    },

    // 【新】获取有效的访问令牌，并在需要时静默刷新
    getValidAccessToken: async function() {
        const expiresAt = await db.get('google_token_expires_at');
        let accessToken = await db.get('google_access_token');

        if (!accessToken || !expiresAt || Date.now() >= expiresAt) {
            console.log("driveSync: 访问令牌已过期或不存在，正在刷新...");
            const refreshToken = await db.get('google_refresh_token');
            if (!refreshToken) {
                console.error("driveSync: 找不到刷新令牌，需要用户重新授权。");
                await db.set('google_access_token', null);
                await db.set('google_token_expires_at', null);
                throw new Error("REAUTH_REQUIRED"); // 抛出特定错误，由上层处理
            }

            // 通过我们的代理服务来刷新令牌
            const response = await fetch(`${driveSync.PROXY_URL}/refresh-token`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    refresh_token: refreshToken,
                    client_id: driveSync.CLIENT_ID,
                }),
            });

            const tokenData = await response.json();
            if (!response.ok || tokenData.error) {
                console.error("driveSync: 刷新令牌失败。", tokenData.error_description);
                if (tokenData.error === 'invalid_grant') {
                     await db.set('google_refresh_token', null);
                     await db.set('google_access_token', null);
                     await db.set('google_token_expires_at', null);
                     throw new Error("REAUTH_REQUIRED");
                }
                throw new Error(tokenData.error_description || "刷新令牌时发生未知错误。");
            }

            accessToken = tokenData.access_token;
            await db.set('google_access_token', accessToken);
            const expiresInMs = (tokenData.expires_in - 60) * 1000; // 预留60秒缓冲
            await db.set('google_token_expires_at', Date.now() + expiresInMs);
            console.log("driveSync: 访问令牌刷新成功。");
        }
        return accessToken;
    },

    // 【新】包装所有GAPI请求，自动处理认证
    gapiClientRequest: async function(requestConfig) {
        try {
            const accessToken = await driveSync.getValidAccessToken();
            // 确保GAPI客户端已初始化
            if (!window.gapi || !window.gapi.client) {
                 throw new Error("GAPI客户端尚未初始化。");
            }
            window.gapi.client.setToken({ access_token: accessToken });
            return await window.gapi.client.request(requestConfig);
        } catch (error) {
            if (error.message === 'REAUTH_REQUIRED') {
                // 如果需要重新授权，弹窗提示用户
                openCustomPrompt({
                    title: '需要重新授权',
                    message: '您对Google Drive的访问权限已过期或被撤销，请重新授权以继续使用云同步功能。',
                    confirmText: '去授权',
                    onConfirm: () => { driveSync.authenticate(); }
                });
            }
            // 抛出错误，让调用者知道请求失败了
            throw error;
        }
    },

    // 【核心修正】所有文件操作函数现在都使用 gapiClientRequest 包装器
    findOrCreateFile: async function() {
        console.log("driveSync: 正在查找或创建云端文件...");
        const response = await driveSync.gapiClientRequest({
            path: 'https://www.googleapis.com/drive/v3/files',
            params: {
                q: `name='${driveSync.DRIVE_FILE_NAME}' and trashed = false`,
                spaces: 'drive',
                fields: 'files(id, name, modifiedTime)'
            }
        });

        if (response.result.files && response.result.files.length > 0) {
            driveSync.driveFileId = response.result.files[0].id;
            console.log("driveSync: 已找到文件:", driveSync.driveFileId);
            return response.result.files[0];
        } else {
            console.log("driveSync: 未找到文件，正在创建新文件...");
            const createResponse = await driveSync.gapiClientRequest({
                path: 'https://www.googleapis.com/drive/v3/files',
                method: 'POST',
                body: { name: driveSync.DRIVE_FILE_NAME, parents: ['root'] },
                fields: 'id, modifiedTime'
            });
            driveSync.driveFileId = createResponse.result.id;
            console.log("driveSync: 已创建新文件:", driveSync.driveFileId);
            return createResponse.result;
        }
    },

    upload: async function(data) {
        if (!driveSync.driveFileId) throw new Error("没有文件ID，无法上传。");
        const boundary = '-------314159265358979323846';
        const delimiter = "\r\n--" + boundary + "\r\n";
        const close_delim = "\r\n--" + boundary + "--";
        const multipartRequestBody =
            delimiter + 'Content-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify({ mimeType: 'application/json' }) +
            delimiter + 'Content-Type: application/json\r\n\r\n' + JSON.stringify(data) + close_delim;

        await driveSync.gapiClientRequest({
            path: `/upload/drive/v3/files/${driveSync.driveFileId}`,
            method: 'PATCH',
            params: { uploadType: 'multipart' },
            headers: { 'Content-Type': 'multipart/related; boundary="' + boundary + '"' },
            body: multipartRequestBody
        });
        console.log("driveSync: 上传成功。");
        return { success: true, message: "已同步到云端" };
    },

    download: async function() {
        if (!driveSync.driveFileId) return null;
        const response = await driveSync.gapiClientRequest({
            path: `https://www.googleapis.com/drive/v3/files/${driveSync.driveFileId}`,
            params: { alt: 'media' }
        });
        if (response.body && response.body.length > 0) {
            return JSON.parse(response.body);
        }
        return null;
    }
};

// ========================================================================
// Auth Callback Handler
// ========================================================================

async function handleGoogleAuthCallback() {
    const urlParams = new URLSearchParams(window.location.search);
    const authCode = urlParams.get('code');

    if (!authCode) {
        return; // URL中没有授权码，正常启动
    }
    
    // 清理地址栏，对用户隐藏授权码
    window.history.replaceState({}, document.title, window.location.pathname);

    openCustomPrompt({
        title: "正在完成Google Drive授权...",
        message: "请稍候...",
        inputType: 'none',
        hideConfirmButton: true,
        hideCancelButton: true
    });

    try {
        const codeVerifier = await db.get('google_code_verifier');
        if (!codeVerifier) {
            throw new Error("本地验证信息已丢失，请重新授权。");
        }

        const response = await fetch(`${driveSync.PROXY_URL}/exchange-token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                code: authCode,
                code_verifier: codeVerifier,
                client_id: driveSync.CLIENT_ID,
                redirect_uri: window.location.origin + window.location.pathname,
            }),
        });

        const tokenData = await response.json();

        if (!response.ok || tokenData.error) {
            throw new Error(tokenData.error_description || "从代理服务器获取Token失败。");
        }

        await db.set('google_access_token', tokenData.access_token);
        if (tokenData.refresh_token) {
            await db.set('google_refresh_token', tokenData.refresh_token);
        }
        const expiresInMs = (tokenData.expires_in - 60) * 1000;
        await db.set('google_token_expires_at', Date.now() + expiresInMs);
        await db.set('isFirstSyncCompleted', true); // 授权成功后，标记为已完成首次同步设置

        closeCustomPrompt();

        // 延迟触发同步，给UI一点响应时间
        setTimeout(() => {
            if (syncDriveBtn && !syncDriveBtn.disabled) {
                console.log("授权回调成功，自动触发同步。");
                syncDriveBtn.click();
            }
        }, 500);

    } catch (error) {
        closeCustomPrompt();
        openCustomPrompt({
            title: "授权失败",
            message: `与Google的授权连接失败：${error.message}`,
            confirmText: "好的",
            hideCancelButton: true,
        });
    }
}

// ========================================================================
// 2. 状态变量和常量定义
// (保持你现有的这部分代码不变)
// ========================================================================
let allTasks = {};
let isDataDirty = false;
let currentTheme = 'light';
let notificationsEnabled = true;
let selectedLedgerMonth = 'current';
let selectedMonthlyDisplayMonth = 'current';
let currentMonthlyTagFilter = 'all';
let currentLedgerFilter = 'all';
let historyModalFor = null;
let historyDisplayYear = new Date().getFullYear();
let annualReportYear = new Date().getFullYear();
let currentPromptConfig = {};
let activeKeydownHandler = null; 
let currentSearchTerm = '';
let autoSyncTimer = null; // 用于存储延迟同步的定时器ID
// AI相关UI元素
let aiSettingsBtn, aiAssistantBtn, aiAssistantModal, aiAssistantCloseBtn, 
    aiModeSelector, aiModeAddBtn, aiModeReportBtn, aiAddView, aiReportView, 
    aiPromptInput, aiProcessBtn, aiAddLoading, 
    reportOptionsGrid, aiReportOutput, aiReportTitle, 
    aiReportLoading, aiReportContent, aiReportCopyBtn, aiReportBackBtn;
// --- END OF REPLACEMENT ---

const AUTO_SYNC_DELAY = 5000; // 延迟5秒 (5000毫秒)
const faqs = [
    {
        question: "如何使用任务提醒功能？",
        answer: "在“未来计划”模块中，为任务设置一个未来的具体日期和时间。当到达指定时间后，如果您的设备和浏览器支持，并且您已允许通知权限，应用会尝试发送一条系统通知来提醒您。"
    },
    {
        question: "我设置了提醒，但为什么没有收到通知？",
        answer: "这可能有几个原因：<br>1. **权限问题：** 请确保您已允许本应用发送通知。您可以在浏览器设置或移动设备的应用设置中检查和修改通知权限。<br>2. **浏览器/系统限制：** 某些浏览器或操作系统在特定情况下（如省电模式、勿扰模式）可能会限制后台应用的通知。<br>3. **应用未在后台运行（对于非推送通知）：** 如果应用和其Service Worker没有机会在后台运行或被唤醒，基于简单定时器的提醒可能无法触发。为了更可靠的提醒，请确保应用至少偶尔被打开。<br>4. **网络问题（对于基于推送的提醒，如果未来实现）：** 如果是通过网络推送的提醒，网络连接不稳定可能导致延迟或失败。"
    },
    {
        question: "到期的“未来计划”任务去了哪里？",
        answer: "当一个“未来计划”任务到期后，它会自动以“[计划]”为前缀，移动到您的“每日清单”顶部，提醒您今天需要处理它。当您在每日清单中将它标记为完成后，它会在第二天的自动清理中被移除。"
    },
    {
        question: "如何将这个应用添加到手机主屏幕？",
        answer: "在大多数现代手机浏览器（如 Chrome, Safari, Edge）中，当您访问本应用时，浏览器可能会在地址栏或菜单中显示“添加到主屏幕”、“安装应用”或类似的选项。点击它即可将应用像原生App一样安装到您的设备主屏幕，方便快速访问。"
    },
    {
        question: "数据是存储在哪里的？离线可以使用吗？",
        answer: "您的所有数据都安全地存储在您浏览器本地的 IndexedDB 数据库中，这意味着即使在没有网络连接的情况下，您仍然可以访问和修改大部分数据。更改会在下次联网并通过“与云端同步”按钮操作时同步到您的 Google Drive。"
    },
    {
        question: "如何进行数据备份和跨设备同步？",
        answer: "您可以通过点击顶部的“与云端同步”按钮，将所有数据安全地备份和同步到您自己的 Google Drive。首次同步时需要授权。之后，您可以在其他也安装了本应用的设备上进行同步，以保持数据一致。"
    },
    {
        question: "如何为任务添加备注或链接？",
        answer: "在任务项上（桌面端是鼠标悬停，移动端可能需要根据UI设计确定交互，通常是点击任务本身或特定图标），会出现操作选项。点击备注图标（通常是对话气泡状）可以添加或编辑备注；点击链接图标可以添加网页链接。"
    },
    {
        question: "如何快速地同时编辑任务名和标签（本月待办）？",
        answer: "在“本月待办”列表中，点击任务的编辑按钮后，您可以使用 `任务名_标签1,标签2` 的格式进行输入。<br>例如，输入 `整理年度报告_工作,重要` 并保存，任务名会变为“整理年度报告”，并被赋予“工作”和“重要”两个标签。<br>如果输入时不包含下划线 `_`，则只会更新任务名，原有的标签会保持不变。"
    }
];

const features = [  { title: "四大清单模块", description: "每日重复、本月核心、未来规划、简易记账，全面覆盖您的任务和财务管理需求。" },
    { title: "渐进式网络应用 (PWA)", description: "本应用已适配 PWA，您可以将其“安装”到手机主屏幕或桌面，获得接近原生应用的离线使用和快速访问体验。" },
    { title: "任务提醒通知", description: "“未来计划”支持设置具体提醒时间。在支持的设备和浏览器上，到点后将弹出系统通知，确保您不会错过重要安排。" },
    { title: "智能任务流转", description: "到期的未来计划会自动转为每日任务，并以“[计划]”前缀标记，形成高效工作流。" },
    { title: "自动化管理", description: "每月1号自动归档已完成的任务和账单；每日重复任务自动重置，无需手动操作。" },
    { title: "丰富任务属性", description: "支持备注、链接、子任务、进度条、标签等多种属性。在“本月待办”中，可使用 `任务名_标签` 格式，一次性修改任务和标签。" },
    { title: "移动端优先导航", description: "采用底部标签栏导航，优化移动端单手操作体验，方便在不同模块间快速切换。" },
    { title: "拖拽排序与标签筛选", description: "所有清单支持拖拽排序，灵活调整优先级；标签系统可快速定位相关条目。" },
    { title: "Google Drive 云同步", description: "您的所有任务和账单数据可以安全地同步到您自己的Google Drive，实现跨设备访问和更可靠的数据备份。" },
    { title: "个性化主题", description: "一键切换浅色/深色主题，适应不同光线环境和个人偏好。" },
    { title: "数据洞察 (统计分析)", description: "全新的“统计分析”模块，通过图表清晰展示您的任务完成情况，帮助您更好地规划和决策。" },
    { title: "优先级任务管理", description: "“本月待办”支持设置高、中、低任务优先级，并可一键按优先级排序，助您聚焦核心任务。" } ];

const versionUpdateNotes = {   
    "4.3.0": [
        "【重磅升级】AI 助手现已集成Notion！支持将AI“生成报告”一键导出到Notion。"
    ],
    "4.2.0": [
        "【重磅升级】AI 助手现已支持“智能添加”与“生成报告”两大核心功能！",
        "    - **统一的AI入口**: 点击主界面新增的 ✨ AI 助手按钮，即可在统一的模态框中体验所有AI功能。",
        "    - **多模型支持**: 您现在可以在“更多操作” > “AI助手设置”中，配置并选用 OpenAI 或 Google Gemini 模型，选择您最信赖的AI大脑。",
        "    ",
        "    **1. 智能添加 (新)**:",
        "    - 只需用自然语言描述您的待办事项或开销，AI即可自动解析并填充到对应的清单中。",
        "    - 例如，输入“提醒我明天下午3点开会”，AI会自动创建带有提醒时间的未来计划。",
        "    - 例如，输入“昨晚用支付宝花了50块吃饭”，AI会自动为您记录一笔账单。",
        "    ",
        "    **2. 生成报告 (新)**:",
        "    - AI可以根据您已完成和待办的任务，一键生成包含“核心工作总结”、“问题反思”和“下阶段计划”的专业报告。",
        "    - 支持生成日报、周报、月报甚至年报，是您进行工作回顾和总结的得力帮手。"
    ],  
  "4.1.0": [
        "【全新功能】引入交互式任务进度条，提升您的成就感：",
        "    - 在“每日清单”和“本月待办”模块的标题下方新增了实时进度条。",
        "    - **可视化进度**：根据任务完成比例，以多彩渐变的形式直观展示您的进度。",
        "    - **详细统计**：点击进度条即可展开详情面板，查看完成率、已完成和剩余任务数。",
        "    - **激励反馈**：根据您的完成情况，提供不同的鼓励话语，为您加油打气！",
        "    - **智能切换**：当所有任务完成后，进度条会自动隐藏，并显示原有的祝贺信息。"
    ],
        "4.0.0": [
        "【里程碑更新】引入全新的三层数据安全体系，为您的数据提供前所未有的保障：",
        "    1. **自动每日快照（新增）**: 插件现在每天会自动在您的本地电脑上创建一个数据快照。如果发生任何误操作（如误删任务），您可以轻松从“历史快照”中恢复到过去14天内任意一天的状态。",
        "    2. **手动备份与恢复**: 您可以随时将所有数据完整备份为`.json`文件，用于在不同设备间迁移或长期离线存档。恢复流程包含多重安全确认，防止意外覆盖。",
        "    3. **云同步安全网**: 大幅优化的云同步逻辑，能智能识别并防止因重装插件等情况导致的数据覆盖问题，确保多设备同步的可靠性。",
        "【界面优化】“备份与恢复”功能已整合，现在提供“备份到文件”、“从文件恢复”和“查看历史快照”三个清晰选项。"
    ],
    "3.5.0": [
        "【核心安全修复】大幅优化云同步逻辑，增加数据安全网，解决了在特定情况下（如重装插件后）可能导致云端数据被意外清空的严重问题。现在的同步机制会智能判断数据状态，优先保护您的有效数据，让云同步更可靠、更安全。",
        "【全新功能】新增手动“备份与恢复”功能（位于“更多操作”菜单中）：",
        "    - **一键备份**：您可以随时将所有插件数据（包括任务、历史、账本等）完整备份为单个`.json`文件，并保存在您的本地电脑上。",
        "    - **安全恢复**：通过引导式流程从备份文件中恢复数据。恢复前会进行数据预览和二次确认（需输入关键词），最大限度防止误操作。",
        "    - **提供了一种与云同步完全分离的、更可靠、更透明的数据迁移和离线保管方案。**"
    ],
    "3.4.0": [
        "【功能增强】“每日清单”引入灵活的任务周期设置：",
        "    - **不重复任务**：添加的任务仅当天有效，次日自动清理，适合处理单次临时事务。",
        "    - **每周重复**：可将任务设置为每周的特定一天（如“每周一”）重复出现，方便规划规律性事务。",
        "    - **兼容旧数据**：所有旧的每日任务将自动视为“每日”重复任务。"
    ],
    "3.3.0": ["增加“每日清单”互动反馈提示"],
    "3.2.0": ["优化插件Google Drive 云同步体验"],
    "3.1.0": ["【核心增强】“PWA应用发布。可以将其“安装”到手机主屏幕或桌面"],"3.0.0": [ "【核心重构】引入Google Drive云同步功能，替换原有的Chrome同步机制作为主要数据存储：", "    - **数据更安全：** 您的所有任务和账单数据现在存储在您自己的Google Drive上的特定文件 (`efficienTodoData.json`) 中，由您完全掌控。", "    - **手动与自动同步：** 您可以随时手动点击“同步”按钮与Google Drive同步。同时，插件会在您进行修改后、打开时以及后台定期尝试自动同步，确保数据尽可能保持最新。", "    - **首次使用：** 新安装或从旧版本更新后，请点击“同步”按钮完成Google Drive授权，以启用云同步功能。", "【提醒功能改进】未来计划的提醒闹钟机制优化，提升了任务编辑后提醒的稳定性。", ], "2.1.0": [ "【记账本增强】引入强大的财务管理功能：", "    - **预算管理**：现在可以为每个项目设置月度预算，并在统计中通过进度条直观地查看开销情况。", "    - **年度报告**：一键生成年度收支报告，清晰汇总全年总支出、月均消费，并按项目和月份提供详细分类，助您轻松回顾财务状况。", "    - **多货币支持**：新增货币符号切换功能，支持在全球热门货币（如¥, €, £等）之间选择，满足国际化记账需求。" ], "2.0.0": [ "【核心功能】新增“统计分析”模块，提供多维度任务和账单数据可视化报告，助您洞察效率与开销。", "【功能增强】“本月待办”模块引入任务优先级管理：", "    - 支持为任务设置高、中、低三个优先级。", "    - 可按优先级一键排序任务列表。", "    - 拖拽排序依然有效，提供灵活的任务组织方式。" ], "1.9.0": [ "【核心功能】新增快速添加任务方式：", "1. **右键菜单**：在任何网页上选中文本，右键选择“添加到高效待办清单”，即可快速创建到“本月待办”。", "2. **地址栏命令**：在浏览器地址栏输入 'todo'，按 Tab 或空格，再输入任务内容并回车，即可快速添加。" ], "1.8.0": ["【核心功能】“未来计划”模块新增桌面提醒功能，可以为任务设置精确到分钟的提醒时间。"], "1.7.0": ["优化看板页面体验，增加顶部固定导航，长页面滚动和切换不再繁琐。"], "1.6.0": ["新增搜索框，可以实时搜索所有列表中的任务和记账条目。"], "1.5.0": ["新增当月条目归档功能，将当月任务归档到过去月份。"], "1.4.0": [ "为“本月待办”和“记账本”模块增加了 Excel(xlsx) 导入导出功能。", "现在可以下载数据模板，方便地批量添加任务和账单。", "可以一键导出所有历史归档数据，便于备份和分析。" ], "1.3.0": [ "记账本模块新增历史数据归档与月度账单统计功能，方便回顾与分析。", "本月待办模块增加历史月份查阅功能，轻松回顾过往任务。", "本月待办任务完成后，自动标记完成日期。" ] };
const dailyQuotes = [
  // --- 经典励志 ---
  "千里之行，始于足下。",
  "一个今天胜过两个明天。",
  "事竟成，功在不舍。",
  "业精于勤，荒于嬉。",
  "拖延是时间的窃贼。",
  "完成任务的最佳方式，就是开始做。",
  "明日复明日，明日何其多。我生待明日，万事成蹉跎。",
  "宝剑锋从磨砺出，梅花香自苦寒来。",
  "书山有路勤为径，学海无涯苦作舟。",
  "欲穷千里目，更上一层楼。",
  "海纳百川，有容乃大。",
  "路漫漫其修远兮，吾将上下而求索。",

  // --- 认知与心态 ---
  "专注，是这个时代最稀缺的能力。",
  "你无法控制风向，但你可以调整风帆。",
  "休息，是为了走更远的路。",
  "重要的不是你站的位置，而是你面向的方向。",
  "把每一次的失败，都归结为一次尝试。",
  "行动是治愈恐惧的良药，而犹豫、拖延将不断滋养恐惧。",
  "成长的过程就是破茧成蝶，挣扎着褪掉所有的青涩和丑陋。",
  "改变不了环境，就改变心境。",
  "困难像弹簧，你强它就弱，你弱它就强。",
  "心态决定状态，思路决定出路。",
  "每一个不曾起舞的日子，都是对生命的辜负。",
  "你的格局决定你的结局。",

  // --- 轻松有趣 ---
  "你知道吗？章母有三颗心脏。",
  "人生苦短，我用Python...不，我用清单。",
  "别担心，这个任务看起来比实际上要简单。",
  "给你的大脑一点空间，去散个步吧！",
  "一杯咖啡，一个清单，征服世界的一天。",
  "又是被待办事项包围的一天，加油鸭！",
  "Deadline 是第一生产力。",
  "你知道吗？水獭在睡觉时会手拉着手，以防被水冲散。",
  "企鹅走路看起来笨拙，但它们游泳速度可达时速25公里。",
  "今天也要像熊猫一样可爱地完成任务呢。",
  "Bug不是程序的错，是程序员太天真。",
  "生活就像代码，总有调试的时候。",
  "你知道吗？蜂鸟是唯一能倒着飞的鸟。",
  "做人要像向日葵一样，永远面向阳光。",

  // --- 时间管理 ---
  "时间是最公平的，每个人一天都是24小时。",
  "合理安排时间，就等于节约时间。",
  "今天的事今天做，不要拖到明天。",
  "时间不会等人，但高效的人会追上时间。",
  "把时间花在刀刃上，而不是刀柄上。",
  "一寸光阴一寸金，寸金难买寸光阴。",

  // --- 更多名言 ---
  "The secret of getting ahead is getting started. - Mark Twain",
  "Well done is better than well said. - Benjamin Franklin",
  "Simplicity is the ultimate sophistication. - Leonardo da Vinci",
  "不要让未来的你，讨厌现在的自己。",
  "种一棵树最好的时间是十年前，其次是现在。",
  "即使是最小的行动，也胜过最伟大的意图。",
  "It does not matter how slowly you go as long as you do not stop. - Confucius",
  "Your future is created by what you do today, not tomorrow. - Robert Kiyosaki",
  "A goal without a plan is just a wish. - Antoine de Saint-Exupéry",
  "The way to get started is to quit talking and begin doing. - Walt Disney",
  "Don't wait for opportunity. Create it. - George Bernard Shaw",
  "Success is not final, failure is not fatal: it is the courage to continue that counts. - Winston Churchill",

  // --- 自我提升 ---
  "每天进步一点点，就是成功的开始。",
  "学而时习之，不亦说乎？",
  "读万卷书，行万里路。",
  "活到老，学到老。",
  "知识改变命运，学习改变人生。",
  "投资自己的大脑，永远不会亏本。",

  // --- 坚持与毅力 ---
  "滴水穿石，不是力量大，而是功夫深。",
  "山不在高，有仙则名；水不在深，有龙则灵。",
  "只要功夫深，铁杵磨成针。",
  "不积跬步，无以至千里；不积小流，无以成江海。",
  "坚持就是胜利，放弃就是失败。",
  "成功路上没有捷径，只有坚持不懈的努力。"
];

// ========================================================================
// 3. 全局DOM元素变量
// (保持你现有的这部分代码不变)
// ========================================================================
let statsBtn, statsModal, statsModalCloseBtn, faqBtn, faqModal, faqModalCloseBtn, faqListDiv, mainSearchInput, dailyTitleDate, themeToggleBtn, feedbackBtn, donateBtn, dailyTaskList, monthlyTaskList, futureTaskList, ledgerList, monthlyHeaderTitle, sortMonthlyByPriorityBtn, ledgerHeaderTitle, monthlyInputArea, ledgerInputArea, newDailyTaskInput, addDailyTaskBtn, newMonthlyTaskInput, newMonthlyTagsInput, addMonthlyTaskBtn, newFutureTaskInput, futureTaskDateTimeInput, addFutureTaskBtn, ledgerDateInput, ledgerItemInput, ledgerAmountInput, ledgerPaymentInput, ledgerDetailsInput, addLedgerBtn, monthlyTagsContainer, ledgerTagsContainer, ledgerSummaryContainer, monthlyHistoryBtn, ledgerHistoryBtn, historyModal, historyModalCloseBtn, historyModalTitle, historyPrevYearBtn, historyNextYearBtn, historyCurrentYearSpan, historyMonthsGrid, donateModal, modalCloseBtn, featuresBtn, featuresModal, featuresModalCloseBtn, featuresListUl, exportMonthlyHistoryBtn, importMonthlyBtn, downloadMonthlyTemplateBtn, importMonthlyFileInput, exportLedgerHistoryBtn, importLedgerBtn, downloadLedgerTemplateBtn, importLedgerFileInput, toggleNotificationsBtn, customPromptModal, customPromptTitleEl, customPromptMessageEl, customPromptInputContainer, customPromptConfirmBtn, customPromptCancelBtn, customPromptCloseBtn, setBudgetBtn, annualReportBtn, annualReportModal, annualReportCloseBtn, annualReportTitle, annualReportPrevYearBtn, annualReportNextYearBtn, annualReportCurrentYearSpan, annualReportSummaryDiv, annualReportDetailsDiv, currencyPickerBtn, syncDriveBtn, syncStatusSpan, bottomNav, allSections, isHistoryModalOpen;

// ========================================================================
// 4. 核心功能函数定义
// (保持你现有的这部分代码不变，直到 bindEventListeners)
// ========================================================================


async function syncWithCloudOnStartup() {
    if (syncDriveBtn.disabled) return; // 如果正在同步中，则不执行

    console.log("启动时同步：检查云端数据是否存在更新。");
    if (syncStatusSpan) syncStatusSpan.textContent = '检查云端...';

    try {
        // findOrCreateFile 会处理认证并返回文件元数据
        const fileMeta = await driveSync.findOrCreateFile();
        if (!fileMeta || !fileMeta.modifiedTime) {
             console.log("启动时同步：云端无文件或无修改时间，跳过下载检查。");
             // 如果本地有数据，则上传初始化
             if (Object.keys(allTasks).length > 0) {
                 await driveSync.upload(allTasks);
                 if (syncStatusSpan) syncStatusSpan.textContent = '已初始化云端数据！';
             }
             return;
        }

        const cloudData = await driveSync.download();
        const todayString = getTodayString();

         // --- 智能同步逻辑 ---
        if (cloudData && typeof cloudData === 'object' && Object.keys(cloudData).length > 0) {
            
            // 情况一：云端数据已经是今天的。这说明其他设备已更新，应直接覆盖本地。
            if (cloudData.lastDailyResetDate === todayString) {
                console.log("启动时同步：云端数据为最新，将覆盖本地。");
                allTasks = cloudData;
                await db.set('allTasks', allTasks); // 将云端最新数据存入本地DB
                renderAllLists(); // 渲染UI
                if (syncStatusSpan) syncStatusSpan.textContent = '已从云端更新！';

            // 情况二：云端数据是昨天的（或更早）。这说明本设备是今天第一个启动的。
            } else {
                console.log("启动时同步：本设备为今日首次启动，将重置数据并同步。");
                if (syncStatusSpan) syncStatusSpan.textContent = '为新的一天准备数据...';

                // 1. 以云端数据为基础
                let dataToReset = cloudData;
                
                // 2. 在此基础上应用每日清理逻辑 (复用 cleanupDailyTasks 的核心部分)
                if (dataToReset.daily && dataToReset.daily.length > 0) {
                    const tasksToKeep = [];
                    dataToReset.daily.forEach(task => {
                        // 移除前一天来自“未来计划”的临时任务
                        if (task.fromFuture) return; 
                        // 移除已过期的“单次”任务
                        if (task.cycle === 'once' && task.creationDate !== todayString) return; 
                        
                        // 重置重复任务的完成状态
                        if (task.completed) task.completed = false;
                        tasksToKeep.push(task);
                    });
                    dataToReset.daily = tasksToKeep;
                }
                dataToReset.lastDailyResetDate = todayString; // 【关键】更新日期戳
                
                // 3. 将这份处理好的“今日新数据”作为权威数据
                allTasks = dataToReset;
                await db.set('allTasks', allTasks); // 保存到本地
                renderAllLists(); // 刷新UI

                // 4. 【关键】将这份权威的新数据立即上传回云端
                console.log("启动时同步：将重置后的今日数据上传回云端。");
                await driveSync.upload(allTasks);
                if (syncStatusSpan) syncStatusSpan.textContent = '新的一天，数据已同步！';
            }

        } else {
            // 情况三：云端无数据或为空。说明是全新安装，本地数据（已在 `runAutomaticUpkeepTasks` 中重置）将成为权威版本
            console.log("启动时同步：云端无数据，将上传本地数据。");
            await driveSync.upload(allTasks);
            if (syncStatusSpan) syncStatusSpan.textContent = '已初始化云端数据！';
        }

        isDataDirty = false;
        updateSyncIndicator();

    } catch (error) {
        console.error("启动时自动同步失败:", error);
        if (error.message !== 'REAUTH_REQUIRED') {
            if (syncStatusSpan) syncStatusSpan.textContent = '启动同步失败';
        }
    } finally {
        setTimeout(() => {
            if (syncStatusSpan && (syncStatusSpan.textContent.includes('更新') || syncStatusSpan.textContent.includes('同步') || syncStatusSpan.textContent.includes('失败'))) {
                syncStatusSpan.textContent = '';
            }
        }, 5000);
    }
}

async function loadGoogleApis() {
    // This new function dynamically loads the GAPI script and uses its
    // official callback mechanism, which is much more reliable than polling.
    return new Promise((resolve, reject) => {
        // 1. Set a general timeout for the entire process. 20 seconds is more generous.
        const timeoutId = setTimeout(() => {
            reject(new Error("Loading Google API timed out. Please check your network connection."));
        }, 20000); // 20-second timeout

        // 2. Define a callback function that GAPI will call once its script is loaded.
        window.gapiLoaded = () => {
            console.log("gapi.js script loaded. Now loading 'client' module...");
            // Now that gapi is loaded, we use its own loader for the 'client' module.
            window.gapi.load('client', {
                callback: async () => {
                    try {
                        console.log("GAPI 'client' module loaded. Initializing...");
                        // The client is loaded, now initialize it with our config.
                        await window.gapi.client.init({
                            apiKey: driveSync.API_KEY,
                            discoveryDocs: driveSync.DISCOVERY_DOCS,
                        });
                        console.log("Google API client initialized successfully.");
                        clearTimeout(timeoutId); // Success, so clear the timeout.
                        resolve(); // Resolve the main promise.
                    } catch (initError) {
                        clearTimeout(timeoutId);
                        reject(initError);
                    }
                },
                onerror: (err) => {
                    console.error("Error loading GAPI client module:", err);
                    clearTimeout(timeoutId);
                    reject(new Error("Failed to load a required Google client module."));
                },
            });
        };

        // 3. Dynamically create and inject the script tag into the page.
        // We use the `onload=gapiLoaded` query parameter, which is the official way.
        const script = document.createElement('script');
        script.src = 'https://apis.google.com/js/api.js?onload=gapiLoaded';
        script.async = true;
        script.defer = true;
        script.onerror = () => {
            clearTimeout(timeoutId);
            reject(new Error("Failed to load Google API script. Check for network issues or ad-blockers."));
        };
        document.head.appendChild(script);
    });
}
function updateSyncIndicator() {
    if (!syncDriveBtn || !syncStatusSpan) return;

    if (isDataDirty) {
        syncStatusSpan.textContent = '需要同步';
        syncDriveBtn.classList.add('needs-sync'); // 可以用CSS给按钮加个发光或变色效果
    } else {
        // 只有当状态不是正在同步中时才清空
        if (!syncDriveBtn.disabled) {
            syncStatusSpan.textContent = '已同步'; // 或者显示最后同步时间
             setTimeout(() => { if (syncStatusSpan.textContent === '已同步') syncStatusSpan.textContent = ''; }, 5000);
        }
        syncDriveBtn.classList.remove('needs-sync');
    }
}

async function runAutomaticUpkeepTasks() {
    // 使用一个全局标志来防止在单次会话中重复执行不必要的维护
    if (window.automaticTasksHaveRun) {
        return;
    }

    console.log("执行首次自动维护任务...");
    let dataWasChanged = false;

    // 1. 执行每日任务清理
    if (cleanupDailyTasks()) {
        console.log("每日任务已清理。");
        dataWasChanged = true;
    }

    // 2. 执行未来任务移动 (确保 checkAndMoveFutureTasks 只移动数据，不保存)
    if (checkAndMoveFutureTasks()) {
        console.log("到期的未来任务已移动。");
        dataWasChanged = true;
    }

    // 3. 如果有任何数据被自动修改，则统一进行一次保存
    if (dataWasChanged) {
        console.log("自动维护任务导致数据变更，正在保存...");
        // 调用 saveTasks() 会更新时间戳并标记数据为 dirty，这是正确的行为
        await saveTasks();
        // 重新渲染UI以反映这些自动变化
        renderAllLists();
    }

    // 4. 设置标志，表示本次启动后的自动维护已完成
    window.automaticTasksHaveRun = true;
    console.log("首次自动维护任务执行完毕。");
}

async function loadTasks(callback) {
    console.log("[PWA] Loading tasks from DB...");
    let data;
    try {
        data = await db.get('allTasks');
    } catch (error) {
        console.error("[PWA] Error loading tasks from DB:", error);
        allTasks = { daily: [], monthly: [], future: [], ledger: [], history: {}, ledgerHistory: {}, budgets: {}, currencySymbol: '$', lastUpdatedLocal: 0, lastDailyResetDate: '1970-01-01' };
        await saveTasks();
        if (callback) callback();
        return;
    }
    
    if (data && typeof data === 'object') {
        allTasks = data;
        const defaultStructure = { daily: [], monthly: [], future: [], ledger: [], history: {}, ledgerHistory: {}, budgets: {}, currencySymbol: '$', lastUpdatedLocal: 0, lastDailyResetDate: '1970-01-01' };
        for (const key in defaultStructure) {
            if (!allTasks.hasOwnProperty(key)) {
                allTasks[key] = defaultStructure[key];
            }
        }
    } else {
        allTasks = { daily: [], monthly: [], future: [], ledger: [], history: {}, ledgerHistory: {}, budgets: {}, currencySymbol: '$', lastUpdatedLocal: 0, lastDailyResetDate: '1970-01-01' };
        await saveTasks();
    }
    if (callback) callback();
}



async function saveTasks() {
    allTasks.lastUpdatedLocal = Date.now();
    isDataDirty = true;
    updateSyncIndicator();
    try {
  // 【修改开始】
        // 1. 正常保存完整的 allTasks 对象
        await db.set('allTasks', allTasks);

        // 2. 额外保存一份只包含 future 任务的列表，供 Service Worker 轻量读取
        // 确保 allTasks.future 是一个数组，即使是空数组
        const futureTasksToSave = allTasks.future || [];
        await db.set('futureTasksForSW', futureTasksToSave); 
        console.log('[PWA] a_future_tasks_for_sw saved to DB with', futureTasksToSave.length, 'items.');
        
        // 3. 触发自动同步（保持不变）
        triggerAutoSync();
        // 【修改结束】
    } catch (error) {
        console.error('[PWA] Error saving tasks to DB:', error);
    }
}

// 建议将此函数放在 saveTasks 函数附近
function triggerAutoSync() {
    // 1. 如果已有定时器在运行，先清除它
    if (autoSyncTimer) {
        clearTimeout(autoSyncTimer);
    }

    // 2. 检查同步按钮，如果正在手动同步中，则不启动自动同步
    const syncButton = document.getElementById('sync-drive-btn');
    if (syncButton && syncButton.disabled) {
        console.log('Auto-sync deferred: Manual sync is in progress.');
        return;
    }

    // 3. 启动一个新的定时器
    console.log(`Auto-sync scheduled in ${AUTO_SYNC_DELAY / 1000} seconds.`);
    if (syncStatusSpan) syncStatusSpan.textContent = '更改已保存，准备同步...';
    
    autoSyncTimer = setTimeout(() => {
        console.log('Auto-sync timer fired. Initiating sync...');
        if (syncButton && !syncButton.disabled) {
            // 模拟点击同步按钮来执行完整的同步流程
            syncButton.click();
        }
        // 清除定时器ID，表示本次任务已执行
        autoSyncTimer = null;
    }, AUTO_SYNC_DELAY);
}
function renderDailyQuote() {
    const quoteContainer = document.getElementById('daily-quote-container');
    if (!quoteContainer) return;

    const dayOfYear = Math.floor((new Date() - new Date(new Date().getFullYear(), 0, 0)) / (1000 * 60 * 60 * 24));
    const quoteIndex = dayOfYear % dailyQuotes.length;
    quoteContainer.textContent = `"${dailyQuotes[quoteIndex]}"`;
}

function switchView(targetId) {
    document.querySelectorAll('.tab-item').forEach(item => {
        item.classList.toggle('active', item.dataset.section === targetId);
    });
    allSections.forEach(section => {
        section.style.display = section.id === targetId ? 'block' : 'none';
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function handleTaskDue(dueTaskId) {
    if (!allTasks || !allTasks.future || !dueTaskId) return;

    let taskMoved = false;
    const remainingFutureTasks = [];
    
    // 找到并移动任务
    allTasks.future.forEach(task => {
        if (task.id === dueTaskId) {
            console.log(`[PWA] Moving due task "${task.text}" to daily list.`);
            if (!allTasks.daily) allTasks.daily = [];
            
            // 检查是否已存在（以防SW多次发送消息）
            if (!allTasks.daily.some(d => d.originalFutureId === task.id)) {
                allTasks.daily.unshift({
                    id: `daily_${Date.now()}_${Math.random().toString(36).substr(2,5)}`,
                    text: `[计划] ${task.text}`,
                    completed: false,
                    note: task.progressText || task.note || '',
                    links: task.links || [],
                    originalFutureId: task.id,
                    fromFuture: true
                });
                taskMoved = true;
            }
        } else {
            remainingFutureTasks.push(task);
        }
    });

    if (taskMoved) {
        allTasks.future = remainingFutureTasks;
        // 保存更改并刷新UI
        await saveTasks();
        renderAllLists();
    }
}

/**
 * Generates a motivational quote based on completion percentage.
 * @param {number} percentage - The completion percentage (0-100).
 * @param {number} remainingTasks - The number of tasks left to do.
 * @returns {string} A motivational string.
 */
function getMotivationalQuote(percentage, remainingTasks) {
    if (percentage <= 0) {
        return "✨ 新的一天，新的开始！从第一个任务做起吧！";
    }
    if (percentage < 30) {
        return `👍 有了一个好的开始！继续努力，你会做得很好。`;
    }
    if (percentage < 50) {
        return `🔥 你正走在正确的轨道上！完成一半就不远了。`;
    }
    if (percentage < 70) {
        return `💪 继续加油！您已经完成了 ${Math.round(percentage)}% 的任务，还剩 ${remainingTasks} 个任务就完成了！`;
    }
    if (percentage < 100) {
        return `🎉 非常棒！只剩下最后一点了，胜利在望！`;
    }
    return "🚀 太棒了！您已完成所有任务！"; // Fallback, should not be seen
}


/**
 * Renders the progress tracker UI for a given list type.
 * @param {('daily'|'monthly')} listType - The type of the list.
 * @param {Array} tasks - The full array of tasks for the period to calculate progress.
 */
function renderProgressTracker(listType, tasks) {
    const trackerEl = document.getElementById(`${listType}-progress-tracker`);
    if (!trackerEl) return;

    // Remove old event listener to prevent memory leaks
    const newTrackerEl = trackerEl.cloneNode(true);
    trackerEl.parentNode.replaceChild(newTrackerEl, trackerEl);
    
    const container = newTrackerEl.querySelector('.progress-container');
    const barFill = newTrackerEl.querySelector('.progress-bar-fill');
    const percentageText = newTrackerEl.querySelector('.progress-percentage');
    const detailsPanel = newTrackerEl.querySelector('.progress-details');

    if (!tasks || tasks.length === 0) {
        newTrackerEl.style.display = 'none';
        return;
    }

    const totalTasks = tasks.length;
    const completedTasks = tasks.filter(t => t.completed).length;
    const remainingTasks = totalTasks - completedTasks;
    const percentage = totalTasks > 0 ? (completedTasks / totalTasks) * 100 : 0;

    // Main logic: Show progress bar OR celebration message
    if (percentage >= 100) {
        newTrackerEl.style.display = 'none'; // Hide progress bar
        const listElement = document.getElementById(`${listType}-task-list`);
        const message = listType === 'daily' 
            ? '太棒了，您完成了今日的所有任务！' 
            : '太棒了，您完成了本月的所有任务！';
        handleCompletionCelebration(listType, tasks, listElement, message);
    } else {
        newTrackerEl.style.display = 'block'; // Show progress bar
        
        // Ensure celebration message is hidden if tasks become incomplete again
        const listElement = document.getElementById(`${listType}-task-list`);
        handleCompletionCelebration(listType, [], listElement, ''); 

        // Update bar width and color
        barFill.style.width = `${percentage}%`;
        barFill.classList.remove('low', 'medium', 'high');
        if (percentage < 40) {
            barFill.classList.add('low');
        } else if (percentage < 80) {
            barFill.classList.add('medium');
        } else {
            barFill.classList.add('high');
        }

        // Update percentage text
        percentageText.textContent = `${Math.round(percentage)}%`;

        // Update details panel content
        detailsPanel.innerHTML = `
            <div class="progress-details-stats">
                <div class="stat-item">
                    <span class="value">${Math.round(percentage)}%</span>
                    <span class="label">完成率</span>
                </div>
                <div class="stat-item">
                    <span class="value">${completedTasks}</span>
                    <span class="label">已完成</span>
                </div>
                <div class="stat-item">
                    <span class="value">${remainingTasks}</span>
                    <span class="label">剩余</span>
                </div>
            </div>
            <div class="motivation-quote">
                ${getMotivationalQuote(percentage, remainingTasks)}
            </div>
        `;

        // Add click listener to toggle details
        container.addEventListener('click', () => {
            newTrackerEl.classList.toggle('is-expanded');
        });
    }
}
function openModal(modalElement) { if (modalElement) modalElement.classList.remove('hidden'); }
function closeModal(modalElement) { if (modalElement) modalElement.classList.add('hidden'); }
function applyTheme(theme) { document.documentElement.setAttribute('data-theme', theme); currentTheme = theme; }
function toggleTheme() { const newTheme = currentTheme === 'light' ? 'dark' : 'light'; applyTheme(newTheme); localStorage.setItem('theme', newTheme); }
function loadTheme() { const savedTheme = localStorage.getItem('theme') || 'light'; applyTheme(savedTheme); }
function generateUniqueId() { return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`; }

function addTask(inputElement, taskArrayRefName, onCompleteCallback, options = {}) {
    const { type, tagsInputElement, dateElement } = options;
    const taskText = inputElement.value.trim();
    if (!taskText) return;

    let newTask = {};
    const taskArray = allTasks[taskArrayRefName] || []; // 确保 taskArrayRefName 对应的数组存在

 if (type === 'future') {
        const taskDateTimeValue = dateElement ? dateElement.value : '';
        newTask = { id: generateUniqueId(), text: taskText, completed: false, links: [] };
        if (taskDateTimeValue) {
            const reminderDate = new Date(taskDateTimeValue);
            const reminderTimestamp = reminderDate.getTime();
            if (!isNaN(reminderTimestamp) && reminderTimestamp > Date.now()) {
                newTask.reminderTime = reminderTimestamp;
                
                // 【核心修正】增加健壮的提醒调度逻辑
                if (notificationsEnabled && 'serviceWorker' in navigator) {
                    // 使用 navigator.serviceWorker.ready 来确保 SW 已激活
                    navigator.serviceWorker.ready.then(registration => {
                        if (registration.active) {
                            registration.active.postMessage({ type: 'SCHEDULE_REMINDER', payload: { task: newTask } });
                            console.log(`[PWA App] SCHEDULE_REMINDER for task ID ${newTask.id} sent to active Service Worker.`);
                        } else {
                             console.warn(`[PWA App] Reminder for task ID ${newTask.id} NOT sent: Service Worker is ready but has no active worker.`);
                        }
                    }).catch(error => {
                        console.error(`[PWA App] Error waiting for Service Worker to be ready for task ${newTask.id}:`, error);
                    });
                } else if (notificationsEnabled) {
                     console.warn(`[PWA App] Reminder for task ID ${newTask.id} NOT sent: Service Worker API not available or notificationsEnabled is false.`);
                }
            } else { 
                newTask.date = taskDateTimeValue.split('T')[0]; // 存储 YYYY-MM-DD 格式的日期
                if(taskDateTimeValue && (isNaN(reminderTimestamp) || reminderTimestamp <= Date.now())) {
                    console.warn(`[PWA App] Future task "${taskText}" date/time (${taskDateTimeValue}) is invalid or in the past. Storing date only: ${newTask.date}`);
                }
            }
        }
    } else if (type === 'daily') {
        // --- START OF REPLACEMENT ---
        const cycleSelect = document.getElementById('new-daily-task-cycle-select');
        const cycleValue = cycleSelect ? cycleSelect.value : 'daily';
        
        newTask = { 
            id: generateUniqueId(), 
            text: taskText, 
            completed: false, 
            note: '', 
            links: [],
            cycle: cycleValue // 新增周期属性
        };
        
        // 如果是不重复任务，记录创建日期
        if (cycleValue === 'once') {
            newTask.creationDate = getTodayString();
        }
        // --- END OF REPLACEMENT ---
    } else if (type === 'monthly') {
        const tagsString = tagsInputElement ? tagsInputElement.value.trim() : '';
        newTask = { id: generateUniqueId(), text: taskText, completed: false, links: [], progress: 0, progressText: '', subtasks: [], tags: tagsString ? tagsString.split(',').map(tag => tag.trim()).filter(Boolean) : [], completionDate: null, priority: 2 };
    } else {
        console.error("Unknown task type:", type);
        return;
    }
    
    // 确保目标数组存在
    if (!allTasks[taskArrayRefName]) {
        allTasks[taskArrayRefName] = [];
    }
    allTasks[taskArrayRefName].unshift(newTask);

    inputElement.value = '';
    if (tagsInputElement) tagsInputElement.value = '';
    if (dateElement) dateElement.value = ''; // 清空日期时间选择器
    saveTasks().then(() => { if (onCompleteCallback) onCompleteCallback(); });
}

async function loadNotificationSetting() { 
    const storedSetting = localStorage.getItem('notificationsEnabled');
    notificationsEnabled = storedSetting === null ? true : storedSetting === 'true';
    await updateNotificationButtonUI(); 
}

async function toggleNotificationSetting() { 
    // 关键：不要在这里立即改变 notificationsEnabled 的值。
    // 让它保持当前的状态，根据这个状态来决定是【开启】还是【关闭】。
    
    // 我们将根据 notificationsEnabled 的【当前值】来决定做什么
    const wantsToEnable = !notificationsEnabled; 
    
    // 更新 localStorage 是可以立即做的
    localStorage.setItem('notificationsEnabled', wantsToEnable);

    if (wantsToEnable) { // 如果用户希望开启通知
        try {
            // 请求权限的逻辑保持不变
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                openCustomPrompt({title:"权限不足", message:'请在浏览器设置中允许本站的通知权限。', inputType:'none', hideCancelButton:true, confirmText:'好的'});
                // 如果用户拒绝，我们什么都不做，让最终的 UI 更新来处理
                localStorage.setItem('notificationsEnabled', 'false'); // 确保存储也同步
            } else {
                // 权限获取成功，调用 handleNotificationToggle 来处理【订阅】
                // 注意：handleNotificationToggle 内部会自己根据新的状态来工作
            }
        } catch (error) {
            console.error("Error requesting notification permission:", error);
            localStorage.setItem('notificationsEnabled', 'false');
        }
    } 
    // 不需要 else 分支了，因为 handleNotificationToggle 会处理取消订阅
    
    // 【核心修正】
    // 在所有权限和初步状态设置完成后，
    // 才真正更新全局变量，并调用总的处理器。
    notificationsEnabled = wantsToEnable;
    await handleNotificationToggle(); // 让这个函数来决定是订阅还是取消订阅
}

function getMonthlyDataForDisplay() {
    // 确保 allTasks 和 selectedMonthlyDisplayMonth 已定义
    if (!allTasks) return []; // 或者返回一个更合适的默认值
    return selectedMonthlyDisplayMonth === 'current'
        ? (allTasks.monthly || [])
        : (allTasks.history && allTasks.history[selectedMonthlyDisplayMonth] ? allTasks.history[selectedMonthlyDisplayMonth] : []);
}

function getLedgerDataForDisplay() {
    // 确保 allTasks 和 selectedLedgerMonth 已定义
    if (!allTasks) return []; // 或者返回一个更合适的默认值
    return selectedLedgerMonth === 'current'
        ? (allTasks.ledger || [])
        : (allTasks.ledgerHistory && allTasks.ledgerHistory[selectedLedgerMonth] ? allTasks.ledgerHistory[selectedLedgerMonth] : []);
}

function renderAllLists() {
    const searchActive = currentSearchTerm.length > 0;
    const dailyData = searchActive ? (allTasks.daily || []).filter(task => task.text.toLowerCase().includes(currentSearchTerm) || (task.note && task.note.toLowerCase().includes(currentSearchTerm))) : (allTasks.daily || []);
    const futureData = searchActive ? (allTasks.future || []).filter(task => task.text.toLowerCase().includes(currentSearchTerm)) : (allTasks.future || []);
    
    const baseMonthlyData = getMonthlyDataForDisplay();
    const monthlyData = searchActive 
        ? baseMonthlyData.filter(task => 
            task.text.toLowerCase().includes(currentSearchTerm) || 
            (task.progressText && task.progressText.toLowerCase().includes(currentSearchTerm)) || 
            (task.tags && task.tags.some(tag => tag.toLowerCase().includes(currentSearchTerm))) || 
            (task.subtasks && task.subtasks.some(st => st.text.toLowerCase().includes(currentSearchTerm)))
          ) 
        : baseMonthlyData;

    const baseLedgerData = getLedgerDataForDisplay();
    const ledgerData = searchActive 
        ? baseLedgerData.filter(entry => 
            entry.item.toLowerCase().includes(currentSearchTerm) || 
            (entry.payment && entry.payment.toLowerCase().includes(currentSearchTerm)) || 
            (entry.details && entry.details.toLowerCase().includes(currentSearchTerm))
          ) 
        : baseLedgerData;

    renderDailyTasks(dailyData);
    renderMonthlyTasks(monthlyData, selectedMonthlyDisplayMonth !== 'current');
    renderMonthlyTags(monthlyData);
    renderFutureTasks(futureData);
    renderLedger(ledgerData, selectedLedgerMonth !== 'current');
    renderLedgerTags(ledgerData);
    renderLedgerSummary(ledgerData);
}

async function forceRefreshData() {
    console.log("Manual refresh triggered. Forcing data reload from DB...");
    
    // 1. 可选：给用户一个视觉反馈
    const refreshBtn = document.getElementById('manual-refresh-btn');
    if (refreshBtn) {
        const icon = refreshBtn.querySelector('img');
        if (icon) {
            icon.style.transition = 'transform 0.5s ease';
            icon.style.transform = 'rotate(360deg)';
        }
        refreshBtn.disabled = true;
    }

    try {
        // 2. 强制从 IndexedDB 重新加载最新的 `allTasks` 数据
        // loadTasks 会更新全局的 allTasks 变量
        await loadTasks();

        // 3. 检查是否有到期的未来任务需要移动（这是一个好时机）
        checkAndMoveFutureTasks();
        
        // 4. 重新渲染所有列表，UI将更新为最新数据
        renderAllLists();
        
        console.log("Manual refresh completed successfully.");

    } catch (error) {
        console.error("Manual refresh failed:", error);
        openCustomPrompt({
            title: "刷新失败",
            message: "从本地数据库加载数据时出错，请检查控制台获取更多信息。",
            inputType: 'none',
            confirmText: '好的',
            hideCancelButton: true
        });
    } finally {
        // 5. 恢复按钮状态
        if (refreshBtn) {
            const icon = refreshBtn.querySelector('img');
            setTimeout(() => {
                if (icon) {
                    icon.style.transition = 'none'; // 移除过渡以便立即重置
                    icon.style.transform = 'rotate(0deg)';
                }
                refreshBtn.disabled = false;
            }, 500); // 等待动画完成
        }
    }
}

function downloadMonthlyTemplate() {
    const headers = ["text", "completed", "completionDate", "tags (comma-separated)", "subtasks (text|completed;...)", "links (comma-separated)", "progressText"];
    const exampleData = ["开发导入功能", false, "", "dev,feature", "设计UI|true;编写代码|false;测试|false", "https://github.com/SheetJS/sheetjs", "核心功能，需要尽快完成"];
    const data = [headers, exampleData];
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "MonthlyTasks");
    XLSX.writeFile(wb, "monthly_tasks_template.xlsx");
}
function downloadLedgerTemplate() {
    const headers = ["date (YYYY-MM-DD)", "item", "amount", "payment", "details"];
    const exampleData = [getTodayString(), "午餐", 15.50, "微信支付", "公司楼下的快餐店"];
    const data = [headers, exampleData];
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Ledger");
    XLSX.writeFile(wb, "ledger_template.xlsx");
}
function exportMonthlyHistory() {
    const historyKeys = Object.keys(allTasks.history || {});
    if (historyKeys.length === 0) { openCustomPrompt({title:"无数据", message:'没有可导出的历史归档任务。', inputType:'none', confirmText:'好的', hideCancelButton:true}); return; }
    const wb = XLSX.utils.book_new();
    const headers = ["text", "completed", "completionDate", "tags", "subtasks", "links", "progress", "progressText"];
    historyKeys.sort().reverse().forEach(key => {
        const tasks = allTasks.history[key];
        const dataToExport = tasks.map(task => [task.text, task.completed, task.completionDate || '', (task.tags || []).join(','), (task.subtasks || []).map(st => `${st.text}|${st.completed}`).join(';'), (task.links || []).join(','), task.progress || 0, task.progressText || '']);
        const ws = XLSX.utils.aoa_to_sheet([headers, ...dataToExport]);
        XLSX.utils.book_append_sheet(wb, ws, key);
    });
    XLSX.writeFile(wb, "monthly_tasks_history.xlsx");
    openCustomPrompt({title:"导出成功", message:'历史任务已成功导出！', inputType:'none', confirmText:'好的', hideCancelButton:true});
}
function exportLedgerHistory() {
    const historyKeys = Object.keys(allTasks.ledgerHistory || {});
    if (historyKeys.length === 0) { openCustomPrompt({title:"无数据", message:'没有可导出的历史账单。', inputType:'none', confirmText:'好的', hideCancelButton:true}); return; }
    const wb = XLSX.utils.book_new();
    const headers = ["date", "item", "amount", "payment", "details"];
    historyKeys.sort().reverse().forEach(key => {
        const entries = allTasks.ledgerHistory[key];
        const dataToExport = entries.map(entry => [entry.date, entry.item, entry.amount, entry.payment || '', entry.details || '']);
        const ws = XLSX.utils.aoa_to_sheet([headers, ...dataToExport]);
        XLSX.utils.book_append_sheet(wb, ws, key);
    });
    XLSX.writeFile(wb, "ledger_history.xlsx");
    openCustomPrompt({title:"导出成功", message:'历史账单已成功导出！', inputType:'none', confirmText:'好的', hideCancelButton:true});
}
function handleMonthlyImport(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];
            const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
            if (jsonData.length <= 1) { openCustomPrompt({title: "导入提示", message: '导入的文件是空的或只有表头。', inputType: 'none', confirmText: "好的", hideCancelButton: true}); return; }
            const importedTasks = [];
            for (let i = 1; i < jsonData.length; i++) {
                const row = jsonData[i];
                if (!row[0]) continue; 
                const newTask = { 
                    id: generateUniqueId(), 
                    text: row[0] || '', 
                    completed: String(row[1]).toLowerCase() === 'true', 
                    completionDate: row[2] || null, 
                    tags: row[3] ? String(row[3]).split(',').map(t => t.trim()).filter(Boolean) : [], 
                    subtasks: row[4] ? String(row[4]).split(';').map(st => { const parts = st.split('|'); return { text: parts[0] || '', completed: String(parts[1]).toLowerCase() === 'true' }; }).filter(st => st.text) : [], 
                    links: row[5] ? String(row[5]).split(',').map(l => l.trim()).filter(Boolean) : [], 
                    progressText: row[6] || '', 
                    progress: 0, 
                    priority: 2 
                };
                updateMonthlyTaskProgress(newTask); 
                importedTasks.push(newTask);
            }
            if (importedTasks.length > 0) { 
                allTasks.monthly.unshift(...importedTasks); 
                saveTasks(); 
                renderAllLists(); 
                openCustomPrompt({title: "导入成功", message: `成功导入 ${importedTasks.length} 条任务！`, inputType: 'none', confirmText: "好的", hideCancelButton: true}); 
            } else { 
                openCustomPrompt({title: "导入提示", message: '未找到有效数据进行导入。', inputType: 'none', confirmText: "好的", hideCancelButton: true}); 
            }
        } catch (error) { 
            console.error("导入失败:", error); 
            openCustomPrompt({ title: "导入失败", message: "导入失败，请确保文件格式正确，并与模板一致。", inputType: 'none', confirmText: "好的", hideCancelButton: true}); 
        } finally { 
            event.target.value = ''; 
        }
    };
    reader.readAsArrayBuffer(file);
}
function handleLedgerImport(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const data = new Uint8Array(e.target.result);
            const workbook = XLSX.read(data, { type: 'array' });
            const firstSheetName = workbook.SheetNames[0];
            const worksheet = workbook.Sheets[firstSheetName];
            const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
            if (jsonData.length <= 1) { openCustomPrompt({title: "导入提示", message: '导入的文件是空的或只有表头。', inputType: 'none', confirmText: "好的", hideCancelButton: true}); return; }
            const importedEntries = [];
            for (let i = 1; i < jsonData.length; i++) {
                const row = jsonData[i];
                if (!row[0] || !row[1] || row[2] === undefined || row[2] === null || String(row[2]).trim() === '') continue; 
                const newEntry = { 
                    date: row[0], 
                    item: row[1], 
                    amount: parseFloat(row[2]), 
                    payment: row[3] || '', 
                    details: row[4] || '' 
                };
                if (typeof newEntry.date === 'number') {
                    const excelEpoch = new Date(1899, 11, 30); 
                    const jsDate = new Date(excelEpoch.getTime() + newEntry.date * 24 * 60 * 60 * 1000);
                    newEntry.date = `${jsDate.getFullYear()}-${String(jsDate.getMonth() + 1).padStart(2, '0')}-${String(jsDate.getDate()).padStart(2, '0')}`;
                } else if (newEntry.date && !/^\d{4}-\d{2}-\d{2}$/.test(newEntry.date)) {
                    try {
                        const parsedDate = new Date(newEntry.date);
                        if (!isNaN(parsedDate)) {
                             newEntry.date = `${parsedDate.getFullYear()}-${String(parsedDate.getMonth() + 1).padStart(2, '0')}-${String(parsedDate.getDate()).padStart(2, '0')}`;
                        } else {
                            console.warn("Invalid date format in import:", row[0]);
                            continue; 
                        }
                    } catch (dateParseError) {
                        console.warn("Error parsing date in import:", row[0], dateParseError);
                        continue;
                    }
                }
                if (isNaN(newEntry.amount)) {
                    console.warn("Invalid amount in import:", row[2]);
                    continue; 
                }
                importedEntries.push(newEntry);
            }
            if (importedEntries.length > 0) { 
                allTasks.ledger.unshift(...importedEntries); 
                saveTasks(); 
                renderAllLists(); 
                openCustomPrompt({title: "导入成功", message: `成功导入 ${importedEntries.length} 条账单记录！`, inputType: 'none', confirmText: "好的", hideCancelButton: true}); 
            } else { 
                openCustomPrompt({title: "导入提示", message: '未找到有效数据进行导入。', inputType: 'none', confirmText: "好的", hideCancelButton: true}); 
            }
        } catch (error) { 
            console.error("导入失败:", error); 
            openCustomPrompt({ title: "导入失败", message: "导入失败，请确保文件格式正确，并与模板一致。", inputType: 'none', confirmText: "好的", hideCancelButton: true}); 
        } finally { 
            event.target.value = ''; 
        }
    };
    reader.readAsArrayBuffer(file);
}
// In app.js, find the renderDailyTasks function and replace it with this version.


// --- START OF REPLACEMENT ---
function renderDailyTasks(tasksToRender) {
    if (!dailyTaskList) return;
    const now = new Date();
    if (dailyTitleDate) dailyTitleDate.textContent = `(${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')})`;
    
    // --- 【核心】正确的显示过滤逻辑 ---
    const dayMap = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const currentDayCycle = dayMap[now.getDay()]; // 'sun', 'mon', etc.
    const todayString = getTodayString();

    const tasksToShow = tasksToRender.filter(task => {
        // 如果是从未来计划移来的，在被清理前总是显示
        if (task.fromFuture) return true; 

        const cycle = task.cycle || 'daily'; // 兼容旧数据
        
        if (cycle === 'daily') return true; // 每日任务总是显示
        if (cycle === 'once') return task.creationDate === todayString; // 不重复任务仅在创建日显示
        return cycle === currentDayCycle; // 每周任务仅在对应星期几显示
    });
    // --- 过滤逻辑结束 ---

    dailyTaskList.innerHTML = '';
    const fragment = document.createDocumentFragment();
    tasksToShow.forEach((task) => {
        const originalIndex = allTasks.daily.findIndex(t => t.id === task.id);
        if (originalIndex === -1 && !task.id) {
            console.warn("Daily task missing ID, cannot determine originalIndex:", task);
        }
        const li = document.createElement('li');
        li.className = 'li-daily';
        if (task.completed) { li.classList.add('completed'); }
        
        if (task.cycle === 'once' || task.fromFuture) {
            li.classList.add('is-once'); 
            if (task.fromFuture) {
                li.title = '到期的计划任务 (次日将自动消失)';
            }
        }

        li.addEventListener('click', (e) => {
            if (e.target.closest('a, button, input, .checkbox, .drag-handle')) {
                return;
            }
            const isExpanded = li.classList.toggle('is-expanded');
            if (isExpanded) {
                dailyTaskList.querySelectorAll('li.is-expanded').forEach(item => {
                    if (item !== li) item.classList.remove('is-expanded');
                });
            }
        });

        li.appendChild(createDragHandle());
        
        const taskContent = createTaskContent(task, originalIndex, 'daily', false);
        
        if (task.cycle === 'once' && task.creationDate) {
            const dateMarker = document.createElement('span');
            dateMarker.className = 'once-date-marker';
            dateMarker.textContent = task.creationDate.substring(5); // 显示 MM-DD
            dateMarker.title = `创建于 ${task.creationDate}`;
            const titleGroup = taskContent.querySelector('.task-title-group');
            if(titleGroup) titleGroup.appendChild(dateMarker);
        }
        
        li.appendChild(taskContent);
        fragment.appendChild(li);
    });
    dailyTaskList.appendChild(fragment);
    
    handleCompletionCelebration(
        'daily',
        tasksToShow,
        dailyTaskList,
        '太棒了，您完成了今日的所有任务！'
    );
renderProgressTracker('daily', tasksToShow);
}
// --- END OF REPLACEMENT ---
function renderMonthlyTasks(dataToRender, isHistoryView) {
    if (!monthlyTaskList) return;

    // --- 1. 更新头部UI ---
    if (isHistoryView) {
        monthlyHeaderTitle.innerHTML = `本月待办 <span class="header-date">(${selectedMonthlyDisplayMonth})</span>`;
        if (monthlyHistoryBtn) monthlyHistoryBtn.innerHTML = `<img src="images/icon-back.svg" alt="Back">`;
        if (monthlyHistoryBtn) monthlyHistoryBtn.title = '返回当月视图';
    } else {
        const now = new Date();
        monthlyHeaderTitle.innerHTML = `本月待办 <span class="header-date">(${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')})</span>`;
        if (monthlyHistoryBtn) monthlyHistoryBtn.innerHTML = `<img src="images/icon-history.svg" alt="History">`;
        if (monthlyHistoryBtn) monthlyHistoryBtn.title = '查看历史记录';
    }
    if (monthlyInputArea) monthlyInputArea.style.display = isHistoryView ? 'none' : 'grid';

    // --- 2. 清空并准备渲染 ---
    monthlyTaskList.innerHTML = '';
    const fragment = document.createDocumentFragment();
    
    const tasksToDisplay = Array.isArray(dataToRender) ? dataToRender : [];
    const filteredMonthlyTasks = tasksToDisplay.filter(task => currentMonthlyTagFilter === 'all' || (task.tags && task.tags.includes(currentMonthlyTagFilter)));
    
    // --- 3. 遍历任务并创建DOM元素 ---
    filteredMonthlyTasks.forEach((task) => {
        const li = document.createElement('li');
        li.className = 'li-monthly';
        if (task.completed) li.classList.add('completed');
        if (isHistoryView) li.classList.add('is-history-item');
        
        const originalIndex = isHistoryView 
            ? (allTasks.history[selectedMonthlyDisplayMonth] || []).findIndex(t => t.id === task.id) 
            : allTasks.monthly.findIndex(t => t.id === task.id);

        if (!isHistoryView && originalIndex > -1 && allTasks.monthly[originalIndex]) { 
            updateMonthlyTaskProgress(allTasks.monthly[originalIndex]);
        }
        
        // --- 添加点击事件以展开/折叠 ---
        li.addEventListener('click', (e) => {
            // 【关键修改】忽略对拖拽手柄的点击
            if (e.target.closest('a, button, input, .checkbox, .drag-handle')) {
                return;
            }
            const isExpanded = li.classList.toggle('is-expanded');
            if (isExpanded) {
                monthlyTaskList.querySelectorAll('li.is-expanded').forEach(item => {
                    if (item !== li) item.classList.remove('is-expanded');
                });
            }
        });
        
        const progressBar = document.createElement('div');
        progressBar.className = 'progress-bar';
        progressBar.style.width = `${task.progress || 0}%`;
        li.appendChild(progressBar);
        
        // --- 保留拖拽手柄的创建 ---
        if (!isHistoryView) {
            li.appendChild(createDragHandle());
        }
        
        // --- 正确地附加由 createTaskContent 创建的完整内容 ---
        // createTaskContent 内部已经包含了隐藏的详情面板和操作按钮
        li.appendChild(createTaskContent(task, originalIndex, 'monthly', isHistoryView));
        
        fragment.appendChild(li);
    });

    // --- 4. 将所有创建的元素一次性添加到DOM ---
    monthlyTaskList.appendChild(fragment);

    // --- 5. 全局事件监听器（无需修改） ---
    if (!document.body.dataset.sortModeExitListenerAttached) {
        document.body.addEventListener('click', (e) => {
            if (monthlyTaskList && !e.target.closest('.task-list.sort-mode-active')) {
                exitSortMode();
            }
        });
        document.body.dataset.sortModeExitListenerAttached = 'true';
    }

    // --- 6. 【新增】处理祝贺信息 ---
    // 注意：只在非历史视图下显示祝贺信息
    if (!isHistoryView) {
        const currentMonthlyData = getMonthlyDataForDisplay(); // 获取当前月份的完整数据
        handleCompletionCelebration(
            'monthly',
            currentMonthlyData, // 检查的是当前月份的完整任务列表
            monthlyTaskList,
            '太棒了，您完成了本月的所有任务！'
        );
    } else {
        // 如果是历史视图，确保移除可能存在的祝贺信息
        handleCompletionCelebration('monthly', [], monthlyTaskList, '');
    }
if (!isHistoryView) {
    // We pass the complete, unfiltered list of tasks for the current month
    // to accurately calculate the overall progress.
    renderProgressTracker('monthly', getMonthlyDataForDisplay());
} else {
    // For history views, ensure any tracker is hidden.
    const tracker = document.getElementById('monthly-progress-tracker');
    if (tracker) tracker.style.display = 'none';
}
}

// 在 app.js 中，用这个版本替换掉你原来的 renderFutureTasks 函数
function renderFutureTasks(tasksToRender) {
    if (!futureTaskList) return;
    futureTaskList.innerHTML = '';
    const fragment = document.createDocumentFragment();
    
    const tasksToDisplay = Array.isArray(tasksToRender) ? tasksToRender : [];
    tasksToDisplay.sort((a, b) => {
        const timeA = a.reminderTime || (a.date ? new Date(a.date).getTime() : Infinity);
        const timeB = b.reminderTime || (b.date ? new Date(b.date).getTime() : Infinity);
        return timeA - timeB;
    });

    tasksToDisplay.forEach((task) => {
        const originalIndex = allTasks.future.findIndex(t => t.id === task.id); 
         if (originalIndex === -1 && !task.id) {
             console.warn("Future task missing ID, cannot determine originalIndex:", task);
        }
        const li = document.createElement('li');
        li.className = 'li-future';
        const isOverdue = (task.reminderTime && task.reminderTime < Date.now()) || (task.date && new Date(task.date + 'T23:59:59') < Date.now());
        if (isOverdue) { li.style.opacity = '0.6'; }
        
        li.appendChild(createDragHandle());
        const taskMainWrapper = document.createElement('div');
        taskMainWrapper.className = 'task-main-wrapper';
        const titleGroup = document.createElement('div');
        titleGroup.className = 'task-title-group';
        const taskText = document.createElement('span');
        taskText.className = 'task-text';
        taskText.textContent = task.text;
        titleGroup.appendChild(taskText);
        
        // ======================= 核心修改在此 =======================
        if (task.reminderTime && task.reminderTime > Date.now()) {
            const reminderSpan = document.createElement('span');
            reminderSpan.className = 'reminder-info';
            
            // 使用新函数格式化时间
            const formattedDateTime = formatReminderDateTime(task.reminderTime);

            // 同时创建铃铛图标和时间文本
            reminderSpan.innerHTML = `
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>
                <span class="reminder-datetime-text">${formattedDateTime}</span>
            `;

            const reminderDate = new Date(task.reminderTime);
            reminderSpan.title = `提醒于: ${reminderDate.toLocaleString()}`; // 保留桌面端的悬停提示
            titleGroup.appendChild(reminderSpan);

        } else if (task.date) {
        // ======================= 修改结束 =======================
            const dateSpan = document.createElement('span');
            dateSpan.className = 'task-date';
            dateSpan.textContent = task.date.substring(5); 
            titleGroup.appendChild(dateSpan);
        }
        taskMainWrapper.appendChild(titleGroup);
        
        if (task.links && task.links.length > 0) {
            const linksContainer = createLinkPills(task, 'future', originalIndex);
            taskMainWrapper.appendChild(linksContainer);
        }
        
        const taskActions = createTaskActions(task, 'future', originalIndex, false);
        li.appendChild(taskMainWrapper);
        li.appendChild(taskActions);
        fragment.appendChild(li);
    });
    futureTaskList.appendChild(fragment);
}

function renderLedger(dataToRender, isHistoryView) {
    if (!ledgerList) return;
    const currency = allTasks.currencySymbol || '$';
    if (ledgerAmountInput) ledgerAmountInput.placeholder = `金额 (${currency})`;

    if (isHistoryView) {
        if (ledgerHeaderTitle) ledgerHeaderTitle.innerHTML = `记账本 <span class="header-date">(${selectedLedgerMonth})</span>`;
        if (ledgerHistoryBtn) {
             ledgerHistoryBtn.innerHTML = `<img src="images/icon-back.svg" alt="Back">`;
             ledgerHistoryBtn.title = '返回当前账本';
        }
        if (setBudgetBtn) setBudgetBtn.style.display = 'none';
        if (annualReportBtn) annualReportBtn.style.display = 'none';
        if (currencyPickerBtn) currencyPickerBtn.style.display = 'none';
    } else {
        if (ledgerHeaderTitle) ledgerHeaderTitle.textContent = '记账本';
        if (ledgerHistoryBtn) {
            ledgerHistoryBtn.innerHTML = `<img src="images/icon-history.svg" alt="History">`;
            ledgerHistoryBtn.title = '查看历史记录';
        }
        if (setBudgetBtn) setBudgetBtn.style.display = 'inline-block';
        if (annualReportBtn) annualReportBtn.style.display = 'inline-block';
        if (currencyPickerBtn) currencyPickerBtn.style.display = 'inline-block';
    }

    if (ledgerInputArea) ledgerInputArea.style.display = isHistoryView ? 'none' : 'flex';
    
    const header = ledgerList.querySelector('.ledger-header'); 
    ledgerList.innerHTML = ''; 
    if (header) ledgerList.appendChild(header); 

    const fragment = document.createDocumentFragment();
    const labels = { date: '日期：', item: '项目：', amount: '金额：', payment: '付款方式：', details: '详情：' };
    
    const entriesToDisplay = Array.isArray(dataToRender) ? dataToRender : [];
    const filteredLedger = entriesToDisplay.filter(entry => currentLedgerFilter === 'all' || entry.item === currentLedgerFilter);
    
    filteredLedger.sort((a, b) => new Date(b.date) - new Date(a.date)); 

    filteredLedger.forEach((entry) => {
        const li = document.createElement('li');
        li.className = 'ledger-item';
        
        const index = isHistoryView 
            ? (allTasks.ledgerHistory[selectedLedgerMonth] || []).findIndex(item => 
                item.date === entry.date && 
                item.item === entry.item && 
                item.amount === entry.amount && 
                item.payment === entry.payment && 
                item.details === entry.details
              ) 
            : allTasks.ledger.indexOf(entry); 

        if (isHistoryView) li.classList.add('is-history-item');
        if (!isHistoryView) li.appendChild(createDragHandle());
        
        const contentWrapper = document.createElement('div');
        contentWrapper.className = 'ledger-content-wrapper';
        
        Object.keys(labels).forEach(key => {
            const span = document.createElement('span');
            span.setAttribute('data-label', labels[key]); 
            span.textContent = (key === 'amount') 
                ? `${currency} ${parseFloat(entry[key] || 0).toFixed(2)}` 
                : (entry[key] || '-');
            contentWrapper.appendChild(span);
        });
        
        li.appendChild(contentWrapper);
        li.appendChild(createTaskActions(entry, 'ledger', index, isHistoryView));
        fragment.appendChild(li);
    });
    ledgerList.appendChild(fragment);
}
function createTaskContent(task, index, type, isHistoryView) {
    const taskContent = document.createElement('div');
    taskContent.className = 'task-content';
    
    // 1. 创建始终可见的顶层区域
    const mainVisibleArea = document.createElement('div');
    mainVisibleArea.className = 'task-main-visible-area';

    // 2. 创建标题组
    const titleGroup = document.createElement('div');
    titleGroup.className = 'task-title-group';
    
    // -- 复选框 --
    if (type === 'daily' || type === 'monthly') {
        const checkbox = document.createElement('span');
        checkbox.className = 'checkbox';
        if (!isHistoryView) {
            checkbox.addEventListener('click', (e) => {
                e.stopPropagation();
                let taskToUpdate;
                if (type === 'daily' && index > -1 && allTasks.daily[index]) { 
                    taskToUpdate = allTasks.daily[index];
                } else if (type === 'monthly' && index > -1 && allTasks.monthly[index]) {
                    taskToUpdate = allTasks.monthly[index];
                } else { return; }
                
                taskToUpdate.completed = !taskToUpdate.completed;
                if(type === 'monthly'){
                    updateMonthlyTaskProgress(taskToUpdate);
                }
                saveTasks();
                renderAllLists();
            });
        } else {
            checkbox.style.cursor = 'default';
        }
        titleGroup.appendChild(checkbox);
    }
    
    // -- 优先级指示器 (仅月度) --
    if (type === 'monthly' && task && !isHistoryView && task.priority !== undefined) {
        const priorityIndicator = document.createElement('span');
        priorityIndicator.className = 'priority-indicator';
        const prioritySymbols = { 1: '!', 2: '!!', 3: '!!!' };
        const currentPriority = task.priority || 2;

        priorityIndicator.textContent = prioritySymbols[currentPriority];
        priorityIndicator.classList.add(`priority-${currentPriority === 3 ? 'high' : currentPriority === 2 ? 'medium' : 'low'}`);
        priorityIndicator.style.cursor = 'pointer';
        priorityIndicator.title = `点击修改优先级 (当前: ${currentPriority === 3 ? '高' : currentPriority === 2 ? '中' : '低'})`;
        
        priorityIndicator.addEventListener('click', (e) => {
            e.stopPropagation();
            if (index > -1 && allTasks.monthly[index]) { 
                let newPriority = (allTasks.monthly[index].priority || 2) + 1;
                if (newPriority > 3) newPriority = 1; 
                allTasks.monthly[index].priority = newPriority;
                saveTasks();
                renderAllLists();
            }
        });
        titleGroup.appendChild(priorityIndicator);
    }
    
    // -- 标签 (仅月度) --
    if (type === 'monthly' && task && task.tags && task.tags.length > 0) { 
        titleGroup.appendChild(createTaskTags(task.tags));
    }

    // -- 任务文本 --
    const taskText = document.createElement('span');
    taskText.className = 'task-text';
    taskText.textContent = task ? task.text : '';
    titleGroup.appendChild(taskText);
    
    // -- 完成日期标记 (仅月度) --
    if (type === 'monthly' && task && task.completed && task.completionDate) {
        const completionMarker = document.createElement('div');
        completionMarker.className = 'completion-date-marker';
        completionMarker.innerHTML = `✓ ${task.completionDate}`;
        completionMarker.title = `完成于 ${task.completionDate}`;
        titleGroup.appendChild(completionMarker);
    }
    
    mainVisibleArea.appendChild(titleGroup);

    // 3. 创建元信息提示图标区域 (在标题组旁边)
    const metaIndicators = document.createElement('div');
    metaIndicators.className = 'task-meta-indicators';

    // -- 子任务提示图标 (仅月度) --
    if (type === 'monthly' && task && task.subtasks && task.subtasks.length > 0) {
        const completedCount = task.subtasks.filter(st => st.completed).length;
        const subtaskIndicator = document.createElement('span');
        subtaskIndicator.innerHTML = `<img src="images/icon-subtask.svg" alt="Subtasks"> ${completedCount}/${task.subtasks.length}`;
        subtaskIndicator.title = `子任务进度: ${completedCount}/${task.subtasks.length}`;
        metaIndicators.appendChild(subtaskIndicator);
    }

    // -- 备注提示图标 (所有类型) --
    const noteTextValue = (type === 'daily' && task) ? task.note : (task ? task.progressText : null);
    if (noteTextValue && noteTextValue.trim() !== '') {
        const noteIndicator = document.createElement('span');
        noteIndicator.innerHTML = `<img src="images/icon-note.svg" alt="Note">`;
        noteIndicator.title = '有备注';
        metaIndicators.appendChild(noteIndicator);
    }
    
    // -- 链接提示图标 (所有类型) --
    if (task && task.links && task.links.length > 0) {
        const linkIndicator = document.createElement('span');
        linkIndicator.innerHTML = `<img src="images/icon-link.svg" alt="Links"> ${task.links.length}`;
        linkIndicator.title = `有 ${task.links.length} 个链接`;
        metaIndicators.appendChild(linkIndicator);
    }
    
    mainVisibleArea.appendChild(metaIndicators);
    taskContent.appendChild(mainVisibleArea);

    // 4. 创建可折叠的详情面板
    const detailsPane = document.createElement('div');
    detailsPane.className = 'task-details-pane';

    // -- 完整的备注内容 --
    if (noteTextValue && noteTextValue.trim() !== '') {
        const noteDisplayDiv = document.createElement('div');
        noteDisplayDiv.className = 'note-display-text';
        noteDisplayDiv.textContent = noteTextValue;
        detailsPane.appendChild(noteDisplayDiv);
    }

    // -- 完整的链接列表 (每日和月度都有) --
    // 【修改】之前每日清单的链接在外面，现在统一放入详情面板
    if (task && task.links && task.links.length > 0) {
        // 使用一个统一的容器来放链接胶囊
        const linksWrapper = document.createElement('div');
        linksWrapper.className = 'links-wrapper'; // 新增一个类，方便加样式
        linksWrapper.appendChild(createLinkPills(task, type, index));
        detailsPane.appendChild(linksWrapper);
    }

    // -- 完整的子任务列表和输入框 (仅月度) --
    if (type === 'monthly') {
        if (task && task.subtasks && task.subtasks.length > 0) {
            detailsPane.appendChild(createSubtaskList(task, index, isHistoryView));
        }
        if (!isHistoryView && index > -1) {
            detailsPane.appendChild(createSubtaskInput(index));
        }
    }

    // -- 完整的操作按钮工具栏 --
    detailsPane.appendChild(createTaskActions(task, type, index, isHistoryView));
    
    taskContent.appendChild(detailsPane);

    return taskContent;
}

function sortMonthlyTasksByPriority() {
    if (selectedMonthlyDisplayMonth === 'current' && allTasks.monthly && allTasks.monthly.length > 0) {
        allTasks.monthly.sort((a, b) => {
            const priorityA = a.priority || 2; 
            const priorityB = b.priority || 2;
            if (priorityB !== priorityA) { 
                return priorityB - priorityA; 
            }
            return 0; 
        });
        saveTasks();
        renderMonthlyTasks(allTasks.monthly, false);
    } else if (selectedMonthlyDisplayMonth !== 'current') {
        openCustomPrompt({title:"操作无效", message:"优先级排序仅适用于当前月份的待办任务。", inputType:'none', confirmText:'好的', hideCancelButton:true});
    }
}
function createSubtaskList(mainTask, mainTaskIndex, isHistoryView) {
    const ul = document.createElement('ul');
    ul.className = 'subtask-list';
    if (!mainTask || !mainTask.subtasks) return ul; 

    mainTask.subtasks.forEach((subtask, subtaskIndex) => {
        const li = document.createElement('li');
        li.className = 'subtask-item';
        if (subtask.completed) { li.classList.add('completed'); }
        const checkbox = document.createElement('span');
        checkbox.className = 'checkbox';
        if (isHistoryView) {
            checkbox.style.cursor = 'default';
        } else {
            checkbox.addEventListener('click', (e) => {
                e.stopPropagation();
                if (mainTaskIndex > -1 && allTasks.monthly[mainTaskIndex] && allTasks.monthly[mainTaskIndex].subtasks[subtaskIndex]) {
                    const targetSubtask = allTasks.monthly[mainTaskIndex].subtasks[subtaskIndex];
                    targetSubtask.completed = !targetSubtask.completed;
                    updateMonthlyTaskProgress(allTasks.monthly[mainTaskIndex]);
                    saveTasks();
                    renderAllLists();
                }
            });
        }
        const textSpan = document.createElement('span');
        textSpan.className = 'task-text';
        textSpan.textContent = subtask.text;
        li.appendChild(checkbox);
        li.appendChild(textSpan);
        if (!isHistoryView) {
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'action-btn delete-btn'; 
            deleteBtn.innerHTML = '×';
            deleteBtn.title = '删除子任务';
            deleteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (mainTaskIndex > -1 && allTasks.monthly[mainTaskIndex] && allTasks.monthly[mainTaskIndex].subtasks) {
                    allTasks.monthly[mainTaskIndex].subtasks.splice(subtaskIndex, 1);
                    updateMonthlyTaskProgress(allTasks.monthly[mainTaskIndex]);
                    saveTasks();
                    renderAllLists();
                }
            });
            li.appendChild(deleteBtn);
        }
        ul.appendChild(li);
    });
    return ul;
}
function createSubtaskInput(mainTaskIndex) { 
    const div = document.createElement('div'); 
    div.className = 'subtask-input-area'; 
    const input = document.createElement('input'); 
    input.type = 'text'; 
    input.placeholder = '添加子任务...'; 
    const btn = document.createElement('button'); 
    btn.textContent = '+'; 
    btn.title = '添加子任务'; 
    btn.addEventListener('click', (e) => { 
        e.stopPropagation(); 
        const text = input.value.trim(); 
        if (text && mainTaskIndex > -1 && allTasks.monthly[mainTaskIndex]) { 
            if(!allTasks.monthly[mainTaskIndex].subtasks) { 
                allTasks.monthly[mainTaskIndex].subtasks = []; 
            } 
            allTasks.monthly[mainTaskIndex].subtasks.push({ text: text, completed: false }); 
            updateMonthlyTaskProgress(allTasks.monthly[mainTaskIndex]); 
            input.value = ''; 
            saveTasks(); 
            renderAllLists(); 
        } 
    }); 
    input.addEventListener('keypress', (e) => { if (e.key === 'Enter') btn.click(); }); 
    div.appendChild(input); 
    div.appendChild(btn); 
    return div; 
}
function updateMonthlyTaskProgress(task) { 
    if (task && task.subtasks && task.subtasks.length > 0) { 
        const completedCount = task.subtasks.filter(st => st.completed).length; 
        const totalCount = task.subtasks.length; 
        const newProgress = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0; 
        const wasCompleted = task.completed; 
        task.progress = newProgress; 
        task.completed = totalCount > 0 && completedCount === totalCount; 
        if (task.completed && !wasCompleted) { 
            task.completionDate = getTodayString(); 
        } else if (!task.completed && wasCompleted) { 
            task.completionDate = null; 
        } 
    } else if (task) { 
        task.progress = task.completed ? 100 : 0;
        if (task.completed && !task.completionDate) { 
            task.completionDate = getTodayString();
        } else if (!task.completed) {
            task.completionDate = null;
        }
    }
}
function renderMonthlyTags(dataToRender) { 
    if (!monthlyTagsContainer) return; 
    monthlyTagsContainer.innerHTML = ''; 
    const tasks = Array.isArray(dataToRender) ? dataToRender : []; 
    const allTags = new Set(tasks.flatMap(task => task.tags || [])); 
    if (allTags.size === 0 && tasks.length > 0) { 
         createTagButton('全部', 'all', currentMonthlyTagFilter, monthlyTagsContainer, (filter) => { currentMonthlyTagFilter = filter; renderAllLists(); });
         return;
    }
    if (allTags.size === 0) return; 
    
    createTagButton('全部', 'all', currentMonthlyTagFilter, monthlyTagsContainer, (filter) => { currentMonthlyTagFilter = filter; renderAllLists(); }); 
    [...allTags].sort().forEach(tag => { 
        createTagButton(tag, tag, currentMonthlyTagFilter, monthlyTagsContainer, (filter) => { currentMonthlyTagFilter = filter; renderAllLists(); }); 
    }); 
}
function renderLedgerTags(dataToRender) { 
    if (!ledgerTagsContainer) return; 
    ledgerTagsContainer.innerHTML = ''; 
    const entries = Array.isArray(dataToRender) ? dataToRender : []; 
    const items = [...new Set(entries.map(entry => entry.item))].filter(Boolean); 
    if (items.length === 0 && entries.length > 0) { 
        createTagButton('全部', 'all', currentLedgerFilter, ledgerTagsContainer, (filter) => { currentLedgerFilter = filter; renderAllLists(); });
        return;
    }
    if (items.length === 0) return; 

    createTagButton('全部', 'all', currentLedgerFilter, ledgerTagsContainer, (filter) => { currentLedgerFilter = filter; renderAllLists(); }); 
    items.sort().forEach(item => { 
        createTagButton(item, item, currentLedgerFilter, ledgerTagsContainer, (filter) => { currentLedgerFilter = filter; renderAllLists(); }); 
    }); 
}
function createTagButton(text, filterValue, currentFilter, container, onClick) { const btn = document.createElement('button'); btn.className = 'tag-button'; btn.textContent = text; if (currentFilter === filterValue) { btn.classList.add('active'); } btn.addEventListener('click', () => onClick(filterValue)); container.appendChild(btn); }
function createTaskTags(tags) { const container = document.createElement('div'); container.className = 'tags-on-task'; tags.forEach(tag => { const span = document.createElement('span'); span.className = 'task-tag-pill'; span.textContent = tag; container.appendChild(span); }); return container; }
function renderFeaturesList() {
    if (!featuresListUl) return;

    // 1. 清空现有列表
    featuresListUl.innerHTML = '';

    // --- START OF REFACTOR ---

    // 2. 提前处理版本号的获取和插入逻辑
    const featuresModalContent = featuresListUl.closest('.features-modal-content');
    const titleElement = featuresModalContent?.querySelector('h2');

    // a. 先移除可能存在的旧版本信息元素，以防重复添加
    const oldVersionInfo = featuresModalContent?.querySelector('.features-version-info');
    if (oldVersionInfo) {
        oldVersionInfo.remove();
    }
    
    // b. 创建版本号元素
    const versionLi = document.createElement('p'); // 使用 <p> 标签更语义化
    versionLi.className = 'features-version-info'; // 保持类名以便应用样式
    
    // c. 异步获取 manifest.json 中的版本号
    fetch('manifest.json')
        .then(response => {
            if (!response.ok) throw new Error('Network response was not ok');
            return response.json();
        })
        .then(manifest => {
            const manifestVersion = manifest.version || "未知";
            versionLi.innerHTML = `<strong>当前版本:</strong> ${manifestVersion}`;
        })
        .catch(e => {
            console.warn("无法从 manifest.json 获取版本号，将使用默认值。错误:", e);
            versionLi.innerHTML = `<strong>当前版本:</strong> 4.2.0`; // 提供一个硬编码的备用版本号
        })
        .finally(() => {
            // d. 无论成功与否，都将版本号元素插入到标题后面
            if (titleElement && titleElement.nextSibling) {
                titleElement.parentNode.insertBefore(versionLi, titleElement.nextSibling);
            } else if (titleElement) {
                titleElement.parentNode.appendChild(versionLi);
            }
        });

    // --- END OF REFACTOR ---


    // 3. 渲染主要的功能列表 (这部分逻辑保持不变)
    features.forEach(feature => {
        const li = document.createElement('li');
        li.innerHTML = `<strong>${feature.title}:</strong> ${feature.description}`;
        featuresListUl.appendChild(li);
    });
    
    // 4. 渲染更新历史 (这部分逻辑也保持不变)
    const sortedVersions = Object.keys(versionUpdateNotes).sort((a, b) => {
        const partsA = a.split('.').map(Number);
        const partsB = b.split('.').map(Number);
        for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
            const valA = partsA[i] || 0;
            const valB = partsB[i] || 0;
            if (valA !== valB) return valB - valA; 
        }
        return 0;
    });
    
    sortedVersions.forEach(versionKey => {
        const notes = versionUpdateNotes[versionKey];
        if (notes && notes.length > 0) {
            const updateTitleLi = document.createElement('li');
            updateTitleLi.className = 'features-update-title'; 
            updateTitleLi.innerHTML = `<strong>版本 ${versionKey} 更新亮点:</strong>`;
            featuresListUl.appendChild(updateTitleLi);
            
            const updatesSubList = document.createElement('ul');
            updatesSubList.className = 'features-update-list'; 
            notes.forEach(note => {
                const noteLi = document.createElement('li');
                let formattedNote = note.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
                formattedNote = formattedNote.replace(/^( {4,}|\t+)(.*)/gm, (match, p1, p2) => {
                    return `<span style="display: block; margin-left: ${p1.length * 0.5}em;">- ${p2}</span>`;
                });
                noteLi.innerHTML = formattedNote;
                updatesSubList.appendChild(noteLi);
            });
            featuresListUl.appendChild(updatesSubList);
        }
    });

    // 5. 移除原来在列表末尾添加版本号的代码
    // (这段逻辑已经被我们移动到函数开头了)
}

function hideFeaturesModal() { if (featuresModal) { featuresModal.classList.add('hidden'); } }
function showFeaturesModal() { if(featuresModal) { renderFeaturesList(); featuresModal.classList.remove('hidden'); } }
function showFaqModal() { 
    if(!faqListDiv) return;
    faqListDiv.innerHTML = '';
    faqs.forEach(faq => {
        const item = document.createElement('div');
        item.className = 'faq-item';
        item.innerHTML = `<div class="faq-question">${faq.question}</div><div class="faq-answer">${faq.answer}</div>`;
        faqListDiv.appendChild(item);
    });
    if(faqModal) faqModal.classList.remove('hidden');
}
function hideFaqModal() { if (faqModal) faqModal.classList.add('hidden'); }
function initSortable() {
    const onDragEnd = (dataArray, evt, listType) => {
        if (!Array.isArray(dataArray)) {
            console.error("Sortable onEnd: dataArray is not an array for", listType, dataArray);
            return;
        }
        if (evt.oldIndex === undefined || evt.newIndex === undefined || evt.oldIndex < 0 || evt.newIndex < 0) {
            console.error("Sortable onEnd: invalid oldIndex or newIndex for", listType, evt);
            return;
        }

        const [movedItem] = dataArray.splice(evt.oldIndex, 1);
        dataArray.splice(evt.newIndex, 0, movedItem);
        saveTasks();
        
        if (listType === 'ledger') { 
            renderLedger(allTasks.ledger, selectedLedgerMonth !== 'current'); 
        }
    };

    const sortableOptions = { 
        animation: 150, 
        ghostClass: 'sortable-ghost', 
        handle: '.drag-handle' 
    };

    if(dailyTaskList) new Sortable(dailyTaskList, { ...sortableOptions, onEnd: (evt) => onDragEnd(allTasks.daily, evt, 'daily') });
    if(futureTaskList) new Sortable(futureTaskList, { ...sortableOptions, onEnd: (evt) => onDragEnd(allTasks.future, evt, 'future') });
    
    if(monthlyTaskList) new Sortable(monthlyTaskList, { 
        ...sortableOptions, 
        onEnd: (evt) => { 
            if (selectedMonthlyDisplayMonth === 'current') { 
                onDragEnd(allTasks.monthly, evt, 'monthly'); 
            } 
        } 
    });
    
    if(ledgerList) new Sortable(ledgerList, { 
        ...sortableOptions, 
        filter: '.ledger-header', 
        onEnd: (evt) => { 
            if (selectedLedgerMonth === 'current') { 
                onDragEnd(allTasks.ledger, evt, 'ledger'); 
            } 
        } 
    });
}
function createLinkPills(task, type, taskIndex) { 
    const container = document.createElement('div'); 
    container.className = 'links-container'; 
    if (task && task.links && task.links.length > 0) {  
        task.links.forEach((link, linkIndex) => { 
            if (!link) return; 
            const pill = document.createElement('a'); 
            pill.className = 'link-pill'; 
            pill.href = link; 
            pill.target = '_blank'; 
            pill.title = `打开链接: ${link}`; 
            
            const linkTextSpan = document.createElement('span'); 
            try { 
                const url = new URL(link); 
                linkTextSpan.textContent = url.hostname.replace(/^www\./, ''); 
            } catch (e) { 
                linkTextSpan.textContent = link.length > 20 ? link.substring(0, 17) + '...' : link; 
            } 
            pill.appendChild(linkTextSpan); 
            
            if (type !== 'history') { 
                const deleteLinkBtn = document.createElement('button'); 
                deleteLinkBtn.className = 'delete-link-btn'; 
                deleteLinkBtn.innerHTML = '×'; 
                deleteLinkBtn.title = '删除此链接'; 
                deleteLinkBtn.addEventListener('click', (e) => { 
                    e.preventDefault(); 
                    e.stopPropagation(); 
                    
                    let targetTask;
                    if(type === 'daily' && taskIndex > -1 && allTasks.daily[taskIndex]) targetTask = allTasks.daily[taskIndex];
                    else if(type === 'monthly' && taskIndex > -1 && allTasks.monthly[taskIndex]) targetTask = allTasks.monthly[taskIndex];
                    else if(type === 'future' && taskIndex > -1 && allTasks.future[taskIndex]) targetTask = allTasks.future[taskIndex];

                    if (targetTask && targetTask.links) { 
                        targetTask.links.splice(linkIndex, 1); 
                        saveTasks(); 
                        renderAllLists(); 
                    } 
                }); 
                pill.appendChild(deleteLinkBtn); 
            } 
            container.appendChild(pill); 
        }); 
    } 
    return container; 
}
function archiveSingleItem(type, index) {
    const sourceArrayName = type;
    const historyArrayName = type === 'monthly' ? 'history' : 'ledgerHistory';
    
    if (!allTasks || !allTasks[sourceArrayName]) {
        console.error(`归档失败：源数组 allTasks.${sourceArrayName} 未定义。`);
        return;
    }
    const sourceArray = allTasks[sourceArrayName];

    if (index < 0 || index >= sourceArray.length) { 
        console.error("归档失败：无效的索引。", type, index, sourceArray.length); 
        return; 
    }
    
    const itemToArchive = JSON.parse(JSON.stringify(sourceArray[index]));

    openCustomPrompt({
        title: `选择归档日期`, 
        message: `请为要归档的${type === 'monthly' ? '任务' : '记录'}选择一个完成/记录日期。\n该日期不能是未来。`, 
        inputType: 'date', 
        initialValue: getTodayString(), 
        confirmText: '确认归档',
        onConfirm: (selectedDate) => {
            const todayString = getTodayString();
            if (!selectedDate || selectedDate > todayString) {
                openCustomPrompt({ 
                    title: "日期无效", 
                    message: `选择的日期 (${selectedDate}) 不能是未来。\n\n请选择今天或之前的日期。`, 
                    inputType: 'none', 
                    confirmText: '好的，重试', 
                    hideCancelButton: true, 
                    onConfirm: () => archiveSingleItem(type, index) 
                });
                return false; 
            }
            const targetMonth = selectedDate.substring(0, 7); 
            
            if (type === 'monthly') {
                itemToArchive.completionDate = selectedDate;
                if (!itemToArchive.completed) { 
                    itemToArchive.completed = true; 
                    itemToArchive.progress = 100; 
                    if (itemToArchive.subtasks && itemToArchive.subtasks.length > 0) {
                        itemToArchive.subtasks.forEach(st => st.completed = true);
                    }
                }
            } else { 
                itemToArchive.date = selectedDate; 
            }
            
            if (!allTasks[historyArrayName]) { allTasks[historyArrayName] = {}; } 
            if (!allTasks[historyArrayName][targetMonth]) { allTasks[historyArrayName][targetMonth] = []; }
            
            allTasks[historyArrayName][targetMonth].unshift(itemToArchive); 
            sourceArray.splice(index, 1); 
            
            saveTasks();
            renderAllLists();
            openCustomPrompt({ 
                title: "归档成功", 
                message: `已成功将1条数据归档到 ${targetMonth}！`, 
                inputType: 'none', 
                confirmText: "好的", 
                hideCancelButton: true 
            });
        }
    });
}

function createTaskActions(task, type, index, isHistoryView) {
    const actionsContainer = document.createElement('div');
    actionsContainer.className = 'task-actions';
    if (!task) return actionsContainer;

    if (isHistoryView) {
        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'action-btn delete-btn';
        deleteBtn.innerHTML = '×';
        deleteBtn.title = '永久删除此历史条目';
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const historyArrayName = type === 'monthly' ? 'history' : 'ledgerHistory';
            const selectedMonth = type === 'monthly' ? selectedMonthlyDisplayMonth : selectedLedgerMonth;
            
            if (!allTasks[historyArrayName] || !allTasks[historyArrayName][selectedMonth]) {
                console.error("无法删除：找不到对应的历史月份数组。"); 
                return;
            }
            const historyArray = allTasks[historyArrayName][selectedMonth];
            
            openCustomPrompt({
                title: '确认删除', 
                message: `您确定要永久删除这条历史记录吗？\n“${task.text || task.item}”`, 
                inputType: 'none', 
                confirmText: '确认删除', 
                cancelText: '取消',
                onConfirm: () => {
                    let realIndex = -1;
                    if (type === 'monthly' && task.id) { 
                        realIndex = historyArray.findIndex(item => item.id === task.id);
                    } else { 
                        realIndex = index; 
                    }

                    if (realIndex > -1 && realIndex < historyArray.length) {
                        historyArray.splice(realIndex, 1);
                        if (historyArray.length === 0) {
                            delete allTasks[historyArrayName][selectedMonth]; 
                        }
                        saveTasks();
                        renderAllLists();
                    } else { 
                        console.error("删除失败：未在历史记录中找到该条目或索引无效。", task, realIndex, historyArray); 
                    }
                }
            });
        });
        actionsContainer.appendChild(deleteBtn);
        return actionsContainer;
    }

    if (type === 'daily' || type === 'monthly') {
        const noteBtn = document.createElement('button');
        noteBtn.className = 'action-btn note-btn';
        noteBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`;
        const noteText = (type === 'daily') ? (task.note || '') : (task.progressText || '');
        if (noteText) { 
            noteBtn.title = `编辑备注: ${noteText.substring(0,20)}${noteText.length > 20 ? '...' : ''}`; 
            noteBtn.classList.add('has-note'); 
        } else { 
            noteBtn.title = '添加备注'; 
        }
        noteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (index < 0) { console.warn("备注按钮的索引无效", type, index); return; } 
            const currentTask = (type === 'daily' ? allTasks.daily : allTasks.monthly)[index];
            if (!currentTask) { console.warn("未找到备注按钮对应的任务", type, index); return; }

            openCustomPrompt({
                title: noteText ? '编辑备注' : '添加备注', 
                inputType: 'textarea', 
                initialValue: noteText, 
                placeholder: '请输入备注内容...', 
                confirmText: '保存',
                onConfirm: (newNoteValue) => {
                    if (type === 'daily') currentTask.note = newNoteValue.trim();
                    else currentTask.progressText = newNoteValue.trim();
                    saveTasks();
                    renderAllLists();
                }
            });
        });
        actionsContainer.appendChild(noteBtn);
    }

    if (type === 'daily' || type === 'monthly' || type === 'future') {
        const editBtn = document.createElement('button');
        editBtn.className = 'action-btn edit-task-btn';
        editBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;
        editBtn.title = (type === 'monthly') ? '编辑任务和标签 (格式: 任务名_标签1,标签2)' : '编辑任务';
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (index < 0) { console.warn("编辑按钮的索引无效", type, index); return; }
            
            const li = e.target.closest('li');
            if (!li) return;
            const taskTextElement = li.querySelector('.task-text');
            if (!taskTextElement) return;

            const currentTaskArray = allTasks[type];
             if (!currentTaskArray || !currentTaskArray[index]) {
                console.warn("未找到编辑按钮对应的任务", type, index);
                renderAllLists(); // 重新渲染以确保UI一致性
                return;
            }
            const currentTask = currentTaskArray[index];
            
            let initialInputValue = currentTask.text;
            if (type === 'monthly' && currentTask.tags && currentTask.tags.length > 0) { 
                initialInputValue += `_${currentTask.tags.join(',')}`; 
            }
            
            const input = document.createElement('input');
            input.type = 'text';
            input.className = 'task-edit-input';
            input.value = initialInputValue;
            if (type === 'monthly') input.placeholder = '任务名_标签1,标签2...';
            
            const titleGroup = taskTextElement.parentElement;
            if (!titleGroup) return; 
            titleGroup.replaceChild(input, taskTextElement); // 用输入框替换文本
            input.focus();
            input.select(); // 选中内容方便编辑

            const saveEdit = () => {
                const newFullString = input.value.trim();
                if (!newFullString) { // 如果输入为空，则恢复原状或不作更改
                    renderAllLists(); // 简单地重新渲染
                    return; 
                }

                let finalTaskText = newFullString;
                let finalTags = type === 'monthly' ? [...(currentTask.tags || [])] : []; 

                if (type === 'monthly') {
                    const separatorIndex = newFullString.lastIndexOf('_');
                    // 确保下划线不是第一个或最后一个字符，且后面有内容
                    if (separatorIndex > 0 && separatorIndex < newFullString.length -1) { 
                        finalTaskText = newFullString.substring(0, separatorIndex).trim();
                        const tagsPart = newFullString.substring(separatorIndex + 1);
                        finalTags = tagsPart.trim() ? tagsPart.split(',').map(tag => tag.trim()).filter(Boolean) : [];
                    } else { 
                        finalTaskText = newFullString; // 没有有效分隔符，整个作为任务名
                    }
                }
                
                // 如果处理后任务文本为空，但原任务文本不为空，则保留原任务文本
                if (!finalTaskText && currentTask.text) finalTaskText = currentTask.text; 
                
                const textChanged = currentTask.text !== finalTaskText;
                const tagsChanged = type === 'monthly' ? (currentTask.tags || []).join(',') !== finalTags.join(',') : false;

                if (textChanged || tagsChanged) {
                    currentTask.text = finalTaskText;
                    if (type === 'monthly') currentTask.tags = finalTags;
                    
                    // 如果未来任务的文本被更改，并且它有提醒时间，通知SW
                    if (type === 'future' && currentTask.id && currentTask.reminderTime && textChanged && 
                        'serviceWorker' in navigator && navigator.serviceWorker.controller) {
                        console.log(`[PWA App] Sending UPDATE_REMINDER for future task ID ${currentTask.id} (text changed) to Service Worker.`);
                        navigator.serviceWorker.controller.postMessage({ type: 'UPDATE_REMINDER', payload: { task: currentTask } });
                    }
                    saveTasks();
                }
                renderAllLists(); // 无论是否更改都重新渲染，以移除输入框
            };

            // 处理输入框失焦和按键事件
            input.addEventListener('blur', saveEdit);
            input.addEventListener('keydown', (e) => { 
                if (e.key === 'Enter') input.blur(); // 回车保存
                else if (e.key === 'Escape') { // Esc 取消编辑
                    // 确保父节点存在再操作
                    if (titleGroup && input.parentNode === titleGroup) { 
                         titleGroup.replaceChild(taskTextElement, input); // 恢复原文本
                    }
                    // renderAllLists(); // 或者只恢复当前项，避免全列表刷新闪烁
                }
            });
        });
        actionsContainer.appendChild(editBtn);
    }

    // 链接按钮 (适用于每日、月度、未来任务)
    if (type === 'daily' || type === 'monthly' || type === 'future') {
        const linkBtn = document.createElement('button');
        linkBtn.className = 'action-btn link-btn';
        const hasLinks = task.links && task.links.length > 0;
        linkBtn.innerHTML = `<img src="${hasLinks ? 'images/icon-link.svg' : 'images/icon-add-link.svg'}" alt="Links">`;
        linkBtn.title = hasLinks ? `查看/添加链接 (${task.links.length}/5)` : "添加链接";
        linkBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (index < 0) { console.warn("链接按钮的索引无效", type, index); return; }
            
            const currentTaskArray = allTasks[type];
             if (!currentTaskArray || !currentTaskArray[index]) {
                console.warn("未找到链接按钮对应的任务", type, index);
                renderAllLists();
                return;
            }
            const currentTaskObject = currentTaskArray[index];

            if (!currentTaskObject.links) currentTaskObject.links = []; // 初始化链接数组
            if (currentTaskObject.links.length >= 5) { 
                openCustomPrompt({ title: "链接已达上限", message: "每个任务最多只能添加 5 条链接。", inputType: 'none', confirmText: "好的", hideCancelButton: true }); 
                return; 
            }
            openCustomPrompt({
                title: "添加网址链接", 
                inputType: 'url', 
                initialValue: 'https://', 
                placeholder: '请输入或粘贴网址', 
                confirmText: '添加',
                onConfirm: (newLinkValue) => {
                    const newLink = newLinkValue.trim();
                    if (newLink && newLink !== 'https://') { // 确保不是空的或默认值
                        try { 
                            new URL(newLink); // 验证 URL 格式
                            currentTaskObject.links.push(newLink); 
                            saveTasks(); 
                            renderAllLists(); 
                        } catch (err) { // URL 无效
                            openCustomPrompt({ title: "链接无效", message: `您输入的链接 "${newLink}" 格式不正确。请重新输入。`, inputType: 'none', confirmText: "好的", hideCancelButton: true }); 
                            return false; // 阻止 prompt 关闭
                        }
                    }
                }
            });
        });
        actionsContainer.appendChild(linkBtn);
    }

    // 归档按钮 (适用于月度和账本)
    if (type === 'monthly' || type === 'ledger') {
        const archiveBtn = document.createElement('button');
        archiveBtn.className = 'action-btn archive-btn';
        archiveBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v13H3V8"></path><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>`;
        archiveBtn.title = (type === 'monthly') ? '归档此任务' : '归档此记录';
        archiveBtn.addEventListener('click', (e) => { 
            e.stopPropagation(); 
            if (index < 0) { console.warn("归档按钮的索引无效", type, index); return; }
            archiveSingleItem(type, index); 
        });
        actionsContainer.appendChild(archiveBtn);
    }

    // 删除按钮 (适用于所有类型)
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'action-btn delete-btn';
    deleteBtn.innerHTML = '×';
    deleteBtn.title = (type === 'ledger') ? '删除此记录' : '删除此任务';
    deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (index < 0) { console.warn("删除按钮的索引无效", type, index); return; }

        // 如果删除的是一个设置了提醒的未来任务，通知 SW 取消提醒
        if (type === 'future' && task.id && task.reminderTime && 
            'serviceWorker' in navigator && navigator.serviceWorker.controller) {
            console.log(`[PWA App] Sending CANCEL_REMINDER for future task ID ${task.id} to Service Worker.`);
            navigator.serviceWorker.controller.postMessage({ type: 'CANCEL_REMINDER', payload: { taskId: task.id } });
        }
        
        const currentTaskArray = allTasks[type];
        if (currentTaskArray && currentTaskArray[index]) { 
            currentTaskArray.splice(index, 1);
            saveTasks();
            renderAllLists();
        } else {
            console.warn("删除操作失败：任务数组或指定索引处的任务未找到。", type, index);
            renderAllLists(); // 尝试重新渲染以同步状态
        }
    });
    actionsContainer.appendChild(deleteBtn);
    return actionsContainer;
}

function renderLedgerSummary(dataToRender) {
    if (!ledgerSummaryContainer) return;
    const summaryTitleText = ledgerSummaryContainer.querySelector('.summary-title');
    const now = new Date();
    const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const currency = allTasks.currencySymbol || '$';

    if (summaryTitleText) {
        if (selectedLedgerMonth === 'current') {
            summaryTitleText.textContent = `${currentMonthKey} 统计`;
        } else {
            summaryTitleText.textContent = `${selectedLedgerMonth} 统计`;
        }
    }

    const entriesToSummarize = Array.isArray(dataToRender) ? dataToRender : [];
    const totalExpense = entriesToSummarize.reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
    
    const ledgerSummaryTotal = ledgerSummaryContainer.querySelector('#ledger-summary-total');
    const ledgerSummaryBreakdown = ledgerSummaryContainer.querySelector('#ledger-summary-breakdown');
    
    if (!ledgerSummaryTotal || !ledgerSummaryBreakdown) return; 

    const categories = {};
    entriesToSummarize.forEach(entry => {
        const item = entry.item || '未分类';
        if (!categories[item]) categories[item] = 0;
        categories[item] += Number(entry.amount || 0);
    });
    const sortedCategories = Object.entries(categories)
                              .map(([name, amount]) => ({ name, amount }))
                              .sort((a, b) => b.amount - a.amount);

    ledgerSummaryBreakdown.innerHTML = ''; 

    if (totalExpense === 0 && sortedCategories.length === 0) {
        ledgerSummaryTotal.textContent = '暂无支出记录';
        ledgerSummaryTotal.classList.add('no-expense');
        ledgerSummaryContainer.style.display = 'none'; 
        return;
    }

    ledgerSummaryContainer.style.display = 'block'; 
    ledgerSummaryTotal.textContent = `${currency} ${totalExpense.toFixed(2)}`;
    ledgerSummaryTotal.classList.remove('no-expense');

    const monthlyBudgets = (allTasks.budgets && allTasks.budgets[selectedLedgerMonth === 'current' ? currentMonthKey : selectedLedgerMonth]) 
        ? allTasks.budgets[selectedLedgerMonth === 'current' ? currentMonthKey : selectedLedgerMonth] 
        : {};

    sortedCategories.forEach(category => {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'summary-item';
        const labelSpan = document.createElement('span');
        labelSpan.className = 'summary-item-label';
        labelSpan.textContent = category.name;
        labelSpan.title = category.name; 
        const valueSpan = document.createElement('span');
        valueSpan.className = 'summary-item-value';
        const percentageOfTotal = totalExpense > 0 ? (category.amount / totalExpense) * 100 : 0;
        valueSpan.innerHTML = `<span class="amount">${currency}${category.amount.toFixed(2)}</span> (${percentageOfTotal.toFixed(1)}%)`;
        const barContainer = document.createElement('div');
        barContainer.className = 'summary-item-bar-container';
        const bar = document.createElement('div');
        bar.className = 'summary-item-bar';
        requestAnimationFrame(() => {
            bar.style.width = `${percentageOfTotal}%`;
        });
        barContainer.appendChild(bar);
        itemDiv.appendChild(labelSpan);
        itemDiv.appendChild(valueSpan);
        itemDiv.appendChild(barContainer);

        const budgetForCategory = monthlyBudgets[category.name];
        if (budgetForCategory > 0 && (selectedLedgerMonth === 'current' || allTasks.budgets[selectedLedgerMonth])) { 
            const budgetProgressContainer = document.createElement('div');
            budgetProgressContainer.className = 'budget-progress-container';
            const budgetProgressBar = document.createElement('div');
            budgetProgressBar.className = 'budget-progress-bar';
            const budgetPercentage = Math.min((category.amount / budgetForCategory) * 100, 100); 
            requestAnimationFrame(() => {
                 budgetProgressBar.style.width = `${budgetPercentage}%`;
            });
            if (category.amount > budgetForCategory) { 
                itemDiv.classList.add('over-budget'); 
                budgetProgressBar.classList.add('over-budget-bar'); 
            }
            const budgetProgressText = document.createElement('span');
            budgetProgressText.className = 'budget-progress-text';
            budgetProgressText.textContent = `预算: ${currency}${category.amount.toFixed(2)} / ${currency}${budgetForCategory.toFixed(2)}`;
            budgetProgressContainer.appendChild(budgetProgressBar);
            itemDiv.appendChild(budgetProgressContainer);
            itemDiv.appendChild(budgetProgressText);
        }
        ledgerSummaryBreakdown.appendChild(itemDiv);
    });
}
function getTodayString() { const today = new Date(); const year = today.getFullYear(); const month = String(today.getMonth() + 1).padStart(2, '0'); const day = String(today.getDate()).padStart(2, '0'); return `${year}-${month}-${day}`; }
// --- START OF REPLACEMENT ---
function cleanupDailyTasks() {
    const todayString = getTodayString();
    let hasChanged = false;

    // 获取上次重置的日期，如果不存在则设为一个很早的日期，以确保首次运行时会执行
    const lastResetDate = allTasks.lastDailyResetDate || '1970-01-01';
    
    // 【关键】只有在新的一天才执行清理和重置
    if (lastResetDate === todayString) {
        return false; // 今天已经处理过了，直接返回，不进行任何修改
    }
    
    console.log(`新的一天，为 ${todayString} 清理和重置每日任务。`);

    if (!allTasks.daily || allTasks.daily.length === 0) {
        // 如果没有每日任务，只需更新日期标记即可
        allTasks.lastDailyResetDate = todayString;
        return true; // 日期已更新，数据被视为“已更改”
    }

    const tasksToKeep = [];
    
    for (const task of allTasks.daily) {
        // 1. 移除过期的、从未来计划移来的任务
        if (task.fromFuture) {
            hasChanged = true;
            console.log(`移除过期的计划任务: "${task.text}"`);
            continue; // 跳过，不加入 tasksToKeep
        }
        
        // 2. 移除过期的“不重复(once)”任务
        if (task.cycle === 'once' && task.creationDate !== todayString) {
            hasChanged = true;
            console.log(`移除过期的单次任务: "${task.text}"`);
            continue;
        }

        // 3. 处理所有需要保留的重复任务
        // 重置它们的完成状态
        if (task.completed) {
            task.completed = false;
            hasChanged = true;
        }
        tasksToKeep.push(task); // 保留任务
    }

    // 4. 更新任务列表和重置日期
    if (allTasks.daily.length !== tasksToKeep.length) {
        hasChanged = true;
    }
    allTasks.daily = tasksToKeep;
    allTasks.lastDailyResetDate = todayString;
    
    // 只要是新的一天，lastDailyResetDate 就会更新，所以总是返回 true
    return true; 
}
function formatReminderDateTime(timestamp) {
    if (!timestamp) return '';
    try {
        const date = new Date(timestamp);
        if (isNaN(date.getTime())) return ''; // 无效日期检查

        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');

        return `${month}-${day} ${hours}:${minutes}`;
    } catch (e) {
        console.error("Error formatting reminder date:", e);
        return '';
    }
}
function createDragHandle() { const handle = document.createElement('div'); handle.className = 'drag-handle'; handle.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 11h12v2H2zm0-5h12v2H2zm0-5h12v2H2z"/></svg>`; handle.title = '拖拽排序'; return handle; }
function handleCompletionCelebration(listType, taskArray, listElement, message) {
    if (!listElement) return;

    const section = listElement.closest('.section');
    if (!section) return;

    // 先移除任何已存在的庆祝信息，以防重复
    const existingCelebration = section.querySelector('.completion-celebration');
    if (existingCelebration) {
        existingCelebration.remove();
    }

    // 检查条件：列表不为空，且所有任务都已完成
    if (taskArray && taskArray.length > 0 && taskArray.every(task => task.completed)) {
        const celebrationDiv = document.createElement('div');
        celebrationDiv.className = 'completion-celebration';
        
        const icon = document.createElement('img');
        icon.src = 'images/icon-celebrate.svg';
        icon.alt = '庆祝';
        
        const textSpan = document.createElement('span');
        textSpan.textContent = message;
        
        celebrationDiv.appendChild(icon);
        celebrationDiv.appendChild(textSpan);
        
        // 将祝贺信息插入到标题行下方
        const header = section.querySelector('.section-header');
        if (header && header.nextSibling) {
            header.parentNode.insertBefore(celebrationDiv, header.nextSibling);
        } else {
            // 如果找不到下一个兄弟元素，就添加到 section 的开头（备用方案）
            section.prepend(celebrationDiv);
        }
    }
}
function openHistoryModal(type) { 
    historyModalFor = type; 
    historyDisplayYear = new Date().getFullYear(); 
    updateHistoryModalTitle(); 
    renderHistoryCalendar(); 
    if (historyModal) historyModal.classList.remove('hidden'); 
    isHistoryModalOpen = true; 
}
function closeHistoryModal() { 
    if (historyModal) historyModal.classList.add('hidden'); 
    isHistoryModalOpen = false; 
    historyModalFor = null; 
}
function updateHistoryModalTitle() { 
    if (!historyModalTitle) return;
    if (historyModalFor === 'monthly') { historyModalTitle.textContent = '选择“本月待办”历史月份'; } 
    else if (historyModalFor === 'ledger') { historyModalTitle.textContent = '选择“记账本”历史月份'; } 
}
function renderHistoryCalendar() {
    if (!historyCurrentYearSpan || !historyMonthsGrid) return;
    historyCurrentYearSpan.textContent = historyDisplayYear;
    historyMonthsGrid.innerHTML = '';
    const historySource = historyModalFor === 'monthly' ? allTasks.history : allTasks.ledgerHistory;

    for (let i = 1; i <= 12; i++) {
        const monthBtn = document.createElement('button');
        monthBtn.className = 'month-button';
        monthBtn.textContent = `${i}月`;
        const monthKey = `${historyDisplayYear}-${String(i).padStart(2, '0')}`;
        if (historySource && historySource[monthKey] && historySource[monthKey].length > 0) {
            monthBtn.classList.add('has-history');
            monthBtn.dataset.monthKey = monthKey;
            monthBtn.addEventListener('click', () => selectHistoryMonth(monthKey));
        } else {
            monthBtn.disabled = true;
        }
        historyMonthsGrid.appendChild(monthBtn);
    }
}
function changeHistoryYear(offset) { historyDisplayYear += offset; renderHistoryCalendar(); }
function selectHistoryMonth(monthKey) {
    if (historyModalFor === 'monthly') { 
        selectedMonthlyDisplayMonth = monthKey; 
        currentMonthlyTagFilter = 'all'; 
    }
    else if (historyModalFor === 'ledger') { 
        selectedLedgerMonth = monthKey; 
        currentLedgerFilter = 'all'; 
    }
    closeHistoryModal();
    renderAllLists();
}
function resetToCurrent(type) {
    if (type === 'monthly') { 
        selectedMonthlyDisplayMonth = 'current'; 
        currentMonthlyTagFilter = 'all';
    }
    else if (type === 'ledger') { 
        selectedLedgerMonth = 'current'; 
        currentLedgerFilter = 'all';
    }
    renderAllLists();
}
function openBudgetModal() {
    const now = new Date();
    const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const currency = allTasks.currencySymbol || '$';
    const currentBudgets = (allTasks.budgets && allTasks.budgets[monthKey]) ? allTasks.budgets[monthKey] : {};
    
    const categories = new Set();
    (allTasks.ledger || []).forEach(entry => { if (entry.item) categories.add(entry.item); });
    Object.values(allTasks.ledgerHistory || {}).flat().forEach(entry => { if (entry.item) categories.add(entry.item); });
    Object.keys(currentBudgets).forEach(cat => categories.add(cat));
    const sortedCategories = [...categories].sort((a, b) => a.localeCompare(b));

    if (sortedCategories.length === 0) { 
        openCustomPrompt({
            title: '无项目', 
            message: '您的账本中没有任何消费项目或已设预算的项目。请先添加一些记账条目或手动添加预算项目，才能为其设置预算。', 
            inputType: 'none', 
            confirmText: '好的', 
            hideCancelButton: true
        }); 
        return; 
    }

    let formHtml = `<div class="budget-input-form" data-month="${monthKey}">`; 
    sortedCategories.forEach(cat => {
        formHtml += `
            <div class="budget-input-row">
                <label for="budget-${cat.replace(/\s+/g, '-')}" class="budget-input-label" title="${cat}">${cat}:</label>
                <div class="budget-input-wrapper" data-currency="${currency}">
                    <input type="number" id="budget-${cat.replace(/\s+/g, '-')}" class="budget-input-field" 
                           placeholder="输入预算金额" value="${currentBudgets[cat] || ''}" 
                           step="10" min="0">
                </div>
            </div>`;
    });
    formHtml += '</div>';

    openCustomPrompt({
        title: `设置 ${monthKey} 预算`, 
        htmlContent: formHtml, 
        confirmText: '保存预算',
        onConfirm: () => {
            const newBudgets = {};
            sortedCategories.forEach(cat => {
                const input = document.getElementById(`budget-${cat.replace(/\s+/g, '-')}`);
                if (input) { 
                    const value = parseFloat(input.value);
                    if (!isNaN(value) && value > 0) { 
                        newBudgets[cat] = value; 
                    }
                }
            });
            if (!allTasks.budgets) allTasks.budgets = {}; 
            allTasks.budgets[monthKey] = newBudgets;
            saveTasks();
            renderLedgerSummary(getLedgerDataForDisplay()); 
        }
    });
}
function openAnnualReportModal() { 
    annualReportYear = new Date().getFullYear(); 
    renderAnnualReport(); 
    if(annualReportModal) annualReportModal.classList.remove('hidden'); 
    document.addEventListener('keydown', handleAnnualReportKeyDown); 
}
function closeAnnualReportModal() { 
    if(annualReportModal) annualReportModal.classList.add('hidden'); 
    document.removeEventListener('keydown', handleAnnualReportKeyDown); 
}
function changeAnnualReportYear(offset) { 
    annualReportYear += offset; 
    renderAnnualReport(); 
}
function handleAnnualReportKeyDown(e) { if (e.key === 'Escape') { closeAnnualReportModal(); } }
function renderAnnualReport() {
    if(!annualReportCurrentYearSpan || !annualReportSummaryDiv || !annualReportDetailsDiv) return;
    annualReportCurrentYearSpan.textContent = annualReportYear;
    const currency = allTasks.currencySymbol || '$';
    let annualData = [];
    const yearPrefix = `${annualReportYear}-`;

    for (const monthKey in (allTasks.ledgerHistory || {})) {
        if (monthKey.startsWith(yearPrefix)) { 
            annualData.push(...(allTasks.ledgerHistory[monthKey] || [])); 
        }
    }
    const currentYearDate = new Date().getFullYear();
    if (annualReportYear === currentYearDate) {
        const currentYearData = (allTasks.ledger || []).filter(entry => entry.date && entry.date.startsWith(yearPrefix));
        annualData.push(...currentYearData);
    }
    
    if (annualData.length === 0) { 
        annualReportSummaryDiv.innerHTML = `<div class="summary-total no-expense">${annualReportYear}年无支出记录</div>`; 
        annualReportDetailsDiv.innerHTML = ''; 
        return; 
    }

    const totalExpense = annualData.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0);
    const monthlyExpenses = {};
    const categoryExpenses = {};

    annualData.forEach(entry => {
        if (!entry.date || !entry.amount) return; 
        const month = entry.date.substring(5, 7); 
        const category = entry.item || '未分类';
        monthlyExpenses[month] = (monthlyExpenses[month] || 0) + Number(entry.amount);
        categoryExpenses[category] = (categoryExpenses[category] || 0) + Number(entry.amount);
    });

    const monthsWithExpenses = Object.keys(monthlyExpenses).length;
    const averageMonthlyExpense = monthsWithExpenses > 0 ? totalExpense / monthsWithExpenses : 0;

    annualReportSummaryDiv.innerHTML = `
        <h3 class="summary-title">${annualReportYear}年支出摘要</h3>
        <div class="summary-total">${currency} ${totalExpense.toFixed(2)}</div>
        <div class="annual-report-breakdown">
            <span>总月份数: <strong>${monthsWithExpenses}</strong></span>
            <span>月均支出: <strong>${currency} ${averageMonthlyExpense.toFixed(2)}</strong></span>
        </div>`;

    let detailsHtml = '';
    const sortedCategories = Object.entries(categoryExpenses).sort((a, b) => b[1] - a[1]); 
    detailsHtml += '<h4 class="annual-report-section-title">按项目分类</h4><ul>';
    sortedCategories.forEach(([name, amount]) => { 
        detailsHtml += `<li><div class="faq-question">${name}</div><div class="faq-answer">${currency} ${amount.toFixed(2)}</div></li>`; 
    });
    detailsHtml += '</ul>';

    const sortedMonths = Object.entries(monthlyExpenses).sort((a, b) => a[0].localeCompare(b[0])); 
    detailsHtml += '<h4 class="annual-report-section-title">按月份分类</h4><ul>';
    sortedMonths.forEach(([month, amount]) => { 
        detailsHtml += `<li><div class="faq-question">${annualReportYear}-${month}</div><div class="faq-answer">${currency} ${amount.toFixed(2)}</div></li>`; 
    });
    detailsHtml += '</ul>';
    annualReportDetailsDiv.innerHTML = detailsHtml;
}
function openCurrencyPicker() {
    const currencies = ['$', '¥', '€', '£', '₽', '₩', '₹', '฿', 'CAD', 'AUD', 'CHF', 'NZD', 'SGD']; 
    const currentCurrency = allTasks.currencySymbol || '$';
    let optionsHtml = '<div class="currency-options-grid">';
    currencies.forEach(c => {
        const isActive = c === currentCurrency ? 'active' : '';
        optionsHtml += `<button class="custom-prompt-btn currency-option-btn ${isActive}" data-currency="${c}">${c}</button>`;
    });
    optionsHtml += '</div>';
    openCustomPrompt({
        title: '选择货币符号', 
        htmlContent: optionsHtml, 
        hideConfirmButton: true, 
        hideCancelButton: true,
        onRender: () => {
            document.querySelectorAll('.currency-option-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    allTasks.currencySymbol = btn.dataset.currency;
                    saveTasks();
                    renderAllLists(); 
                    closeCustomPrompt();
                });
            });
        }
    });
}
function moveTask(fromIndex, direction) {
    if (!allTasks.monthly || fromIndex < 0 || fromIndex >= allTasks.monthly.length) return;
    const toIndex = fromIndex + direction;
    if (toIndex < 0 || toIndex >= allTasks.monthly.length) { return; }
    
    const [movedItem] = allTasks.monthly.splice(fromIndex, 1);
    allTasks.monthly.splice(toIndex, 0, movedItem);
    saveTasks();
    renderMonthlyTasks(allTasks.monthly, false); 
    
    setTimeout(() => { 
        if (monthlyTaskList && monthlyTaskList.childNodes[toIndex]) {
            const newLiElement = monthlyTaskList.childNodes[toIndex]; 
            enterSortMode(newLiElement); 
        }
    }, 50); 
}
function enterSortMode(targetLi) { 
    if (!monthlyTaskList) return; 
    monthlyTaskList.classList.add('sort-mode-active'); 
    if (targetLi) { 
        monthlyTaskList.querySelectorAll('li.is-sorting').forEach(li => li.classList.remove('is-sorting'));
        targetLi.classList.add('is-sorting'); 
    } 
}
function exitSortMode() {
    if (!monthlyTaskList || !monthlyTaskList.classList.contains('sort-mode-active')) return;
    monthlyTaskList.classList.remove('sort-mode-active');
    const highlightedItem = monthlyTaskList.querySelector('li.is-sorting');
    if (highlightedItem) { highlightedItem.classList.remove('is-sorting'); }
}


async function updateNotificationButtonUI() {
    if (!toggleNotificationsBtn) return;
    const icon = toggleNotificationsBtn.querySelector('img');
    if (!icon) return; 

    try {
        const permissionState = await navigator.permissions.query({ name: 'notifications' });
        let pushSubscription = null;
        try {
            pushSubscription = await db.get('pushSubscription'); // 从 IndexedDB 获取订阅状态
        } catch(dbError) {
            console.warn("更新通知按钮UI失败：无法从DB获取推送订阅状态:", dbError);
        }

        if (permissionState.state === 'granted') {
            if (pushSubscription) {
                icon.src = 'images/icon-notifications-on.svg';
                toggleNotificationsBtn.title = '通知已开启 (已订阅)';
            } else {
                icon.src = 'images/icon-notifications-issue.svg'; // 已授权但未订阅或订阅失败
                toggleNotificationsBtn.title = '通知已授权，但订阅失败 (点击重试)';
            }
        } else if (permissionState.state === 'prompt') {
            icon.src = 'images/icon-notifications-off.svg';
            toggleNotificationsBtn.title = '点击开启通知 (需要授权)';
        } else { // permissionState.state === 'denied'
            icon.src = 'images/icon-notifications-blocked.svg';
            toggleNotificationsBtn.title = '通知已被阻止 (请在浏览器设置中更改)';
        }
    } catch (error) {
        console.error("更新通知按钮UI时出错:", error);
        icon.src = 'images/icon-notifications-off.svg'; 
        toggleNotificationsBtn.title = '检查通知状态时出错';
    }
}

async function handleNotificationToggle() {
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) {
        openCustomPrompt({title:"功能不支持", message:'您的浏览器不支持桌面通知或推送功能。', inputType:'none', hideCancelButton:true, confirmText:'好的'});
        notificationsEnabled = false; 
        localStorage.setItem('notificationsEnabled', 'false');
        await updateNotificationButtonUI(); // 确保UI更新
        return;
    }

    // `notificationsEnabled` 状态已在 `toggleNotificationSetting` 中切换
    // 此函数处理权限请求和订阅/取消订阅
    
    try {
        if (notificationsEnabled) { // 用户希望开启通知
            const permission = await Notification.requestPermission(); // 请求/确认权限
            if (permission === 'granted') {
                console.log('通知权限已获取，尝试订阅推送。');
                await subscribeUserToPush(); // 尝试订阅
            } else {
                console.warn('用户在 handleNotificationToggle 中拒绝了通知权限或权限仍为 prompt。');
                if (permission === 'denied') { // 如果明确拒绝，则更新状态
                    notificationsEnabled = false;
                    localStorage.setItem('notificationsEnabled', 'false');
                }
            }
        } else { // 用户希望关闭通知
            console.log('用户希望关闭通知，尝试取消订阅。');
            await unsubscribeUserFromPush(); // 尝试取消订阅
        }
    } catch (error) {
        console.error("在 handleNotificationToggle 中处理通知权限或订阅/取消订阅时出错:", error);
        // 如果出错，可能需要回滚 notificationsEnabled 状态
        notificationsEnabled = !notificationsEnabled; // 反转回之前的状态
        localStorage.setItem('notificationsEnabled', String(notificationsEnabled));
    }
    await updateNotificationButtonUI(); // 最终根据操作结果更新UI
}

async function unsubscribeUserFromPush() {
    const registration = await navigator.serviceWorker.getRegistration();
    if (!registration) {
        console.warn("无法取消订阅: Service Worker 未注册。");
        return;
    }

    try {
        const subscription = await registration.pushManager.getSubscription();
        if (subscription) {
            const unsubscribed = await subscription.unsubscribe();
            if (unsubscribed) {
                console.log('用户已成功取消推送订阅。');
            } else {
                console.warn('取消订阅操作返回 false，可能未成功。');
            }
        } else {
            console.log('用户当前未订阅，无需取消。');
        }
    } catch (error) {
        console.error('取消订阅推送时出错:', error);
    } finally {
        // 无论成功与否，都清除本地存储的订阅信息
        await db.set('pushSubscription', null);
        console.log('本地的 pushSubscription 记录已清除。');
    }
}

// 【CORRECTED & ROBUST - FINAL VERSION】
async function subscribeUserToPush() {
    // 1. 检查 Service Worker API 是否可用
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.warn("Push messaging is not supported by this browser.");
        openCustomPrompt({title:"功能不支持", message:'您的浏览器不支持推送通知功能。', inputType:'none', hideCancelButton:true, confirmText:'好的'});
        return null;
    }
    
    try {
        // 2. 等待 Service Worker 确保处于激活状态
        console.log('Waiting for Service Worker to be active...');
        const registration = await navigator.serviceWorker.ready;
        console.log('Service Worker is active and ready.');

        // 3. 检查是否已有订阅
        const existingSubscription = await registration.pushManager.getSubscription();
        if (existingSubscription) {
            console.log('User is already subscribed:', existingSubscription);
            // 【核心修正】在存储前，将 PushSubscription 转换为 JSON
            const subscriptionJSON = existingSubscription.toJSON();
            await db.set('pushSubscription', subscriptionJSON);
            return existingSubscription;
        }

        // 4. 如果没有，则创建新订阅
        console.log('No existing subscription, attempting to create a new one...');
        const vapidPublicKey = 'BOPBv2iLpTziiOOTjw8h2cT24-R_5c0s_q2ITf0JOTooBKiJBDl3bBROi4e_d_2dJd_quNBs2LrqEa2K_u_XGgY';
        if (!vapidPublicKey) {
            console.error("VAPID public key is missing.");
            openCustomPrompt({title:"配置错误", message:'推送通知配置不完整，无法订阅。', inputType:'none', hideCancelButton:true, confirmText:'好的'});
            return null;
        }
        
        const subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true, // 必须为 true，表示每次推送都会有用户可见的通知
            applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
        });
        
        console.log('New subscription successful:', subscription);
        
        // 【核心修正】在存储前，将新的 PushSubscription 转换为 JSON
        const subscriptionJSON = subscription.toJSON();
        await db.set('pushSubscription', subscriptionJSON);
        
        // (可选) 在这里，您可以将 `subscription` 对象发送到您的后端服务器保存
        // await sendSubscriptionToServer(subscription);
        
        return subscription;

    } catch (error) {
        console.error('Failed to subscribe the user: ', error);
        
        // 确保在任何失败情况下，DB中的订阅信息都被清除
        await db.set('pushSubscription', null);

        let title = "订阅失败";
        let message = `无法订阅推送通知，发生未知错误: ${error.name}.`;

        if (error.name === 'NotAllowedError') {
            title = "权限问题";
            message = '浏览器已阻止通知权限。请在浏览器设置中为本站开启通知权限，然后重试。';
        } else if (error.name === 'InvalidStateError') {
             message = '无法创建订阅，可能是由于浏览器处于隐私模式或 Service Worker 未完全激活。请刷新页面后重试。';
        }
        
        openCustomPrompt({title: title, message: message, inputType:'none', hideCancelButton:true, confirmText:'好的'});
        return null;
    }
}


function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) { outputArray[i] = rawData.charCodeAt(i); }
    return outputArray;
}
// 在 app.js 中，用这个新版本完整替换掉 openCustomPrompt

function openCustomPrompt(config) {
    // 检查是否已经有一个弹窗打开了
    const isModalOpen = customPromptModal && !customPromptModal.classList.contains('hidden');

    // 如果已经有一个弹窗，并且我们不是要更新它，这是一个调用错误，先关闭旧的
    // 这是为了防止意外的重叠调用，增加代码的健壮性
    if (isModalOpen && !config.isUpdate) {
        console.warn("openCustomPrompt called while another prompt is already open. Closing the old one first and retrying.");
        closeCustomPrompt(() => {
            // 在旧弹窗完全关闭后，再重新调用 openCustomPrompt
            openCustomPrompt(config);
        });
        return;
    }

    currentPromptConfig = config;
    if (customPromptModal && customPromptTitleEl && customPromptMessageEl && customPromptInputContainer && customPromptConfirmBtn && customPromptCancelBtn) {
        // --- 设置标题和消息 ---
        customPromptTitleEl.textContent = config.title || '提示';
        customPromptMessageEl.textContent = config.message || '';
        customPromptMessageEl.style.display = config.message ? 'block' : 'none';
        
        // --- 处理输入区域 ---
        customPromptInputContainer.innerHTML = ''; // 每次都清空
        if (config.inputType && config.inputType !== 'none') {
            let inputEl;
            if (config.inputType === 'textarea') {
                inputEl = document.createElement('textarea');
                inputEl.rows = config.rows || 4; 
            } else {
                inputEl = document.createElement('input');
                inputEl.type = config.inputType;
            }
            inputEl.id = 'custom-prompt-input-field';
            inputEl.className = 'custom-prompt-input';
            if (config.placeholder) inputEl.placeholder = config.placeholder;
            if (config.initialValue !== undefined) inputEl.value = config.initialValue; 
            if (config.inputAttributes) { 
                for (const attr in config.inputAttributes) {
                    inputEl.setAttribute(attr, config.inputAttributes[attr]);
                }
            }
            customPromptInputContainer.appendChild(inputEl);
            customPromptInputContainer.style.display = 'block';
            setTimeout(() => inputEl.focus(), 50);
        } else {
            // 确保没有输入框时，容器是隐藏的
            customPromptInputContainer.style.display = 'none';
        }

        // --- 处理自定义HTML内容 ---
        if (config.htmlContent) {
            customPromptInputContainer.innerHTML = config.htmlContent;
            customPromptInputContainer.style.display = 'block';
        }

        // --- 设置按钮 ---
        customPromptConfirmBtn.textContent = config.confirmText || '确认';
        customPromptCancelBtn.textContent = config.cancelText || '取消';
        
        customPromptConfirmBtn.style.display = config.hideConfirmButton ? 'none' : 'inline-block';
        customPromptCancelBtn.style.display = config.hideCancelButton ? 'none' : 'inline-block';
        
        // --- 显示模态框 ---
        // 只有当模态框是隐藏的时候，才移除 .hidden 类来触发打开动画
        if (customPromptModal.classList.contains('hidden')) {
            customPromptModal.classList.remove('hidden');
        }
        
        // --- 执行渲染回调 ---
        if (typeof config.onRender === 'function') {
            config.onRender();
        }
    } else {
        console.error("Custom prompt modal elements not found.");
    }
}
function closeCustomPrompt(onClosedCallback) {
    if (customPromptModal) {
        // 如果模态框已经是隐藏的，直接执行回调（如果有）并返回，避免不必要的操作
        if (customPromptModal.classList.contains('hidden')) {
            if (typeof onClosedCallback === 'function') {
                onClosedCallback();
            }
            return;
        }

        // 添加 .hidden 类来启动CSS关闭动画
        customPromptModal.classList.add('hidden');

        // 设置一个定时器，其延迟时间应与CSS中的transition-duration相匹配或略长
        // 假设CSS动画是0.3秒，我们设置为350毫秒来确保动画完成
        const transitionDuration = 350;

        setTimeout(() => {
            // 在动画结束后，安全地执行回调函数
            if (typeof onClosedCallback === 'function') {
                try {
                    onClosedCallback();
                } catch (e) {
                    console.error("Error in onClosedCallback for closeCustomPrompt:", e);
                }
            }
        }, transitionDuration);

    } else if (typeof onClosedCallback === 'function') {
        // 如果模态框元素本身不存在，也应该尝试执行回调，以防逻辑中断
        try {
            onClosedCallback();
        } catch (e) {
            console.error("Error in onClosedCallback (modal not found):", e);
        }
    }
    
    // 清理全局配置和事件监听器
    currentPromptConfig = {}; 
    if (activeKeydownHandler) {
        document.removeEventListener('keydown', activeKeydownHandler);
        activeKeydownHandler = null;
    }
}
function checkAndMoveFutureTasks() {
    const now = Date.now();
    let tasksWereMoved = false;
    if (allTasks.future && allTasks.future.length > 0) {
        const dueFutureTasks = [];
        const remainingFutureTasks = [];

        allTasks.future.forEach(task => {
            let taskDateTimestamp = Infinity;
            if (task.date) {
                try {
                    taskDateTimestamp = new Date(task.date + 'T23:59:59').getTime();
                } catch (e) {
                    console.warn("Invalid date format for future task:", task.date);
                }
            }
            if ((task.reminderTime && task.reminderTime <= now) || (taskDateTimestamp <= now)) {
                dueFutureTasks.push(task);
            } else {
                remainingFutureTasks.push(task);
            }
        });

        if (dueFutureTasks.length > 0) {
            if (!allTasks.daily) allTasks.daily = [];
            dueFutureTasks.forEach(task => {
                allTasks.daily.unshift({ 
                    id: generateUniqueId(), 
                    text: `[计划] ${task.text}`, 
                    completed: false, 
                    note: task.note || (task.progressText || ''), 
                    links: task.links || [],
                    // 【核心新增】添加 fromFuture 标记
                    fromFuture: true 
                });
            });
            allTasks.future = remainingFutureTasks; // 更新 future 列表
            tasksWereMoved = true;
        }
    }
return tasksWereMoved;
}


/**
 * 根据报告类型，准备要发送给AI的原始数据
 * @param {string} reportType - e.g., 'daily_today', 'weekly_this', 'monthly_last'
 * @returns {{title: string, data: string} | null}
 */
function getReportData(reportType) {
    const now = new Date();
    let startDate, endDate;
    let title = "";
    let isCurrentPeriod = false;

    // 1. 根据 reportType 计算日期范围
    switch (reportType) {
        case 'daily_today': { // 使用花括号创建块级作用域
            startDate = new Date(new Date().setHours(0, 0, 0, 0));
            endDate = new Date(new Date().setHours(23, 59, 59, 999));
            title = `${getTodayString()} 工作日报`;
            isCurrentPeriod = true;
            break;
        }

        case 'weekly_this': { // 使用花括号创建块级作用域
            const currentDay = now.getDay();
            const firstDayOfWeek = now.getDate() - currentDay + (currentDay === 0 ? -6 : 1);
            startDate = new Date(new Date(now).setDate(firstDayOfWeek));
            startDate.setHours(0, 0, 0, 0);
            endDate = new Date(startDate);
            endDate.setDate(startDate.getDate() + 6);
            endDate.setHours(23, 59, 59, 999);
            title = "本周工作周报";
            isCurrentPeriod = true; // 本周也是当前时段
            break;
        }

        case 'weekly_last': { // 使用花括号创建块级作用域
            const currentDay = now.getDay();
            const firstDayOfLastWeek = now.getDate() - currentDay + (currentDay === 0 ? -6 : 1) - 7;
            startDate = new Date(new Date(now).setDate(firstDayOfLastWeek));
            startDate.setHours(0, 0, 0, 0);
            endDate = new Date(startDate);
            endDate.setDate(startDate.getDate() + 6);
            endDate.setHours(23, 59, 59, 999);
            title = "上周工作周报";
            break;
        }

        case 'monthly_this': { // 使用花括号创建块级作用域
            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
            endDate = new Date(new Date(now.getFullYear(), now.getMonth() + 1, 0).setHours(23, 59, 59, 999));
            title = "本月工作月报";
            isCurrentPeriod = true;
            break;
        }
            
        case 'monthly_last': { // 使用花括号创建块级作用域
            startDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
            endDate = new Date(new Date(now.getFullYear(), now.getMonth(), 0).setHours(23, 59, 59, 999));
            title = "上月工作月报";
            break;
        }

        case 'yearly_this': { // 使用花括号创建块级作用域
            startDate = new Date(now.getFullYear(), 0, 1);
            endDate = new Date(new Date(now.getFullYear(), 11, 31).setHours(23, 59, 59, 999));
            title = `${now.getFullYear()}年年度报告`;
            isCurrentPeriod = true;
            break;
        }

        default:
            console.error("未知的报告类型:", reportType);
            return null;
    }

    // 2. 收集所有相关数据（不筛选完成状态）
    const allRelevantTasks = new Map();
    const ledgerEntries = [];

    const processTask = (task) => {
        if (!task || !task.id) return; // 确保任务和ID有效
        const relevantDateStr = task.completionDate || task.creationDate || (isCurrentPeriod ? getTodayString() : null);
        if (relevantDateStr) {
            const d = new Date(relevantDateStr);
            if (d >= startDate && d <= endDate) {
                if (!allRelevantTasks.has(task.id)) {
                    allRelevantTasks.set(task.id, task);
                }
            }
        }
    };
    
    [
        ...(allTasks.monthly || []),
        ...(Object.values(allTasks.history || {})).flat(),
        ...(allTasks.daily || [])
    ].forEach(processTask);
    
    if (isCurrentPeriod) {
        (allTasks.monthly || []).forEach(task => {
            if (!task.completed && !allRelevantTasks.has(task.id)) {
                allRelevantTasks.set(task.id, task);
            }
        });
    }

    [
        ...(allTasks.ledger || []),
        ...(Object.values(allTasks.ledgerHistory || {})).flat()
    ].forEach(entry => {
        if (entry.date) {
            const d = new Date(entry.date);
            if (d >= startDate && d <= endDate) {
                ledgerEntries.push(entry);
            }
        }
    });

    const tasks = Array.from(allRelevantTasks.values());

    // 3. 将数据格式化为纯文本，并明确标注状态
    let formattedText = `## 任务清单:\n`;
    if (tasks.length > 0) {
        tasks.forEach(t => {
            const status = t.completed ? 'completed' : 'uncompleted';
            let taskLine = `- ${t.text} (status: ${status})`;
            if (t.tags?.length > 0) {
                taskLine += ` (tags: ${t.tags.join(', ')})`;
            }
            formattedText += `${taskLine}\n`;
        });
    } else {
        formattedText += "- 本时段无相关任务。\n";
    }

    if (ledgerEntries.length > 0) {
        const totalExpense = ledgerEntries.reduce((sum, e) => sum + (e.amount || 0), 0);
        formattedText += `\n## 财务支出小结:\n`;
        formattedText += `- 共 ${ledgerEntries.length} 笔支出，总计 ${allTasks.currencySymbol || '$'}${totalExpense.toFixed(2)}。\n`;
    }

    return { title, data: formattedText };
}

/**
 * 【旧函数，将被废弃】
 * 主函数：处理报告生成流程
 * @param {string} reportType 
 * async function handleGenerateReport(reportType) { ... }
 */
// (您可以删除或注释掉旧的 handleGenerateReport 函数)


// 【新增】第一步：当用户选择报告类型时，准备确认界面
async function prepareReportConfirmation(reportType) { // 【关键修改】添加 async
    const reportPayload = getReportData(reportType);
    if (!reportPayload) {
        openCustomPrompt({ title: "错误", message: "无法获取报告数据，类型无效。", inputType: 'none', confirmText: '好的', hideCancelButton: true });
        return;
    }

    reportOptionsGrid.classList.add('hidden');
    aiReportOutput.classList.remove('hidden');
    aiReportLoading.classList.add('hidden');
    aiReportContent.innerHTML = '';

    aiReportTitle.textContent = reportPayload.title;

    const titleContainer = document.getElementById('report-title-container');
    
    const oldBtn = document.getElementById('ai-confirm-generate-btn');
    if (oldBtn) oldBtn.remove();
    
    const confirmBtn = document.createElement('button');
    confirmBtn.id = 'ai-confirm-generate-btn';
    confirmBtn.className = 'custom-prompt-btn custom-prompt-confirm'; 
    confirmBtn.textContent = '确认生成';
    
    confirmBtn.onclick = () => {
        executeReportGeneration(reportType);
    };

    titleContainer.appendChild(confirmBtn);

    // 【关键修改】在UI准备好后，立即检查并更新Notion授权状态
    await updateNotionAuthStatusUI();
}


// 【新增】一个专门的函数来更新Notion授权状态的UI
async function updateNotionAuthStatusUI() {
    const warningEl = document.getElementById('notion-auth-warning');
    if (!warningEl) return;

    try {
        const accessToken = await db.get('notion_access_token');
        if (accessToken) {
            warningEl.classList.add('hidden');
        } else {
            warningEl.classList.remove('hidden');
        }
    } catch (error) {
        console.error("检查Notion授权状态失败:", error);
        // 出错时默认显示警告，引导用户重新授权
        warningEl.classList.remove('hidden');
    }
}

// 【新增】第二步：当用户点击“确认生成”后，执行AI调用

async function executeReportGeneration(reportType) {
    const confirmBtn = document.getElementById('ai-confirm-generate-btn');
    if (confirmBtn) confirmBtn.style.display = 'none';

    aiReportLoading.classList.remove('hidden');

    const reportPayload = getReportData(reportType);
    if (!reportPayload) {
        aiReportContent.innerHTML = `<p class="api-status error">无法生成报告，无效的报告类型。</p>`;
        aiReportLoading.classList.add('hidden');
        return;
    }

    try {
        const aiResponse = await aiAssistant.generateAIResponse(reportPayload.data, aiAssistant.REPORT_SYSTEM_PROMPT);
        
        const htmlContent = aiResponse
            .replace(/^### (.*$)/gim, '<h4>$1</h4>')
            .replace(/^## (.*$)/gim, '<h3>$1</h3>')
            .replace(/^# (.*$)/gim, '<h2>$1</h2>')
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*(.*)\*\*/g, '<strong>$1</strong>')
            .replace(/\*(.*)\*/g, '<em>$1</em>')
            .replace(/^- (.*$)/gim, '<li>$1</li>')
            .replace(/<\/li>(\s*<li)/gim, '</li>\n$1')
            .replace(/((<li>.*<\/li>\s*)+)/gim, '<ul>$1</ul>');

        aiReportContent.innerHTML = htmlContent;

    } catch (error) {
        aiReportContent.innerHTML = `<p class="api-status error">生成报告失败: ${error.message}</p>`;
    } finally {
        aiReportLoading.classList.add('hidden');
        // 【移除】不再需要在这里调用 updateNotionAuthStatusUI
    }
}


// In app.js, replace the existing showAiSettingsModal function with this one.

async function showAiSettingsModal() {
    // 1. Asynchronously get all necessary data first.
    const { openai: openaiKey, gemini: geminiKey, deepseek: deepseekKey } = aiAssistant.getKeys();
    const selectedModel = aiAssistant.getSelectedModel();
    const notionAccessToken = await db.get('notion_access_token');

    // 2. 构建HTML骨架。注意：这里我们不再在模板字符串中插入动态的masked key或hidden类。
    // 所有的动态状态都将在 onRender 回调中设置，这样更可靠。
    const htmlContent = `
        <div class="ai-settings-container">
            <!-- DeepSeek Group -->
            <div class="ai-settings-group">
                <p class="ai-settings-provider-title">DeepSeek (模型: deepseek-chat)</p>
                <div id="deepseek-key-display" class="masked-key-wrapper hidden">
                    <span id="masked-deepseek-key"></span>
                    <button class="header-action-btn-small" data-provider="deepseek">修改</button>
                </div>
                <div id="deepseek-key-input-area" class="ai-key-input-area">
                    <input type="text" id="deepseek-api-key-input" class="custom-prompt-input" placeholder="请输入DeepSeek API Key...">
                    <button class="custom-prompt-btn custom-prompt-confirm" data-provider="deepseek">验证</button>
                </div>
                <p class="api-key-helper-text">
                    <a href="https://platform.deepseek.com/" target="_blank">点击这里获取密钥</a>
                </p>
                <p id="deepseek-status" class="api-status"></p>
            </div>

            <!-- OpenAI Group -->
            <div class="ai-settings-group">
                <p class="ai-settings-provider-title">OpenAI (模型: o3-mini)</p>
                <div id="openai-key-display" class="masked-key-wrapper hidden">
                    <span id="masked-openai-key"></span>
                    <button class="header-action-btn-small" data-provider="openai">修改</button>
                </div>
                <div id="openai-key-input-area" class="ai-key-input-area">
                    <input type="text" id="openai-api-key-input" class="custom-prompt-input" placeholder="请输入Openai api key...">
                    <button class="custom-prompt-btn custom-prompt-confirm" data-provider="openai">验证</button>
                </div>
                <p class="api-key-helper-text">
                    <a href="https://platform.openai.com/settings/organization/api-keys" target="_blank">点击这里获取密钥</a>
                </p>
                <p id="openai-status" class="api-status"></p>
            </div>

            <!-- Gemini Group -->
            <div class="ai-settings-group">
                <p class="ai-settings-provider-title">Google Gemini (模型: Gemini 1.5 Flash)</p>
                <div id="gemini-key-display" class="masked-key-wrapper hidden">
                    <span id="masked-gemini-key"></span>
                    <button class="header-action-btn-small" data-provider="gemini">修改</button>
                </div>
                <div id="gemini-key-input-area" class="ai-key-input-area">
                    <input type="text" id="gemini-api-key-input" class="custom-prompt-input" placeholder="请输入Gemini api key...">
                    <button class="custom-prompt-btn custom-prompt-confirm" data-provider="gemini">验证</button>
                </div>
                <p class="api-key-helper-text">
                    <a href="https://aistudio.google.com/apikey" target="_blank">点击这里获取密钥</a>
                </p>
                <p id="gemini-status" class="api-status"></p>
            </div>
        
            <div class="ai-settings-global-controls" style="padding-top: 10px;">
                <div class="ai-settings-group">
                    <p class="ai-settings-provider-title">选择默认使用的AI模型</p>
                    <select id="ai-model-selector" class="header-select" style="width: 100%;">
                        <option value="deepseek">DeepSeek (deepseek-chat)</option>
                        <option value="openai">OpenAI (o3-mini)</option>
                        <option value="gemini">Google Gemini (1.5 Flash)</option>
                    </select>
                </div>
                ${notionAccessToken ? `
                <div class="ai-settings-group" style="margin-top: 15px;">
                    <p class="ai-settings-provider-title">Notion 集成</p>
                    <button id="change-notion-page-btn" class="custom-prompt-btn" style="width:100%;">更改报告导出页面</button>
                </div>
                ` : ''}
            </div>
        </div>
    `;

    openCustomPrompt({
        title: 'AI 助手设置',
        htmlContent: htmlContent,
        hideConfirmButton: true,
        cancelText: '完成',
        
        onRender: () => {
            const modal = document.getElementById('custom-prompt-modal');
            if (!modal) return;

            const providers = {
                openai: openaiKey,
                gemini: geminiKey,
                deepseek: deepseekKey
            };

            // 3. 【核心修正】在 onRender 回调中，根据数据动态设置UI
            for (const provider in providers) {
                const key = providers[provider];
                const displayArea = document.getElementById(`${provider}-key-display`);
                const inputArea = document.getElementById(`${provider}-key-input-area`);
                const maskedKeySpan = document.getElementById(`masked-${provider}-key`);

                if (key) {
                    // 如果key存在，显示masked-key区域，隐藏输入区域
                    maskedKeySpan.textContent = maskApiKey(key);
                    displayArea.classList.remove('hidden');
                    inputArea.classList.add('hidden');
                } else {
                    // 如果key不存在，隐藏masked-key区域，显示输入区域
                    displayArea.classList.add('hidden');
                    inputArea.classList.remove('hidden');
                }
            }
            
            // 4. 为所有按钮绑定事件监听器
            
            // "修改" 按钮逻辑
            modal.querySelectorAll('.masked-key-wrapper button').forEach(btn => {
                btn.addEventListener('click', () => {
                    const provider = btn.dataset.provider;
                    document.getElementById(`${provider}-key-display`).classList.add('hidden');
                    document.getElementById(`${provider}-key-input-area`).classList.remove('hidden');
                    const inputField = document.getElementById(`${provider}-api-key-input`);
                    // 从我们已经获取的 storageData 中设置初始值，避免再次异步调用
                    inputField.value = providers[provider] || '';
                    inputField.focus();
                });
            });

            // "验证" 按钮逻辑 (保持不变，但逻辑清晰)
            modal.querySelectorAll('.ai-key-input-area button').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const provider = btn.dataset.provider;
                    const input = document.getElementById(`${provider}-api-key-input`);
                    const statusEl = document.getElementById(`${provider}-status`);
                    const key = input.value.trim();

                    if (!key) {
                        statusEl.textContent = "API Key 不能为空。";
                        statusEl.className = 'api-status error';
                        return;
                    }

                    statusEl.textContent = "正在验证...";
                    statusEl.className = 'api-status loading';
                    btn.disabled = true;

                    try {
                        let isValid = false;
                        let testEndpoint, headers;
                        
                        switch(provider) {
                            case 'openai':
                                testEndpoint = 'https://api.openai.com/v1/models';
                                headers = { 'Authorization': `Bearer ${key}` };
                                break;
                            case 'gemini':
                                testEndpoint = `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`;
                                headers = {};
                                break;
                            case 'deepseek':
                                testEndpoint = 'https://api.deepseek.com/models';
                                headers = { 'Authorization': `Bearer ${key}` };
                                break;
                        }

                        const response = await fetch(testEndpoint, { headers });

                        if (!response.ok) {
                            const errorData = await response.json();
                            const errorMessage = (errorData.error && errorData.error.message) ? errorData.error.message : `HTTP ${response.status}`;
                            throw new Error(errorMessage);
                        }
                        
                        if(provider === 'gemini') {
                             const data = await response.json();
                             if (!data.models || data.models.length === 0) {
                                throw new Error("API Key有效，但无可访问的模型。");
                             }
                        }

                        isValid = true;
                        
                        if (isValid) {
                            await aiAssistant.saveKey(provider, key);
                            statusEl.textContent = "验证成功并已保存！";
                            statusEl.className = 'api-status success';
                            
                            // 验证成功后，立即更新UI
                            document.getElementById(`masked-${provider}-key`).textContent = maskApiKey(key);
                            document.getElementById(`${provider}-key-display`).classList.remove('hidden');
                            document.getElementById(`${provider}-key-input-area`).classList.add('hidden');
                        }

                    } catch (err) {
                        statusEl.textContent = `验证失败: ${err.message}`;
                        statusEl.className = 'api-status error';
                    } finally {
                        btn.disabled = false;
                    }
                });
            });
            
            // 模型选择器逻辑
            const modelSelector = document.getElementById('ai-model-selector');
            if(modelSelector) {
                modelSelector.value = selectedModel;
                modelSelector.addEventListener('change', (e) => {
                    aiAssistant.setSelectedModel(e.target.value);
                });
            }

            // Notion按钮逻辑
            const changeNotionPageBtn = document.getElementById('change-notion-page-btn');
            if (changeNotionPageBtn) {
                changeNotionPageBtn.addEventListener('click', () => closeCustomPrompt(() => selectNotionParentPage(false)));
            }
        }
    });
}



async function handleAiProcess() {
    const userInput = aiPromptInput.value.trim();
    if (!userInput) return;

    // 检查API Key的逻辑（保持不变）
    const keys = aiAssistant.getKeys();
    const selectedModel = aiAssistant.getSelectedModel();
    if ((selectedModel === 'openai' && !keys.openai) || (selectedModel === 'gemini' && !keys.gemini)) {
        closeModal(aiAssistantModal);
        setTimeout(() => {
            openCustomPrompt({
                title: '需要 API Key',
                message: `您选择的 ${selectedModel.toUpperCase()} 模型需要设置 API Key。请前往“AI助手设置”进行配置。`,
                inputType: 'none',
                confirmText: '好的，去设置',
                hideCancelButton: true,
                onConfirm: showAiSettingsModal
            });
        }, 200);
        return;
    }

    // 显示加载状态
    aiProcessBtn.disabled = true;
    aiAddLoading.classList.remove('hidden'); 

    try {
        // 使用通用的 generateAIResponse 函数和默认的 SYSTEM_PROMPT
        const parsedData = await aiAssistant.generateAIResponse(userInput, aiAssistant.SYSTEM_PROMPT);
        if (parsedData) {
           aiPromptInput.value = ''; // 清空输入
            closeModal(aiAssistantModal); // **先关闭**AI助手模态框
            showAIConfirmation(parsedData); // 再打开确认模态框
        }
        // 如果 parsedData 为 null（例如API调用内部处理了错误但没抛出），则流程会走到 finally

    } catch (error) {
        // --- 失败路径（核心修正） ---
        console.error("AI processing failed in handler:", error);
        
        // **1. 关键步骤：在弹出错误提示前，先关闭当前的AI助手模态框**
        closeModal(aiAssistantModal);

        // 优化错误提示
        let title = 'AI 助手出错';
        let message = `处理您的请求时发生错误: ${error.message}`;
        if (String(error.message).toLowerCase().includes('overloaded')) {
            title = 'AI 服务器繁忙';
            message = '当前AI模型正处于高负载状态，请稍后再试。这不是应用本身的错误，请您谅解。';
        }

        // **2. 使用 setTimeout 确保关闭动画完成后再弹出新提示，避免闪烁**
        setTimeout(() => {
            openCustomPrompt({
                title: title,
                message: message,
                inputType: 'none',
                confirmText: '好的',
                hideCancelButton: true,
            });
        }, 200); // 延迟200毫秒

    } finally {
        // 恢复UI状态
        aiProcessBtn.disabled = false;
        aiAddLoading.classList.add('hidden');
    }
}

function showAIConfirmation(parsedData) {
    if (!parsedData || !parsedData.module || !parsedData.data) {
        openCustomPrompt({ title: '解析失败', message: 'AI未能返回有效的数据结构。', inputType: 'none', confirmText: '好的', hideCancelButton: true });
        return;
    }

    let previewHtml = `<h4>AI 已解析您的指令，请确认：</h4>`;
    const { module, data } = parsedData;

    switch (module) {
        case 'monthly':
            previewHtml += `
                <p><strong>模块:</strong> 本月待办</p>
                <p><strong>任务:</strong> ${data.text || 'N/A'}</p>
                <p><strong>标签:</strong> ${data.tags?.join(', ') || '无'}</p>
                <p><strong>优先级:</strong> ${data.priority === 3 ? '高' : data.priority === 1 ? '低' : '中'}</p>`;
            break;
        case 'future':
            previewHtml += `
                <p><strong>模块:</strong> 未来计划</p>
                <p><strong>计划:</strong> ${data.text || 'N/A'}</p>
                <p><strong>提醒时间:</strong> ${data.reminder ? new Date(data.reminder).toLocaleString() : '未设置'}</p>`;
            break;
        case 'ledger':
            previewHtml += `
                <p><strong>模块:</strong> 记账本</p>
                <p><strong>日期:</strong> ${data.date || 'N/A'}</p>
                <p><strong>项目:</strong> ${data.item || 'N/A'}</p>
                <p><strong>金额:</strong> ${allTasks.currencySymbol || '$'}${data.amount || 0}</p>
                <p><strong>支付方式:</strong> ${data.payment || '无'}</p>`;
            break;
        case 'daily':
             previewHtml += `
                <p><strong>模块:</strong> 每日清单</p>
                <p><strong>任务:</strong> ${data.text || 'N/A'}</p>
                <p><strong>周期:</strong> ${data.cycle || '每日'}</p>`;
            break;
        default:
            previewHtml += `<p>AI 未能识别出具体操作，请尝试换一种说法。</p><p><strong>原因:</strong> ${data.reason || '未知'}</p>`;
            openCustomPrompt({ title: '无法识别', htmlContent: previewHtml, confirmText: '好的', hideCancelButton: true });
            return;
    }

    openCustomPrompt({
        title: '确认添加',
        htmlContent: previewHtml,
        confirmText: '确认',
        onConfirm: () => {
            addAIParsedTask(parsedData);
        }
    });
}

function addAIParsedTask(parsedData) {
    const { module, data } = parsedData;
    let newTask = {};

    switch (module) {
        case 'monthly':
            newTask = {
                id: generateUniqueId(),
                text: data.text,
                completed: false,
                links: [],
                progress: 0,
                progressText: '',
                subtasks: [],
                tags: data.tags || [],
                completionDate: null,
                priority: data.priority || 2
            };
            if (!allTasks.monthly) allTasks.monthly = [];
            allTasks.monthly.unshift(newTask);
            break;

        case 'future':
            newTask = {
                id: generateUniqueId(),
                text: data.text,
                completed: false,
                links: []
            };
            if (data.reminder) {
                newTask.reminderTime = new Date(data.reminder).getTime();
            }
            if (!allTasks.future) allTasks.future = [];
            allTasks.future.unshift(newTask);
            break;

        case 'ledger':
            newTask = {
                date: data.date,
                item: data.item,
                amount: data.amount,
                payment: data.payment || '',
                details: ''
            };
            if (!allTasks.ledger) allTasks.ledger = [];
            allTasks.ledger.unshift(newTask);
            break;
        
        case 'daily':
            newTask = { 
                id: generateUniqueId(), 
                text: data.text, 
                completed: false, 
                note: '', 
                links: [],
                cycle: data.cycle || 'daily'
            };
            if (newTask.cycle === 'once') {
                newTask.creationDate = getTodayString();
            }
            if (!allTasks.daily) allTasks.daily = [];
            allTasks.daily.unshift(newTask);
            break;
    }

    saveTasks();
    renderAllLists();
}

async function handleExportToNotionClick() {
    const accessToken = await db.get('notion_access_token');
    
    if (accessToken) {
        // 如果已有token，直接进入导出流程
        await executeNotionExport();
    } else {
        // 如果没有token，启动首次授权流程
        await redirectToNotionAuthPKCE();
    }
}

async function redirectToNotionAuthPKCE() {
    // 1. 从Notion开发者中心获取您的Client ID
    const NOTION_CLIENT_ID = '22fd872b-594c-802d-bd93-0037133f9480'; // 替换为你的Client ID
    const REDIRECT_URI = 'https://alanlinzw.github.io/'; // PWA的当前URL

    // 2. 生成并存储 code_verifier
    const codeVerifier = generateCodeVerifier(128);
    await db.set('notion_code_verifier', codeVerifier);

    // 3. 生成 code_challenge
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    // 4. 构建授权URL
    const authUrl = new URL('https://api.notion.com/v1/oauth/authorize');
    authUrl.searchParams.append('client_id', NOTION_CLIENT_ID);
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('owner', 'user');
    authUrl.searchParams.append('redirect_uri', REDIRECT_URI);
    // PKCE-specific parameters
    authUrl.searchParams.append('code_challenge_method', 'S256');
    authUrl.searchParams.append('code_challenge', codeChallenge);

    // 5. 在跳转前，保存当前报告内容
    const reportContent = aiReportContent.innerHTML;
    const reportTitle = aiReportTitle.textContent;
    localStorage.setItem('pendingNotionExport', JSON.stringify({ title: reportTitle, content: reportContent }));

    // 6. 【关键修改】使用 window.open 在新标签页中打开授权URL
    window.open(authUrl.toString(), '_blank');
}

// 在 app.js 中，用这个新版本完整替换掉 selectNotionParentPage

async function selectNotionParentPage(isFirstTime = false) {
    // 1. 打开“正在加载”的提示
    openCustomPrompt({
        title: "选择报告存放位置",
        message: "正在加载您已授权的Notion页面...",
        inputType: 'none',
        hideConfirmButton: true,
        hideCancelButton: true
    });

    try {
        const accessToken = await db.get('notion_access_token');
        
        if (!accessToken || typeof accessToken !== 'string' || accessToken.trim() === '') {
            throw new Error("无效的Notion访问凭证。请重新点击“导出”按钮以发起授权。");
        }

        const PROXY_SEARCH_URL = 'https://notion-auth-proxy.martinlinzhiwu.workers.dev/notion-proxy/v1/search';
        
        // 根据Notion API文档，发送一个空的JSON对象作为请求体，
        // 以获取所有该集成有权访问的页面和数据库。
        const searchBody = {}; 

        const response = await fetch(PROXY_SEARCH_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Notion-Version': '2022-06-28',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(searchBody)
        });

        const data = await response.json();

        if (!response.ok) {
            const errorMessage = data.message || data.error || `请求失败，状态码: ${response.status}`;
            throw new Error(`Notion Search Error: ${errorMessage}`);
        }
        
        const pages = data.results;

        // 【UI修复】在打开新Prompt前，先关闭旧的“加载”Prompt
        closeCustomPrompt();

        if (pages.length === 0) {
            // 如果没有页面，直接显示错误提示
            openCustomPrompt({
                title: "未找到可用的页面",
                message: "您似乎没有授权任何页面给本应用。请前往Notion，将您希望使用的页面或数据库分享给“EfficienTodo Report Exporter”这个集成，然后重试。",
                confirmText: "好的"
            });
            return;
        }

        // 构建页面选择器的HTML
        let optionsHtml = `
            <p>请选择一个页面或数据库，未来所有的AI报告都将导出到这里。</p>
            <select id="notion-page-selector" class="header-select" style="width: 100%; margin-top: 10px;">
                <option value="">-- 请选择 --</option>
                ${pages.map(page => {
                    const title = page.properties.title?.title[0]?.plain_text || page.title?.[0]?.plain_text || '无标题页面';
                    const icon = page.icon?.emoji || (page.object === 'database' ? '🗂️' : '📄');
                    return `<option value="${page.id}">${icon} ${title}</option>`;
                }).join('')}
            </select>`;

        // 2. 现在，打开包含选择器的新Prompt
        openCustomPrompt({
            title: "选择报告存放位置",
            htmlContent: optionsHtml,
            confirmText: "确认并保存",
            onConfirm: async () => {
                const selector = document.getElementById('notion-page-selector');
                const selectedPageId = selector.value;
                if (!selectedPageId) {
                    const promptContent = document.querySelector('#custom-prompt-modal .custom-prompt-content p');
                    if (promptContent) {
                        promptContent.style.color = 'var(--danger-color)';
                        promptContent.textContent = '请务必选择一个页面或数据库！';
                    }
                    return false; // 阻止prompt关闭
                }
                
                await db.set('notion_parent_page_id', selectedPageId);
                const parentType = pages.find(p => p.id === selectedPageId)?.object;
                await db.set('notion_parent_type', parentType);

                // 【UI修复】不再弹出“设置成功”的提示，直接关闭当前的选择框
                closeCustomPrompt();

                // 如果是首次设置，立即触发导出流程
                if (isFirstTime) {
                   executeNotionExport();
                }

                return true; // 确认关闭
            }
        });

    } catch (error) {
        // 在catch块里，也要确保关闭“加载”弹窗，再显示错误弹窗
        closeCustomPrompt();
        openCustomPrompt({ title: "加载页面失败", message: error.message, confirmText: '好的' });
    }
}
/**
 * Parses an HTML string into an array of Notion block objects.
 */
function htmlToNotionBlocks(htmlString) {
    const blocks = [];
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = htmlString;

    tempDiv.childNodes.forEach(node => {
        const textContent = node.textContent.trim();
        if (!textContent) return;

        if (node.nodeName.match(/^H[2-4]$/)) {
            blocks.push({
                object: 'block',
                type: 'heading_2',
                heading_2: { rich_text: [{ type: 'text', text: { content: textContent } }] }
            });
        } else if (node.nodeName === 'UL') {
            node.querySelectorAll('li').forEach(li => {
                if (li.textContent.trim()) {
                    blocks.push({
                        object: 'block',
                        type: 'bulleted_list_item',
                        bulleted_list_item: { rich_text: [{ type: 'text', text: { content: li.textContent.trim() } }] }
                    });
                }
            });
        } else if (node.nodeName === 'P') {
            blocks.push({
                object: 'block',
                type: 'paragraph',
                paragraph: { rich_text: [{ type: 'text', text: { content: textContent } }] }
            });
        }
    });

    // 添加一个分割线和导出时间戳，增加上下文
    blocks.push({ object: 'block', type: 'divider', divider: {} });
    blocks.push({
        object: 'block',
        type: 'paragraph',
        paragraph: {
            rich_text: [{
                type: 'text',
                text: { content: `Generated by EfficienTodo on ${new Date().toLocaleString()}` },
                annotations: { italic: true, color: 'gray' }
            }]
        }
    });
    return blocks;
}

async function executeNotionExport() {
    const exportBtn = document.getElementById('export-to-notion-btn');
    if (exportBtn) {
        exportBtn.disabled = true;
        exportBtn.textContent = "导出中...";
    }

    openCustomPrompt({
        title: "正在导出到Notion...",
        message: "请稍候，正在将报告发送到您的Notion工作区。",
        inputType: 'none',
        hideConfirmButton: true,
        hideCancelButton: true
    });

    try {
        const accessToken = await db.get('notion_access_token');
        const parentId = await db.get('notion_parent_page_id');

        if (!accessToken || !parentId) {
            closeCustomPrompt(() => {
                selectNotionParentPage();
            });
            return;
        }

        const parentType = await db.get('notion_parent_type');
        const pendingExportRaw = localStorage.getItem('pendingNotionExport');
        
        if (!pendingExportRaw) {
            const currentTitle = aiReportTitle.textContent;
            const currentContent = aiReportContent.innerHTML;
            if(!currentTitle || !currentContent) {
                throw new Error("找不到待导出的报告内容。请重新生成报告。");
            }
            localStorage.setItem('pendingNotionExport', JSON.stringify({ title: currentTitle, content: currentContent }));
        }
        
        const pendingExport = JSON.parse(localStorage.getItem('pendingNotionExport'));
        const reportTitle = pendingExport.title;
        const reportHtml = pendingExport.content;
        const notionBlocks = htmlToNotionBlocks(reportHtml);

        let requestBody;
        
        // --- 【核心修复】开始 ---
        if (parentType === 'database') {
            // 1. 动态获取数据库的标题属性名称
            const PROXY_DB_URL = `https://notion-auth-proxy.martinlinzhiwu.workers.dev/notion-proxy/v1/databases/${parentId}`;
            
            const dbResponse = await fetch(PROXY_DB_URL, {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Notion-Version': '2022-06-28'
                }
            });

            if (!dbResponse.ok) {
                throw new Error('无法获取目标Notion数据库的信息，请检查授权或数据库是否存在。');
            }

            const dbData = await dbResponse.json();
            
            // 2. 查找类型为 "title" 的属性
            const titlePropertyName = Object.keys(dbData.properties).find(
                key => dbData.properties[key].type === 'title'
            );

            if (!titlePropertyName) {
                throw new Error('在目标Notion数据库中未找到标题属性(Title Property)。');
            }

            console.log(`动态识别到数据库标题属性为: "${titlePropertyName}"`);

            // 3. 使用动态获取的标题属性名称构建请求体
            requestBody = {
                parent: { database_id: parentId },
                properties: {
                    [titlePropertyName]: { // 使用方括号语法动态设置属性名
                        title: [{ text: { content: reportTitle } }]
                    }
                }
            };
            if (notionBlocks.length > 0) requestBody.children = notionBlocks;

        } else { // 如果是页面，逻辑保持不变
            requestBody = {
                parent: { page_id: parentId },
                properties: { 
                    title: { // 页面的标题属性固定为 'title'
                        title: [{ text: { content: reportTitle } }] 
                    } 
                },
                children: notionBlocks
            };
        }
        // --- 【核心修复】结束 ---
        
        const PROXY_PAGES_URL = 'https://notion-auth-proxy.martinlinzhiwu.workers.dev/notion-proxy/v1/pages';

        const response = await fetch(PROXY_PAGES_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Notion-Version': '2022-06-28',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        const responseData = await response.json();

        if (!response.ok) {
            if (responseData.code === 'invalid_grant' || responseData.code === 'unauthorized' || response.status === 401) {
                 await db.set('notion_access_token', null);
                 throw new Error("Notion授权已过期或失效，请点击“导出”按钮重新授权。");
            }
            // 【优化】提供更详细的错误信息
            const apiErrorMessage = responseData.message || JSON.stringify(responseData);
            throw new Error(`Notion API Error: ${apiErrorMessage}`);
        }
        
        const newPage = responseData;
        localStorage.removeItem('pendingNotionExport');

        closeCustomPrompt(() => {
            openCustomPrompt({
                title: "导出成功！",
                htmlContent: `<p>报告已成功导出到Notion。</p><a href="${newPage.url}" target="_blank" class="custom-prompt-btn custom-prompt-confirm" style="display:inline-block; margin-top:10px; text-decoration:none;">在Notion中查看</a>`,
                hideConfirmButton: true,
                cancelText: '完成'
            });
        });

    } catch (error) {
        closeCustomPrompt(() => {
            openCustomPrompt({ title: "导出失败", message: error.message, confirmText: "好的" });
        });
    } finally {
        if (exportBtn) {
            exportBtn.disabled = false;
            exportBtn.textContent = "导出到Notion ✨";
        }
    }
}


let GAPI_INSTANCE = null;
let GIS_OAUTH2_INSTANCE = null;

// ========================================================================
// 8. 应用初始化
// ========================================================================
function bindEventListeners() {
 
// 建议添加到 bindEventListeners 函数中
let syncTimeout = null;
const triggerSync = () => {
    // 使用防抖，避免短时间内（如快速切换窗口）重复触发
    clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
        if (isDataDirty) { 
            console.log('Visibility change detected and data is dirty, triggering auto-sync.');
            const syncButton = document.getElementById('sync-drive-btn');
            if (syncButton && !syncButton.disabled) {
                syncButton.click();
            }
        } else {
            console.log('Visibility change detected, but data is clean. Skipping sync.');
        }
    }, 1000); 
};

// 当页面变为可见时触发同步
window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        triggerSync();
    }
});

// 当窗口获得焦点时也触发（作为补充）
window.addEventListener('focus', triggerSync);

 if (syncDriveBtn && syncStatusSpan) {
    syncDriveBtn.addEventListener('click', async () => {
        // Stop any pending auto-sync
        if (autoSyncTimer) {
            clearTimeout(autoSyncTimer);
            autoSyncTimer = null;
        }

        console.log("Manual sync: Pushing local data to cloud.");
        syncStatusSpan.textContent = '准备同步...';
        syncDriveBtn.disabled = true;

        try {
            // This will automatically handle getting a valid token or prompting for re-auth
            await driveSync.findOrCreateFile();

            if (!isDataDirty) {
                console.log("Manual sync: No local changes to push.");
                syncStatusSpan.textContent = '数据已是最新';
                setTimeout(() => { if(syncStatusSpan.textContent === '数据已是最新') syncStatusSpan.textContent = ''; }, 3000);
                return; // Exit early if there's nothing to sync
            }

            syncStatusSpan.textContent = '正在上传...';
            await driveSync.upload(allTasks);

            // --- Success Logic ---
            isDataDirty = false;
            updateSyncIndicator(); // This will show '已同步'
            const timeString = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
            localStorage.setItem('lastSyncTime', timeString);
            syncStatusSpan.textContent = `已于 ${timeString} 同步`;
            setTimeout(() => {
                // Clear the success message after a few seconds
                 if (syncStatusSpan.textContent.includes('同步')) {
                    syncStatusSpan.textContent = '';
                 }
            }, 7000);

        } catch (error) {
            console.error("Manual sync failed:", error);
            const errorMessage = error.message || '未知错误';
            if (error.message !== "REAUTH_REQUIRED") { // The prompt is already shown by gapiClientRequest
                syncStatusSpan.textContent = `同步错误: ${errorMessage.substring(0, 40)}...`;
            }
        } finally {
            // This block ALWAYS runs
            syncDriveBtn.disabled = false;
        }
    });
}

const exportToNotionBtn = document.getElementById('export-to-notion-btn');
if (exportToNotionBtn) {
    exportToNotionBtn.addEventListener('click', handleExportToNotionClick);
}

// 【新增】绑定备份与恢复的事件
    if (backupRestoreBtn) {
        backupRestoreBtn.addEventListener('click', () => {
            openCustomPrompt({
                title: '备份与恢复',
                message: '您可以下载完整备份文件，或从每日自动快照中恢复。',
                htmlContent: `
                    <div class="custom-prompt-actions" style="flex-direction: column; gap: 10px;">
                        <button id="backup-btn" class="custom-prompt-btn custom-prompt-confirm">备份当前数据到文件</button>
                        <button id="restore-btn" class="custom-prompt-btn">从文件恢复...</button>
                        <button id="view-history-btn" class="custom-prompt-btn">查看历史快照...</button>
                    </div>
                `,
                hideConfirmButton: true,
                hideCancelButton: true,
                onRender: () => {
                    document.getElementById('backup-btn').onclick = () => { handleBackup(); closeCustomPrompt(); };
                    document.getElementById('restore-btn').onclick = () => { closeCustomPrompt(); restoreFileInput.click(); };
                    document.getElementById('view-history-btn').onclick = () => { closeCustomPrompt(); showVersionHistoryModal(); };
                }
            });
        });
    }

// 监听文件选择框的变化，用于恢复
if (restoreFileInput) {
    restoreFileInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const restoredData = JSON.parse(e.target.result);
                // 验证数据基本结构
                if (restoredData && restoredData.monthly && restoredData.daily) {
                    // 数据看似有效，打开最终确认恢复的模态框
                    showRestoreConfirmation(restoredData);
                } else {
                    throw new Error('文件格式无效或不包含预期数据。');
                }
            } catch (error) {
                openCustomPrompt({
                    title: '恢复失败',
                    message: `无法解析备份文件。请确保文件未损坏且格式正确。\n错误: ${error.message}`,
                    inputType: 'none',
                    confirmText: '好的',
                    hideCancelButton: true
                });
            }
        };
        reader.readAsText(file);
        // 重置文件输入框，以便下次能选择同一个文件
        event.target.value = '';
    });
}

if (versionHistoryCloseBtn) versionHistoryCloseBtn.addEventListener('click', hideVersionHistoryModal);
if (versionHistoryModal) versionHistoryModal.addEventListener('click', (e) => {
    if(e.target === versionHistoryModal) hideVersionHistoryModal();
});

   if (bottomNav) {
        bottomNav.addEventListener('click', (e) => {
            const tab = e.target.closest('.tab-item');
            if (!tab || !tab.dataset.section) return; 
            e.preventDefault();
            switchView(tab.dataset.section);
        });
    }

    const allModals = document.querySelectorAll('.modal-overlay');
    allModals.forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) { 
                closeModal(modal);
                if (modal === customPromptModal && typeof currentPromptConfig.onCancel === 'function') {
                    currentPromptConfig.onCancel(); 
                }
                if (modal === annualReportModal) closeAnnualReportModal(); 
            }
        });
        const closeBtn = modal.querySelector('.modal-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                closeModal(modal);
                if (modal === customPromptModal && typeof currentPromptConfig.onCancel === 'function') {
                    currentPromptConfig.onCancel();
                }
                if (modal === annualReportModal) closeAnnualReportModal();
            });
        }
    });

    if (statsBtn) statsBtn.addEventListener('click', () => {
 if (statsModal) {
                // 调用我们在 app.js 中新定义的、统一的统计处理函数
                handleStatsButtonClick();
            } else {
                // 如果模态框不存在，在控制台给出警告
                console.warn("统计模态框的 DOM 元素 (statsModal) 未找到。");
                // 你也可以在这里给用户一个提示，比如弹出一个自定义提示框
                // openCustomPrompt({title:"错误", message:"无法打开统计分析，相关界面元素丢失。", inputType:'none', confirmText:'好的', hideCancelButton:true});
            }
        });
    
    if (faqBtn) faqBtn.addEventListener('click', showFaqModal);
    if (featuresBtn) featuresBtn.addEventListener('click', showFeaturesModal);
    if (donateBtn) donateBtn.addEventListener('click', () => openModal(donateModal));



const manualRefreshBtn = document.getElementById('manual-refresh-btn');
if (manualRefreshBtn) {
    manualRefreshBtn.addEventListener('click', forceRefreshData);
}


    if (monthlyHistoryBtn) { 
        monthlyHistoryBtn.addEventListener('click', () => { 
            if (selectedMonthlyDisplayMonth !== 'current') { 
                resetToCurrent('monthly'); 
            } else { 
                openHistoryModal('monthly'); 
            } 
        }); 
    }
    if (ledgerHistoryBtn) { 
        ledgerHistoryBtn.addEventListener('click', () => { 
            if (selectedLedgerMonth !== 'current') { 
                resetToCurrent('ledger'); 
            } else { 
                openHistoryModal('ledger'); 
            } 
        }); 
    }
    

// --- 【新增/修改】处理“更多”菜单的逻辑 ---
    const moreActionsBtn = document.getElementById('more-actions-btn'); // 在 initializeApp 中获取
    const moreActionsMenu = document.getElementById('more-actions-menu'); // 在 initializeApp 中获取

    if (moreActionsBtn && moreActionsMenu) {
        moreActionsBtn.addEventListener('click', (event) => {
            event.stopPropagation(); // 防止点击事件冒泡到 document
            moreActionsMenu.classList.toggle('visible');
            
            const isExpanded = moreActionsMenu.classList.contains('visible');
            moreActionsBtn.setAttribute('aria-expanded', isExpanded.toString());
        });

        // 点击菜单外部时关闭菜单
        document.addEventListener('click', (event) => {
            if (moreActionsMenu.classList.contains('visible') && 
                !moreActionsMenu.contains(event.target) && 
                event.target !== moreActionsBtn && 
                !moreActionsBtn.contains(event.target) 
            ) {
                moreActionsMenu.classList.remove('visible');
                moreActionsBtn.setAttribute('aria-expanded', 'false');
            }
        });

        // 点击菜单项后，关闭菜单 (菜单项按钮自身的原有功能会继续执行)
        moreActionsMenu.querySelectorAll('button').forEach(button => {
            button.addEventListener('click', () => {
                // 这里不需要阻止按钮的默认行为或事件冒泡
                // 按钮原有的事件监听器（如打开模态框）会正常触发
                moreActionsMenu.classList.remove('visible');
                moreActionsBtn.setAttribute('aria-expanded', 'false');
            });
        });

        // 按下 Escape 键关闭菜单
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && moreActionsMenu.classList.contains('visible')) {
                moreActionsMenu.classList.remove('visible');
                moreActionsBtn.setAttribute('aria-expanded', 'false');
            }
        });
    }

    if (themeToggleBtn) themeToggleBtn.addEventListener('click', toggleTheme);
    if (feedbackBtn) feedbackBtn.addEventListener('click', () => { 
        window.open('mailto:martinlinzhiwu@gmail.com?subject=Regarding EfficienTodo PWA', '_blank'); 
    });
    if (toggleNotificationsBtn) toggleNotificationsBtn.addEventListener('click', toggleNotificationSetting);
    if (mainSearchInput) { 
        mainSearchInput.addEventListener('input', (e) => { 
            currentSearchTerm = e.target.value.trim().toLowerCase(); 
            renderAllLists(); 
        }); 
    }

    if (addDailyTaskBtn && newDailyTaskInput) {
        addDailyTaskBtn.addEventListener('click', () => addTask(newDailyTaskInput, 'daily', renderAllLists, { type: 'daily' }));
        newDailyTaskInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') addDailyTaskBtn.click(); });
    }
    if (addMonthlyTaskBtn && newMonthlyTaskInput && newMonthlyTagsInput) {
        const addMonthlyHandler = () => addTask(newMonthlyTaskInput, 'monthly', renderAllLists, { type: 'monthly', tagsInputElement: newMonthlyTagsInput });
        addMonthlyTaskBtn.addEventListener('click', addMonthlyHandler);
        newMonthlyTaskInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') addMonthlyHandler(); });
        newMonthlyTagsInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') addMonthlyHandler(); });
    }
    if (addFutureTaskBtn && newFutureTaskInput && futureTaskDateTimeInput) {
        addFutureTaskBtn.addEventListener('click', () => addTask(newFutureTaskInput, 'future', renderAllLists, { type: 'future', dateElement: futureTaskDateTimeInput }));
    }

    if (addLedgerBtn && ledgerDateInput && ledgerItemInput && ledgerAmountInput) { 
        const addLedgerEntry = () => { 
            const date = ledgerDateInput.value; 
            const item = ledgerItemInput.value.trim(); 
            const amountStr = ledgerAmountInput.value.trim(); 
            const payment = ledgerPaymentInput ? ledgerPaymentInput.value.trim() : ''; 
            const details = ledgerDetailsInput ? ledgerDetailsInput.value.trim() : ''; 
            if (!date || !item || !amountStr) { 
                openCustomPrompt({ title: "输入不完整", message: "请完整填写日期、项目和金额！", inputType: 'none', confirmText: "好的", hideCancelButton: true }); 
                return; 
            } 
            const amount = parseFloat(amountStr);
            if (isNaN(amount) || amount <= 0) {
                 openCustomPrompt({ title: "金额无效", message: "请输入有效的正数金额！", inputType: 'none', confirmText: "好的", hideCancelButton: true }); 
                return;
            }
            if (!allTasks.ledger) allTasks.ledger = []; 
            allTasks.ledger.unshift({ date, item, amount, payment, details }); 
            ledgerDateInput.valueAsDate = new Date(); 
            ledgerItemInput.value = ''; 
            ledgerAmountInput.value = ''; 
            if(ledgerPaymentInput) ledgerPaymentInput.value = ''; 
            if(ledgerDetailsInput) ledgerDetailsInput.value = ''; 
            ledgerItemInput.focus(); 
            saveTasks().then(renderAllLists);
        }; 
        addLedgerBtn.addEventListener('click', addLedgerEntry); 
        const ledgerInputsForEnter = [ledgerItemInput, ledgerAmountInput, ledgerPaymentInput, ledgerDetailsInput].filter(Boolean);
        ledgerInputsForEnter.forEach((input, idx) => { 
            if (input) {
                input.addEventListener('keypress', e => { 
                    if (e.key === 'Enter') {
                        // 如果是最后一个输入框，或者下一个必填项（假设item和amount是必填）为空，则尝试添加
                        if (idx === ledgerInputsForEnter.length - 1 || 
                            (ledgerInputsForEnter[idx+1] === ledgerAmountInput && !ledgerAmountInput.value.trim()) ||
                            (ledgerInputsForEnter[idx+1] !== ledgerAmountInput && !ledgerInputsForEnter[idx+1].value.trim())
                           ) {
                            addLedgerEntry(); 
                        } else if (ledgerInputsForEnter[idx+1]) {
                            ledgerInputsForEnter[idx+1].focus(); 
                        }
                    }
                }); 
            }
        }); 
    }

    if (historyPrevYearBtn) historyPrevYearBtn.addEventListener('click', () => changeHistoryYear(-1));
    if (historyNextYearBtn) historyNextYearBtn.addEventListener('click', () => changeHistoryYear(1));
    if (downloadMonthlyTemplateBtn) downloadMonthlyTemplateBtn.addEventListener('click', downloadMonthlyTemplate);
    if (exportMonthlyHistoryBtn) exportMonthlyHistoryBtn.addEventListener('click', exportMonthlyHistory);
    if (importMonthlyBtn && importMonthlyFileInput) {
        importMonthlyBtn.addEventListener('click', () => importMonthlyFileInput.click());
        importMonthlyFileInput.addEventListener('change', handleMonthlyImport);
    }
    if (downloadLedgerTemplateBtn) downloadLedgerTemplateBtn.addEventListener('click', downloadLedgerTemplate);
    if (exportLedgerHistoryBtn) exportLedgerHistoryBtn.addEventListener('click', exportLedgerHistory);
    if (importLedgerBtn && importLedgerFileInput) {
        importLedgerBtn.addEventListener('click', () => importLedgerFileInput.click());
        importLedgerFileInput.addEventListener('change', handleLedgerImport);
    }
    if (sortMonthlyByPriorityBtn) sortMonthlyByPriorityBtn.addEventListener('click', sortMonthlyTasksByPriority);
    if (setBudgetBtn) setBudgetBtn.addEventListener('click', openBudgetModal);
    if (annualReportBtn) annualReportBtn.addEventListener('click', openAnnualReportModal);
    if (currencyPickerBtn) currencyPickerBtn.addEventListener('click', openCurrencyPicker);

    if (customPromptConfirmBtn) {
        customPromptConfirmBtn.addEventListener('click', () => {
            if(typeof currentPromptConfig.onConfirm === 'function') {
                const inputField = document.getElementById('custom-prompt-input-field');
                const value = inputField ? inputField.value : undefined;
                if(currentPromptConfig.onConfirm(value) !== false) {
                    closeCustomPrompt();
                }
            } else {
                closeCustomPrompt();
            }
        });
    }
    if(customPromptCancelBtn) {
        customPromptCancelBtn.addEventListener('click', () => { 
            if(typeof currentPromptConfig.onCancel === 'function') currentPromptConfig.onCancel(); 
            closeCustomPrompt(); 
        });
    }
    

// 当点击统计按钮时，app.js 可以先确保数据已传递
// (在 app.js 的 bindEventListeners 中)
    if (statsBtn) {
        statsBtn.addEventListener('click', () => {
            // 确保统计模态框的 DOM 元素存在
            if (statsModal) {
                // 调用我们在 app.js 中新定义的、统一的统计处理函数
                handleStatsButtonClick();
            } else {
                // 如果模态框不存在，在控制台给出警告
                console.warn("统计模态框的 DOM 元素 (statsModal) 未找到。");
                // 你也可以在这里给用户一个提示，比如弹出一个自定义提示框
                // openCustomPrompt({title:"错误", message:"无法打开统计分析，相关界面元素丢失。", inputType:'none', confirmText:'好的', hideCancelButton:true});
            }
        });
    }

if (aiSettingsBtn) {
    aiSettingsBtn.addEventListener('click', showAiSettingsModal);
}
if (aiAssistantBtn) {
    aiAssistantBtn.addEventListener('click', () => openModal(aiAssistantModal));
}


if (aiPromptInput) {
    aiPromptInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleAiProcess();
        }
    });
}

    // --- 调整 aiAssistantBtn 的监听器 ---
    if (aiAssistantBtn) {
        aiAssistantBtn.addEventListener('click', () => {
            // 每次打开时，重置为“智能添加”模式
            aiAddView.classList.remove('hidden');
            aiReportView.classList.add('hidden');
            aiModeAddBtn.classList.add('active');
            aiModeReportBtn.classList.remove('active');
            
            // 重置报告视图到初始状态
            reportOptionsGrid.classList.remove('hidden');
            aiReportOutput.classList.add('hidden');

            openModal(aiAssistantModal);
        });
    }

    // --- 新增模式切换的监听器 ---
    if (aiModeSelector) {
        aiModeSelector.addEventListener('click', (e) => {
            if (e.target.tagName !== 'BUTTON') return;
            
            // 移除所有按钮的 active 状态
            aiModeSelector.querySelectorAll('button').forEach(btn => btn.classList.remove('active'));
            // 为被点击的按钮添加 active 状态
            e.target.classList.add('active');
            
            const viewId = e.target.dataset.view;
            // 隐藏所有视图
            document.querySelectorAll('.ai-view').forEach(view => view.classList.add('hidden'));
            // 显示目标视图
            if (document.getElementById(viewId)) {
                document.getElementById(viewId).classList.remove('hidden');
            }
        });
    }

  if (reportOptionsGrid) {
        reportOptionsGrid.addEventListener('click', (e) => {
            if (e.target.tagName === 'BUTTON') {
                const reportType = e.target.dataset.reportType;
                // 【修改】调用新的准备函数，而不是直接生成
                prepareReportConfirmation(reportType);
            }
        });
    }
    
    // --- 报告返回按钮的监听器 ---
    if (aiReportBackBtn) {
        aiReportBackBtn.addEventListener('click', () => {
            reportOptionsGrid.classList.remove('hidden');
            aiReportOutput.classList.add('hidden');
            
            // 【新增】当返回时，清理掉“确认生成”按钮
            const confirmBtn = document.getElementById('ai-confirm-generate-btn');
            if (confirmBtn) confirmBtn.remove();
            // 【新增】当返回选择时，也隐藏Notion授权警告
            const warningEl = document.getElementById('notion-auth-warning');
            if (warningEl) warningEl.classList.add('hidden');
        });
    }

 if (aiProcessBtn) {
    aiProcessBtn.addEventListener('click', handleAiProcess);
}

   if (aiReportCopyBtn) {
        aiReportCopyBtn.addEventListener('click', () => {
            const reportText = aiReportContent.innerText; // 获取纯文本内容
            navigator.clipboard.writeText(reportText).then(() => {
                aiReportCopyBtn.textContent = '已复制!';
                setTimeout(() => { aiReportCopyBtn.textContent = '复制报告'; }, 2000);
            }).catch(err => {
                console.error('复制失败: ', err);
            });
        });
    }

if (aiAssistantCloseBtn) {
    aiAssistantCloseBtn.addEventListener('click', () => closeModal(aiAssistantModal));
}


        // 确保统计模态框内的时间选择器事件被绑定
    setupStatsTimespanSelectors();
}
// ========================================================================
// 统计分析图表功能
// ========================================================================

let taskCompletionByTagChartInstance = null;
let taskTagDistributionChartInstance = null;
// currentChartData 变量不再全局需要，数据准备在各自函数内完成

// 辅助函数：格式化日期用于图表标签
// (span: 'daily', 'weekly', 'monthly', 'yearly')
function formatChartDateLabel(dateObj, span) {
    const year = dateObj.getFullYear();
    const month = dateObj.getMonth() + 1;
    const day = dateObj.getDate();

    if (span === 'daily') {
        return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    } else if (span === 'weekly') {
        // 计算 ISO 8601 周数
        const d = new Date(Date.UTC(year, dateObj.getMonth(), day));
        d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); // 设置到周四
        const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
        const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
        return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
    } else if (span === 'monthly') {
        return `${year}-${String(month).padStart(2, '0')}`;
    } else if (span === 'yearly') {
        return `${year}`;
    }
    return dateObj.toISOString().slice(0, 10); // 备用
}

// 辅助函数：生成图表的日期标签数组
function generateChartDateLabels(span, periodCount) {
    const labels = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0); // 标准化到天的开始

    if (span === 'daily') {
        for (let i = 0; i < periodCount; i++) {
            const date = new Date(today);
            date.setDate(today.getDate() - (periodCount - 1 - i));
            labels.push(formatChartDateLabel(date, span));
        }
    } else if (span === 'weekly') {
        let currentIterDate = new Date(today);
        // 将迭代日期设置为当前周的周一
        currentIterDate.setDate(today.getDate() - (today.getDay() === 0 ? 6 : today.getDay() - 1));
        for (let i = 0; i < periodCount; i++) {
            const date = new Date(currentIterDate);
            date.setDate(currentIterDate.getDate() - (periodCount - 1 - i) * 7);
            labels.push(formatChartDateLabel(date, span));
        }
    } else if (span === 'monthly') {
        for (let i = 0; i < periodCount; i++) {
            const date = new Date(today.getFullYear(), today.getMonth() - (periodCount - 1 - i), 1);
            labels.push(formatChartDateLabel(date, span));
        }
    } else if (span === 'yearly') {
        for (let i = 0; i < periodCount; i++) {
            const year = today.getFullYear() - (periodCount - 1 - i);
            labels.push(formatChartDateLabel(new Date(year, 0, 1), span));
        }
    }
    return labels;
}

// 准备“已完成任务趋势”图表的数据
function prepareTaskCompletionData(span = 'daily', period = 30) {
    if (!allTasks || (!allTasks.monthly && !allTasks.history)) {
        console.warn("统计：无法准备任务完成数据，缺少 'monthly' 或 'history' 数据。");
        return { labels: [], datasets: [] };
    }

    const labels = generateChartDateLabels(span, period);
    const datasetsMap = new Map(); // 用于存储每个标签的数据 { tag: [count1, count2,...] }
    const totalCounts = new Array(labels.length).fill(0);

    const processTask = (task) => {
        if (task.completed && task.completionDate) {
            const completionDateObj = new Date(task.completionDate);
            const labelForCompletion = formatChartDateLabel(completionDateObj, span);
            const labelIndex = labels.indexOf(labelForCompletion);

            if (labelIndex !== -1) {
                totalCounts[labelIndex]++;
                const taskTags = task.tags && task.tags.length > 0 ? task.tags : ['无标签'];
                taskTags.forEach(tag => {
                    if (!datasetsMap.has(tag)) {
                        datasetsMap.set(tag, new Array(labels.length).fill(0));
                    }
                    datasetsMap.get(tag)[labelIndex]++;
                });
            }
        }
    };

    // 处理当前月份的任务
    (allTasks.monthly || []).forEach(processTask);
    // 处理历史月份的任务
    Object.values(allTasks.history || {}).flat().forEach(processTask);

    const finalDatasets = [];
    // "总计" 折线
    finalDatasets.push({
        label: '总计完成',
        data: totalCounts,
        borderColor: 'rgba(75, 192, 192, 1)',
        backgroundColor: 'rgba(75, 192, 192, 0.2)',
        tension: 0.1,
        fill: true,
        order: 0 //确保总计在最前面或者最后面渲染（视觉上）
    });

    // 为每个标签创建折线
    const tagColors = ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40', '#C9CBCF'];
    let colorIndex = 0;
    datasetsMap.forEach((counts, tag) => {
        finalDatasets.push({
            label: tag,
            data: counts,
            borderColor: tagColors[colorIndex % tagColors.length],
            backgroundColor: tagColors[colorIndex % tagColors.length].replace(')', ', 0.1)').replace('rgb', 'rgba'),
            tension: 0.1,
            fill: false,
            order: colorIndex + 1
        });
        colorIndex++;
    });

    return { labels, datasets: finalDatasets };
}

// 渲染“已完成任务趋势”图表
function renderTaskCompletionByTagChart(span = 'daily', period = 30) {
    if (typeof Chart === 'undefined') {
        console.warn("统计：Chart.js 未加载。");
        return;
    }
    const ctx = document.getElementById('taskCompletionByTagChart')?.getContext('2d');
    if (!ctx) {
        console.warn("统计：ID 'taskCompletionByTagChart' 的 canvas 元素未找到。");
        return;
    }

    const chartData = prepareTaskCompletionData(span, period);

    if (taskCompletionByTagChartInstance) {
        taskCompletionByTagChartInstance.destroy();
    }
    taskCompletionByTagChartInstance = new Chart(ctx, {
        type: 'line',
        data: chartData,
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        stepSize: 1,
                        precision: 0
                    }
                }
            },
            plugins: {
                title: { display: false },
                legend: { position: 'top' }
            }
        }
    });
}

// 准备“任务标签分布”饼图的数据
function prepareTaskTagDistributionData(period = 'today') {
    if (!allTasks || (!allTasks.monthly && !allTasks.history)) {
        console.warn("统计：无法准备标签分布数据，缺少 'monthly' 或 'history' 数据。");
        return { labels: [], datasets: [{ data: [] }] };
    }

    const tagCounts = {};
    const now = new Date();
    const todayFormatted = formatChartDateLabel(now, 'daily');
    const thisMonthFormatted = formatChartDateLabel(now, 'monthly');
    const thisYearFormatted = formatChartDateLabel(now, 'yearly');

    const processTask = (task) => {
        if (task.completed && task.completionDate) {
            const completionDateObj = new Date(task.completionDate);
            let includeTask = false;

            if (period === 'today' && formatChartDateLabel(completionDateObj, 'daily') === todayFormatted) {
                includeTask = true;
            } else if (period === 'thisMonth' && formatChartDateLabel(completionDateObj, 'monthly') === thisMonthFormatted) {
                includeTask = true;
            } else if (period === 'thisYear' && formatChartDateLabel(completionDateObj, 'yearly') === thisYearFormatted) {
                includeTask = true;
            }

            if (includeTask) {
                const taskTags = task.tags && task.tags.length > 0 ? task.tags : ['无标签'];
                taskTags.forEach(tag => {
                    tagCounts[tag] = (tagCounts[tag] || 0) + 1;
                });
            }
        }
    };

    (allTasks.monthly || []).forEach(processTask);
    Object.values(allTasks.history || {}).flat().forEach(processTask);

    const sortedTags = Object.entries(tagCounts).sort(([, a], [, b]) => b - a); // 按数量降序

    return {
        labels: sortedTags.map(([tag]) => tag),
        datasets: [{
            data: sortedTags.map(([, count]) => count),
            backgroundColor: [ // 可以扩展或动态生成颜色
                '#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40',
                '#C9CBCF', '#E7E9ED', '#8A2BE2', '#7FFF00'
            ],
            hoverOffset: 4
        }]
    };
}

// 渲染“任务标签分布”饼图
function renderTaskTagDistributionChart(period = 'today') {
    if (typeof Chart === 'undefined') {
        console.warn("统计：Chart.js 未加载。");
        return;
    }
    const ctx = document.getElementById('taskTagDistributionChart')?.getContext('2d');
    if (!ctx) {
        console.warn("统计：ID 'taskTagDistributionChart' 的 canvas 元素未找到。");
        return;
    }

    const chartData = prepareTaskTagDistributionData(period);

    if (taskTagDistributionChartInstance) {
        taskTagDistributionChartInstance.destroy();
    }
    taskTagDistributionChartInstance = new Chart(ctx, {
        type: 'pie',
        data: chartData,
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                title: { display: false },
                legend: { position: 'right' },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            let label = context.label || '';
                            if (label) label += ': ';
                            const value = context.parsed;
                            label += value;
                            const total = context.dataset.data.reduce((a, b) => a + b, 0);
                            const percentage = total > 0 ? (value / total * 100).toFixed(1) + '%' : '0%';
                            label += ` (${percentage})`;
                            return label;
                        }
                    }
                }
            }
        }
    });
}

// 渲染所有统计图表的主函数
function renderAllStatsCharts() {
    if (!allTasks || Object.keys(allTasks).length === 0) {
        console.warn("统计：`allTasks` 数据未加载或为空，图表无法渲染。");
        const statsGrid = document.querySelector('#stats-modal .stats-grid');
        if (statsGrid) {
            statsGrid.innerHTML = '<p style="text-align:center; padding: 20px;">统计数据正在加载中或暂无数据...</p>';
        }
        return;
    }
    console.log("统计：开始渲染所有图表。");

    const activeCompletionSelector = document.querySelector('#task-completion-timespan-selector button.active') || document.querySelector('#task-completion-timespan-selector button[data-span="daily"]');
    const completionSpan = activeCompletionSelector.dataset.span;
    const completionPeriod = parseInt(activeCompletionSelector.dataset.period, 10);

    const activeDistributionSelector = document.querySelector('#task-tag-distribution-timespan-selector button.active') || document.querySelector('#task-tag-distribution-timespan-selector button[data-period="today"]');
    const distributionPeriod = activeDistributionSelector.dataset.period;

    const statsGrid = document.querySelector('#stats-modal .stats-grid');
    // 如果之前显示的是加载提示，则恢复 Canvas 结构
    if (statsGrid && statsGrid.querySelector('p')) {
        statsGrid.innerHTML = `
            <div class="chart-card">
                <div class="chart-header">
                    <h2>已完成任务趋势 (按标签)</h2>
                    <div id="task-completion-timespan-selector" class="timespan-selector">
                        <button data-span="daily" data-period="30" class="${completionSpan === 'daily' ? 'active' : ''}">近30天 (日)</button>
                        <button data-span="weekly" data-period="26" class="${completionSpan === 'weekly' ? 'active' : ''}">近半年 (周)</button>
                        <button data-span="monthly" data-period="12" class="${completionSpan === 'monthly' ? 'active' : ''}">近1年 (月)</button>
                        <button data-span="yearly" data-period="5" class="${completionSpan === 'yearly' ? 'active' : ''}">近5年 (年)</button>
                    </div>
                </div>
                <div class="chart-canvas-container"><canvas id="taskCompletionByTagChart"></canvas></div>
            </div>
            <div class="chart-card">
                <div class="chart-header">
                    <h2>已完成任务标签分布</h2>
                    <div id="task-tag-distribution-timespan-selector" class="timespan-selector">
                       <button data-period="today" class="${distributionPeriod === 'today' ? 'active' : ''}">今日</button>
                       <button data-period="thisMonth" class="${distributionPeriod === 'thisMonth' ? 'active' : ''}">本月</button>
                       <button data-period="thisYear" class="${distributionPeriod === 'thisYear' ? 'active' : ''}">今年</button>
                   </div>
                </div>
                <div class="chart-canvas-container"><canvas id="taskTagDistributionChart"></canvas></div>
            </div>`;
        // 由于重写了 HTML，需要重新绑定时间选择器的事件
        setupStatsTimespanSelectors();
    }

    renderTaskCompletionByTagChart(completionSpan, completionPeriod);
    renderTaskTagDistributionChart(distributionPeriod);
}

// 统计按钮点击处理函数
function handleStatsButtonClick() {
    // 确保 allTasks 数据是最新的
    // 在 PWA 版本中，allTasks 是全局变量，理论上应该是最新的
    // 但如果需要，可以在这里强制重新从 db 加载或确认
    if (!allTasks || Object.keys(allTasks).length === 0) {
        console.log("统计：数据未就绪，显示加载提示。");
        const statsModalElement = document.getElementById('stats-modal');
        if (statsModalElement) {
            const statsModalContent = statsModalElement.querySelector('.stats-grid');
            if (statsModalContent) {
                statsModalContent.innerHTML = '<p style="text-align:center; padding: 20px;">正在准备统计数据...</p>';
            }
            openModal(statsModalElement);
            // 尝试加载数据，并在加载完成后渲染图表
            if (typeof loadTasks === 'function') { // 假设 loadTasks 会更新全局的 allTasks
                loadTasks(() => {
                    console.log("统计：数据加载完成，尝试渲染图表。");
                    renderAllStatsCharts();
                });
            }
        }
        return;
    }

    console.log("统计：数据已存在，直接渲染图表。");
    renderAllStatsCharts(); // 渲染图表
    openModal(document.getElementById('stats-modal')); // 打开模态框
}

// 为统计模态框内的时间选择器绑定事件
function setupStatsTimespanSelectors() {
    const taskCompletionSelector = document.getElementById('task-completion-timespan-selector');
    if (taskCompletionSelector) {
        // 先移除旧的监听器，避免重复绑定 (如果此函数可能被多次调用)
        const newSelector = taskCompletionSelector.cloneNode(true);
        taskCompletionSelector.parentNode.replaceChild(newSelector, taskCompletionSelector);

        newSelector.addEventListener('click', (e) => {
            if (e.target.tagName === 'BUTTON') {
                const buttons = newSelector.querySelectorAll('button');
                buttons.forEach(btn => btn.classList.remove('active'));
                e.target.classList.add('active');
                const span = e.target.dataset.span;
                const period = parseInt(e.target.dataset.period, 10);
                renderTaskCompletionByTagChart(span, period);
            }
        });
    }

    const taskTagDistributionSelector = document.getElementById('task-tag-distribution-timespan-selector');
    if (taskTagDistributionSelector) {
        const newSelector = taskTagDistributionSelector.cloneNode(true);
        taskTagDistributionSelector.parentNode.replaceChild(newSelector, taskTagDistributionSelector);

        newSelector.addEventListener('click', (e) => {
            if (e.target.tagName === 'BUTTON') {
                const buttons = newSelector.querySelectorAll('button');
                buttons.forEach(btn => btn.classList.remove('active'));
                e.target.classList.add('active');
                const period = e.target.dataset.period;
                renderTaskTagDistributionChart(period);
            }
        });
    }
}

// ========================================================================
// 统计分析图表功能结束
// ========================================================================

// 备份功能
function handleBackup() {
    // 使用 allTasks 全局变量，它包含了所有最新的数据
    const dataToBackup = JSON.stringify(allTasks, null, 2); // 格式化JSON，增加可读性
    const blob = new Blob([dataToBackup], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    
    const today = new Date();
    const dateString = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    a.href = url;
    a.download = `efficienTodo_backup_${dateString}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    if (syncStatusSpan) {
        syncStatusSpan.textContent = '备份文件已下载！';
        setTimeout(() => { syncStatusSpan.textContent = ''; }, 5000);
    }
}


// 显示恢复确认模态框
function showRestoreConfirmation(restoredData) {
    // 创建一个简单的数据预览
    const previewHtml = `
        <h4>将要恢复的数据预览：</h4>
        <ul>
            <li>每日清单: ${restoredData.daily?.length || 0} 条</li>
            <li>本月待办: ${restoredData.monthly?.length || 0} 条</li>
            <li>未来计划: ${restoredData.future?.length || 0} 条</li>
            <li>记账本: ${restoredData.ledger?.length || 0} 条</li>
            <li>历史归档月份: ${Object.keys(restoredData.history || {}).length} 个</li>
        </ul>
        <p style="color: var(--color-danger); font-weight: bold;">警告：此操作不可逆，将完全覆盖您当前的所有数据！</p>
        <div class="custom-prompt-input-area" style="margin-top: 1rem;">
            <label for="restore-confirm-input">请输入“<b id="confirm-keyword">恢复</b>”以确认：</label>
            <input type="text" id="restore-confirm-input" placeholder="输入确认词" autocomplete="off">
        </div>
    `;

    openCustomPrompt({
        title: '确认恢复数据',
        htmlContent: previewHtml,
        confirmText: '确认恢复',
        onRender: () => {
            const confirmInput = document.getElementById('restore-confirm-input');
            const confirmBtn = document.getElementById('custom-prompt-confirm-btn');
            const confirmKeyword = document.getElementById('confirm-keyword').textContent;

            // 默认禁用确认按钮
            confirmBtn.disabled = true;

            confirmInput.addEventListener('input', () => {
                if (confirmInput.value.trim() === confirmKeyword) {
                    confirmBtn.disabled = false;
                    confirmBtn.classList.add('btn-danger'); // 可选：给按钮添加危险样式
                } else {
                    confirmBtn.disabled = true;
                    confirmBtn.classList.remove('btn-danger');
                }
            });
        },
        onConfirm: () => {
            // 执行最终的恢复操作
            // 确保 lastUpdatedLocal 时间戳是最新的，以防止恢复后被旧的云端数据覆盖
            restoredData.lastUpdatedLocal = Date.now();
            allTasks = restoredData; // 直接用恢复的数据替换全局变量
            saveTasks(); // 保存到本地存储
            renderAllLists(); // 刷新UI
            
            // 给出成功提示
            setTimeout(() => {
                openCustomPrompt({
                    title: '恢复成功',
                    message: '数据已成功恢复！您可以选择性地点击“云同步”按钮，将这个状态同步到云端。',
                    inputType: 'none',
                    confirmText: '完成',
                    hideCancelButton: true
                });
            }, 100); // 延迟一点，确保上一个prompt已关闭
            return true; // 确认关闭当前prompt
        }
    });
}

// 【新增】版本历史相关函数
function showVersionHistoryModal() {
    if (!versionHistoryModal) return;
    renderVersionHistory();
    versionHistoryModal.classList.remove('hidden');
}

function hideVersionHistoryModal() {
    if (versionHistoryModal) {
        versionHistoryModal.classList.add('hidden');
    }
}

// 【核心修复】使用 navigator.serviceWorker.ready 和 MessageChannel

function renderVersionHistory() {
    if (!versionListDiv) return;
    versionListDiv.innerHTML = '<p>正在加载历史版本...</p>';

    if (!('serviceWorker' in navigator)) {
        versionListDiv.innerHTML = '<p style="color:var(--color-danger);">浏览器不支持此功能。</p>';
        return;
    }

    navigator.serviceWorker.ready.then(registration => {
        if (!registration || !registration.active) {
            versionListDiv.innerHTML = '<p style="color:var(--color-danger);">后台服务未激活，请刷新页面重试。</p>';
            return;
        }

        const messageChannel = new MessageChannel();
        
        messageChannel.port1.onmessage = (event) => {
            const response = event.data;
            if (response && response.success) {
                const versions = response.versions;
                if (versions.length === 0) {
                    versionListDiv.innerHTML = '<p>暂无自动备份的历史快照。</p>';
                    return;
                }
                
                versionListDiv.innerHTML = '';
                const ul = document.createElement('ul');
                versions.forEach(timestamp => {
                    const li = document.createElement('li');
                    li.className = 'version-item';
                    
                    const dateSpan = document.createElement('span');
                    dateSpan.textContent = new Date(timestamp).toLocaleString('zh-CN', { 
                        year: 'numeric', month: '2-digit', day: '2-digit', 
                        hour: '2-digit', minute: '2-digit' 
                    });

                    const applyBtn = document.createElement('button');
                    applyBtn.textContent = '应用此版本';
                    applyBtn.className = 'header-action-btn-small';

                    applyBtn.onclick = () => {
                        openCustomPrompt({
                            title: '确认恢复',
                            message: `您确定要将所有数据恢复到 ${dateSpan.textContent} 的状态吗？此操作将覆盖当前数据。`,
                            confirmText: '确认恢复',
                            onConfirm: () => {
                                // 【修复】使用 MessageChannel 与 SW 通信以恢复数据
                                if (registration.active) {
                                    const restoreChannel = new MessageChannel();
                                    restoreChannel.port1.onmessage = (restoreEvent) => {
                                        const restoreResponse = restoreEvent.data;
                                        if (restoreResponse && restoreResponse.success) {
                                            hideVersionHistoryModal();
                                            // 使用从SW返回的数据更新全局变量
                                            allTasks = restoreResponse.data;
                                            allTasks.lastUpdatedLocal = Date.now();
                                            // 保存并刷新UI
                                            saveTasks().then(() => {
                                                loadTasks(renderAllLists);
                                            });
                                            setTimeout(() => {
                                                openCustomPrompt({title: '成功', message: '数据已成功恢复！', inputType: 'none', confirmText: '好的', hideCancelButton: true});
                                            }, 200);
                                        } else {
                                            openCustomPrompt({title: '失败', message: `恢复失败: ${restoreResponse ? restoreResponse.message : '未知错误'}`, inputType: 'none', confirmText: '好的', hideCancelButton: true});
                                        }
                                    };
                                    registration.active.postMessage({ action: 'restoreFromBackup', timestamp: timestamp }, [restoreChannel.port2]);
                                }
                            }
                        });
                    };

                    li.appendChild(dateSpan);
                    li.appendChild(applyBtn);
                    ul.appendChild(li);
                });
                versionListDiv.appendChild(ul);

            } else {
                versionListDiv.innerHTML = `<p style="color:var(--color-danger);">加载失败: ${response ? response.message : '未知错误'}</p>`;
            }
        };

        // 【修复】发送消息到 SW，并传递 MessageChannel 的端口
        registration.active.postMessage({ action: 'getBackupVersions' }, [messageChannel.port2]);

    }).catch(error => {
        console.error("Service Worker not ready:", error);
        versionListDiv.innerHTML = `<p style="color:var(--color-danger);">无法连接到后台服务: ${error.message}</p>`;
    });
}

async function requestBackupCheck() {
    console.log('[App] Performing daily backup check on startup.');
    if (!('serviceWorker' in navigator)) {
        return;
    }

    try {
        const lastCheck = localStorage.getItem('lastBackupCheckTimestamp');
        const now = Date.now();
        // 检查周期设为 12 小时，更灵活
        const TWELVE_HOURS = 12 * 60 * 60 * 1000; 

        if (lastCheck && (now - parseInt(lastCheck, 10) < TWELVE_HOURS)) {
            console.log('[App] Backup check already performed recently. Skipping.');
            return;
        }

        const registration = await navigator.serviceWorker.ready;
        if (registration && registration.active) {
            console.log('[App] Sending "triggerAutoBackup" message to Service Worker.');
            registration.active.postMessage({ action: 'triggerAutoBackup' });
            localStorage.setItem('lastBackupCheckTimestamp', now.toString());
        } else {
            console.warn('[App] Could not send backup trigger: Service Worker not active.');
        }
    } catch (error) {
        console.error('[App] Error during startup backup check:', error);
    }
}

async function initializeApp() {
    console.log("initializeApp: 开始应用初始化。");
    await handleGoogleAuthCallback();

    // AI Assistant & Report Generator Elements
    aiAssistantBtn = document.getElementById('ai-assistant-btn');
    aiAssistantModal = document.getElementById('ai-assistant-modal');
    aiAssistantCloseBtn = document.getElementById('ai-assistant-close-btn');
    aiModeSelector = document.querySelector('.ai-mode-selector');
    aiModeAddBtn = document.getElementById('ai-mode-add-btn');
    aiModeReportBtn = document.getElementById('ai-mode-report-btn');
    aiAddView = document.getElementById('ai-add-view');
    aiReportView = document.getElementById('ai-report-view');
    aiAddLoading = document.getElementById('ai-add-loading');
    reportOptionsGrid = document.querySelector('.report-options-grid');
    aiReportOutput = document.getElementById('ai-report-output');
    aiReportTitle = document.getElementById('ai-report-title');
    aiReportLoading = document.getElementById('ai-report-loading');
    aiReportContent = document.getElementById('ai-report-content');
    aiReportCopyBtn = document.getElementById('ai-report-copy-btn');
    aiReportBackBtn = document.getElementById('ai-report-back-btn');

statsModal = document.getElementById('stats-modal'); // 确保这行存在且正确
if (!statsModal) {
    console.error("关键错误：未能获取到 stats-modal 元素！请检查 HTML ID。");
}
    // 1. 获取所有 DOM 元素 (确保在此处获取所有需要的元素)
    statsBtn = document.getElementById('stats-btn');
    const statsModals = document.querySelectorAll('#stats-modal'); // ID应该是唯一的，但以防万一
    if (statsModals.length > 0) {
        statsModal = statsModals[0]; 
        if (statsModal) {
            statsModalCloseBtn = statsModal.querySelector('#stats-modal-close-btn'); 
            // 注意：关闭按钮的事件监听器在 bindEventListeners 中统一设置
        }
    }


    faqBtn = document.getElementById('faq-btn');
    faqModal = document.getElementById('faq-modal');
    // faqModalCloseBtn
    faqListDiv = document.getElementById('faq-list');
    mainSearchInput = document.getElementById('main-search-input'); 
    dailyTitleDate = document.getElementById('daily-title-date');
    themeToggleBtn = document.getElementById('theme-toggle-btn');
    feedbackBtn = document.getElementById('feedback-btn');
    donateBtn = document.getElementById('donate-btn');
    dailyTaskList = document.getElementById('daily-task-list');
    monthlyTaskList = document.getElementById('monthly-task-list');
    futureTaskList = document.getElementById('future-task-list');
    ledgerList = document.getElementById('ledger-list');
    monthlyHeaderTitle = document.getElementById('monthly-header-title');
    sortMonthlyByPriorityBtn = document.getElementById('sort-monthly-by-priority-btn');
    ledgerHeaderTitle = document.getElementById('ledger-header-title');
    monthlyInputArea = document.querySelector('#monthly-section .monthly-input-area');
    ledgerInputArea = document.querySelector('#ledger-section .ledger-input-area');
    newDailyTaskInput = document.getElementById('new-daily-task-input');
    addDailyTaskBtn = document.getElementById('add-daily-task-btn');
    newMonthlyTaskInput = document.getElementById('new-monthly-task-input');
    newMonthlyTagsInput = document.getElementById('new-monthly-tags-input');
    addMonthlyTaskBtn = document.getElementById('add-monthly-task-btn');
    newFutureTaskInput = document.getElementById('new-future-task-input');
    futureTaskDateTimeInput = document.getElementById('task-datetime-input');
    addFutureTaskBtn = document.getElementById('add-future-task-btn');
    ledgerDateInput = document.getElementById('ledger-date-input');
    ledgerItemInput = document.getElementById('ledger-item-input');
    ledgerAmountInput = document.getElementById('ledger-amount-input');
    ledgerPaymentInput = document.getElementById('ledger-payment-input');
    ledgerDetailsInput = document.getElementById('ledger-details-input');
    addLedgerBtn = document.getElementById('add-ledger-btn');
    monthlyTagsContainer = document.getElementById('monthly-tags-container');
    ledgerTagsContainer = document.getElementById('ledger-tags-container');
    ledgerSummaryContainer = document.getElementById('ledger-summary-container');
    monthlyHistoryBtn = document.getElementById('monthly-history-btn');
    ledgerHistoryBtn = document.getElementById('ledger-history-btn');
    historyModal = document.getElementById('history-modal');
    // historyModalCloseBtn
    historyModalTitle = document.getElementById('history-modal-title');
    historyPrevYearBtn = document.getElementById('history-prev-year-btn');
    historyNextYearBtn = document.getElementById('history-next-year-btn');
    historyCurrentYearSpan = document.getElementById('history-current-year');
    historyMonthsGrid = document.getElementById('history-months-grid');
    donateModal = document.getElementById('donate-modal');
    // modalCloseBtn (for donate-modal, assumes a specific ID or class handled by generic logic)
    featuresBtn = document.getElementById('features-btn');
    featuresModal = document.getElementById('features-modal');
    // featuresModalCloseBtn
    featuresListUl = document.getElementById('features-list');
    exportMonthlyHistoryBtn = document.getElementById('export-monthly-history-btn');
    importMonthlyBtn = document.getElementById('import-monthly-btn');
    downloadMonthlyTemplateBtn = document.getElementById('download-monthly-template-btn');
    importMonthlyFileInput = document.getElementById('import-monthly-file-input');
    exportLedgerHistoryBtn = document.getElementById('export-ledger-history-btn');
    importLedgerBtn = document.getElementById('import-ledger-btn');
    downloadLedgerTemplateBtn = document.getElementById('download-ledger-template-btn');
    importLedgerFileInput = document.getElementById('import-ledger-file-input');
    toggleNotificationsBtn = document.getElementById('toggle-notifications-btn'); // 确保在 loadNotificationSetting 前获取
    customPromptModal = document.getElementById('custom-prompt-modal');
    // customPromptCloseBtn
    customPromptTitleEl = document.getElementById('custom-prompt-title');
    customPromptMessageEl = document.getElementById('custom-prompt-message');
    customPromptInputContainer = document.getElementById('custom-prompt-input-container');
    customPromptConfirmBtn = document.getElementById('custom-prompt-confirm-btn');
    customPromptCancelBtn = document.getElementById('custom-prompt-cancel-btn');
    setBudgetBtn = document.getElementById('set-budget-btn');
    annualReportBtn = document.getElementById('annual-report-btn');
    annualReportModal = document.getElementById('annual-report-modal');
    // annualReportCloseBtn
    annualReportTitle = document.getElementById('annual-report-title'); // Assuming this exists, if not, remove or use a more generic h2
    annualReportPrevYearBtn = document.getElementById('annual-report-prev-year-btn');
    annualReportNextYearBtn = document.getElementById('annual-report-next-year-btn');
    annualReportCurrentYearSpan = document.getElementById('annual-report-current-year');
    annualReportSummaryDiv = document.getElementById('annual-report-summary');
    annualReportDetailsDiv = document.getElementById('annual-report-details');
    currencyPickerBtn = document.getElementById('currency-picker-btn');
    syncDriveBtn = document.getElementById('sync-drive-btn'); // 确保在 loadGoogleApis 前获取
    syncStatusSpan = document.getElementById('sync-status'); // 确保在 loadGoogleApis 前获取
    bottomNav = document.querySelector('.bottom-tab-nav');
    allSections = document.querySelectorAll('.section[id]');
    backupRestoreBtn = document.getElementById('backup-restore-btn');
    restoreFileInput = document.getElementById('restore-file-input');
    versionHistoryModal = document.getElementById('version-history-modal');
    versionHistoryCloseBtn = document.getElementById('version-history-close-btn');
    versionListDiv = document.getElementById('version-list');
    aiSettingsBtn = document.getElementById('ai-settings-btn');
    aiAssistantBtn = document.getElementById('ai-assistant-btn');
    aiAssistantModal = document.getElementById('ai-assistant-modal');
    aiAssistantCloseBtn = document.getElementById('ai-assistant-close-btn');
    aiPromptInput = document.getElementById('ai-prompt-input');
    aiProcessBtn = document.getElementById('ai-process-btn');
    aiLoadingSpinner = document.getElementById('ai-loading-spinner');
    
    console.log("initializeApp: 所有 DOM 元素已获取。");

     // 2. 绑定事件
    bindEventListeners();
    console.log("initializeApp: 事件监听器已绑定。");

    // 3. 加载非数据设置
    renderDailyQuote();
    loadTheme();
    await loadNotificationSetting();
    console.log("initializeApp: 主题和通知设置已加载。");
    await handleNotionCallback(); 
    // 4. 加载 Google API
  
  try {
        await loadTasks();
        renderAllLists();
        initSortable();
        if (ledgerDateInput) ledgerDateInput.valueAsDate = new Date();
        switchView('daily-section');
        console.log("initializeApp: Local data loaded and UI rendered.");

        // Perform daily maintenance tasks on the now-loaded local data.
        await runAutomaticUpkeepTasks();
    } catch (localError) {
        console.error("initializeApp: A critical error occurred loading local data:", localError);
        openCustomPrompt({ title: "本地数据加载失败", message: localError.message, inputType: 'none', confirmText: '好的', hideCancelButton: true });
        return; // Stop if we can't even load local data.
    }

    // --- Part 3: Asynchronously Initialize Cloud Services ---
    // This part now runs after the user can see their data.
    // Failure here will not block the UI.
    try {
        // Handle potential OAuth2 callback from Google redirect FIRST.
        await handleGoogleAuthCallback();
        await handleNotionCallback();
        
        // Now, attempt to load the Google APIs.
        console.log("initializeApp: Attempting to initialize Google Cloud services...");
        await loadGoogleApis(); // Using the new robust function
        
        // If successful, proceed with the initial cloud sync check.
        await syncWithCloudOnStartup();
        console.log("initializeApp: Google Cloud services initialized and checked.");

    } catch (cloudError) {
        console.error("initializeApp: Failed to initialize cloud services:", cloudError);
        // Inform the user that sync is unavailable, but the app is still usable.
        if (syncStatusSpan) syncStatusSpan.textContent = '云同步不可用';
        if (syncDriveBtn) syncDriveBtn.disabled = true;
        // Do not show a blocking prompt here unless it's an auth error handled inside.
    }


     if ('serviceWorker' in navigator && 'PeriodicSyncManager' in window) {
        try {
            const registration = await navigator.serviceWorker.ready;
            // 在注册前，先检查权限状态
            const status = await navigator.permissions.query({name: 'periodic-background-sync'});
            if (status.state === 'granted') {
                // 权限已授予，可以注册
                await registration.periodicSync.register('daily-todo-backup', {
                    minInterval: 12 * 60 * 60 * 1000, // 至少每 12 小时尝试一次
                });
                console.log('Periodic Background Sync for daily backup registered.');
            } else {
                console.warn('Periodic Background Sync permission not granted. Automatic background backup may not work.');
                // 你可以在这里选择性地向用户解释，或者静默处理
            }
        } catch (e) {
            console.error('Periodic Background Sync could not be registered!', e);
        }
    } else {
        console.log('Periodic Background Sync not supported in this browser. Fallback to activate/startup checks.');
    }

async function handleNotionCallback() {
    const urlParams = new URLSearchParams(window.location.search);
    const authCode = urlParams.get('code');

    if (authCode) {
        // 使用一个固定的、权威的PWA URL来清理地址栏
        const PWA_URL = 'https://alanlinzw.github.io/'; // 你的PWA的固定URL
        window.history.replaceState({}, document.title, PWA_URL);

        // 显示加载提示
        openCustomPrompt({
            title: "正在完成Notion授权...",
            message: "请稍候，正在通过安全代理验证您的授权信息。",
            inputType: 'none',
            hideConfirmButton: true,
            hideCancelButton: true
        });

        try {
            // 定义你的Worker代理URL
            const PROXY_URL = 'https://notion-auth-proxy.martinlinzhiwu.workers.dev/exchange-token';

            // 通过代理，使用POST方法在请求体中发送code
            const response = await fetch(PROXY_URL, {
                method: "POST",
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: authCode })
            });

            const tokenData = await response.json();

            // 检查代理返回的响应是否成功
            if (!response.ok || tokenData.error) {
                throw new Error(tokenData.error || "从代理服务器获取Token失败。请检查Worker日志。");
            }
            
            // 存储获取到的token
            await db.set('notion_access_token', tokenData.access_token);
            await db.set('notion_workspace_id', tokenData.workspace_id);
            
            // 关闭加载提示，进入下一步：选择页面
            closeCustomPrompt();
            await selectNotionParentPage(true); // 传入true表示这是首次设置

        } catch (error) {
            closeCustomPrompt();
            openCustomPrompt({ title: "Notion授权失败", message: error.message, inputType: 'none', confirmText: '好的' });
        }
    }
}


// 【新增】监听来自 Service Worker 的消息
if ('serviceWorker' in navigator) {
    let newWorker;
    
    // 监听新版本安装
    navigator.serviceWorker.ready.then(reg => {
        if (!reg) return;
        reg.addEventListener('updatefound', () => {
            newWorker = reg.installing;
            if (!newWorker) return;
            newWorker.addEventListener('statechange', () => {
                // 当新 SW 安装完成但还在等待激活时，提示用户
                if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    showUpdatePrompt(newWorker);
                }
            });
        });
    }).catch(error => console.error("Error setting up 'updatefound' listener:", error));

    // 检查页面加载时是否已经有等待中的新版本
    navigator.serviceWorker.getRegistration().then(reg => {
        if (reg && reg.waiting) {
            showUpdatePrompt(reg.waiting);
        }
    }).catch(error => console.error("Error checking for waiting Service Worker:", error));

    // 【核心修复】监听 Controller 变化，一旦新 SW 接管，立即刷新页面
    let refreshing;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        console.log("Controller has changed, reloading page to apply updates.");
        window.location.reload();
        refreshing = true;
    });
}
    await requestBackupCheck();



}
document.addEventListener('DOMContentLoaded', initializeApp);
