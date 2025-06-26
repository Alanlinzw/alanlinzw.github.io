// ========================================================================
// app.js (PWA 完整重构版)
// ========================================================================

// ========================================================================
// 1. 全局函数与模块
// 这些代码在脚本加载时立即执行，不依赖DOM
// ========================================================================


// IndexedDB 键值对存储模块 (与之前修复版一致)
const db = (() => {
    let dbInstance;
    const DB_NAME = 'EfficienTodoDB';
    const DB_VERSION = 3;
    const STORE_NAME = 'data';

    function getDB() {
        if (!dbInstance) {
            dbInstance = new Promise((resolve, reject) => {
                const openreq = indexedDB.open(DB_NAME, DB_VERSION);
                openreq.onerror = (event) => {
                    console.error("IndexedDB error:", event.target.error);
                    reject(event.target.error);
                };
                openreq.onsuccess = (event) => {
                    resolve(event.target.result);
                };
                openreq.onupgradeneeded = (event) => {
                    const db = event.target.result;
                    if (!db.objectStoreNames.contains(STORE_NAME)) {
                        db.createObjectStore(STORE_NAME);
                    }
                };
            });
        }
        return dbInstance;
    }

    function promisifyRequest(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = (event) => reject(event.target.error);
        });
    }

    async function withStore(type, callback) {
        const dbHandle = await getDB();
        const tx = dbHandle.transaction(STORE_NAME, type);
        const store = tx.objectStore(STORE_NAME);
        let res;
        try {
            res = await callback(store);
        } catch (error) {
            try {
              if (tx && tx.readyState !== 'done') {
                tx.abort();
              }
            } catch (abortError) {
              console.error("Error aborting transaction:", abortError);
            }
            console.error("Error in withStore callback:", error);
            throw error;
        }
        return new Promise((resolveTransaction, rejectTransaction) => {
            tx.oncomplete = () => resolveTransaction(res);
            tx.onerror = (event) => rejectTransaction(event.target.error);
            tx.onabort = (event) => rejectTransaction(event.target.error || new Error("Transaction aborted in withStore"));
        });
    }

    return {
        get: async (key) => withStore('readonly', store => promisifyRequest(store.get(key))),
        set: async (key, value) => withStore('readwrite', store => promisifyRequest(store.put(value, key))),
    };
})();


// Google Drive Sync Module
const driveSync = {
    CLIENT_ID: '325408458040-bp083eplhebaj5eoe2m9go2rdiir9l6c.apps.googleusercontent.com',
    SCOPES: 'https://www.googleapis.com/auth/drive.file',
    DISCOVERY_DOCS: ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"],
    DRIVE_FILE_NAME: 'efficienTodoData.json',
    tokenClient: null,
    driveFileId: null,
    gapi: null, // 将在此模块外部由 loadGoogleApis 函数设置
    gisOAuth2: null, // 将在此模块外部由 loadGoogleApis 函数设置
    _gapiInitialized: false, // 新增一个标志来跟踪 gapi.client.init 的状态
    _driveApiLoaded: false, // 新增一个标志来跟踪 Drive API 是否已加载

    initClients: async function() {
        console.log("driveSync.initClients: Method invoked.");
        return new Promise((resolve, reject) => {
            if (!driveSync.gapi) {
                const errMsg = "driveSync.initClients: driveSync.gapi is not available (should be set by loadGoogleApis).";
                console.error(errMsg);
                return reject(new Error(errMsg));
            }
            if (!driveSync.gisOAuth2) {
                const errMsg = "driveSync.initClients: driveSync.gisOAuth2 (google.accounts.oauth2) is not available (should be set by loadGoogleApis).";
                console.error(errMsg);
                return reject(new Error(errMsg));
            }
            driveSync.gapi.load('client', async () => {
                try {
                    await driveSync.gapi.client.init({
                        discoveryDocs: driveSync.DISCOVERY_DOCS,
                    });
                    if (driveSync.gisOAuth2 && typeof driveSync.gisOAuth2.initTokenClient === 'function') {
                        driveSync.tokenClient = driveSync.gisOAuth2.initTokenClient({
                            client_id: driveSync.CLIENT_ID,
                            scope: driveSync.SCOPES,
                            callback: '', 
                        });
                        resolve();
                    } else {
                        const errMsg = "driveSync.initClients: driveSync.gisOAuth2.initTokenClient is not a function or driveSync.gisOAuth2 is not correctly set.";
                        console.error(errMsg);
                        reject(new Error(errMsg));
                    }
                } catch (initError) {
                    console.error("driveSync.initClients: Error during gapi.client.init or while setting up gis token client (inner catch):", initError);
                    reject(initError);
                }
            });
        });
    },

        // 辅助函数，确保 GAPI client 和 Drive API 已加载
    ensureGapiClientReady: async function() {
        if (!driveSync.gapi) {
            throw new Error("GAPI library not loaded.");
        }
        if (!driveSync.gisOAuth2) {
            throw new Error("GIS library not loaded.");
        }

        // 确保 gapi.client 已初始化
        if (!driveSync._gapiInitialized) { // 使用标志来避免重复初始化
            console.log("ensureGapiClientReady: Initializing gapi.client...");
            await driveSync.gapi.client.init({
                discoveryDocs: driveSync.DISCOVERY_DOCS,
            });
            driveSync._gapiInitialized = true;
            console.log("ensureGapiClientReady: gapi.client initialized.");
        }

        // 确保 Drive API 已加载
        if (!driveSync.gapi.client.drive && !driveSync._driveApiLoaded) { // 检查 drive API 是否已挂载到 client，并且是否已尝试加载
            console.log("ensureGapiClientReady: Loading Drive API v3...");
            await driveSync.gapi.client.load('drive', 'v3');
            driveSync._driveApiLoaded = true; // 标记 Drive API 已加载
            console.log("ensureGapiClientReady: Drive API v3 loaded.");
        } else if (driveSync.gapi.client.drive) {
            // console.log("ensureGapiClientReady: Drive API already loaded.");
        }
    },

authenticate: async function() {
        console.log("driveSync.authenticate: Authenticating...");
        try {
            await driveSync.ensureGapiClientReady(); // 确保 GAPI 客户端和 Drive API 已准备好
        } catch (e) {
            console.error("driveSync.authenticate: Failed to ensure GAPI client ready:", e);
            throw new Error(`GAPI client setup failed before authentication: ${e.message}`);
        }

        if (!driveSync.tokenClient) {
             console.error("driveSync.authenticate: GIS Token Client not initialized.");
             throw new Error("driveSync.authenticate: GIS Token Client not initialized.");
        }

        return new Promise((resolve, reject) => {
            driveSync.tokenClient.callback = async (tokenResponse) => { // GIS 返回的是 TokenResponse 对象
                if (tokenResponse.error !== undefined) {
                    let errorMessage = 'Google Auth Error: ' + tokenResponse.error;
                    if (tokenResponse.details) errorMessage += '; Details: ' + tokenResponse.details;
                    // ... (你的错误处理逻辑) ...
                    console.error("driveSync.authenticate: Token response error:", errorMessage);
                    reject(new Error(errorMessage));
                } else {
                    // **关键步骤：授权成功后，将访问令牌设置给 gapi.client**
                    // tokenResponse 对象直接就是包含 access_token 的对象
                    if (tokenResponse && tokenResponse.access_token) {
                        console.log("driveSync.authenticate: Access token received. Setting token for GAPI client.");
                        driveSync.gapi.client.setToken(tokenResponse); // 直接传递 TokenResponse 对象
                        resolve({ success: true, tokenData: tokenResponse });
                    } else {
                        const errMsg = "driveSync.authenticate: Token response successful but access_token missing.";
                        console.error(errMsg, tokenResponse);
                        reject(new Error(errMsg));
                    }
                }
            };

            // 检查当前是否有有效的令牌
            const currentGapiToken = driveSync.gapi.client.getToken();
            let needsPrompt = true;
            if (currentGapiToken && currentGapiToken.access_token) {
                // 你可以添加一个检查令牌是否即将过期的逻辑，如果接近过期，则强制刷新
                // 但 GIS 通常会在需要时自动处理刷新，或者在 requestAccessToken 时根据情况处理
                console.log("driveSync.authenticate: Found existing GAPI token. Will attempt request without explicit prompt unless necessary.");
                needsPrompt = false; // 假设现有令牌可能有效，让 requestAccessToken 决定是否需要交互
            }
            
            // 如果需要显式提示用户（例如，首次授权或令牌确定已失效）
            // const promptType = needsPrompt ? 'consent' : ''; // 或 'select_account'
            // 或者总是让GIS决定是否需要prompt，可以传空字符串或不传prompt参数
            driveSync.tokenClient.requestAccessToken({ prompt: needsPrompt ? 'consent' : '' });
            console.log("driveSync.authenticate: requestAccessToken called. Prompt type:", needsPrompt ? 'consent' : '(GIS default)');
        });
    },

    findOrCreateFile: async function() {
        try {
            await driveSync.ensureGapiClientReady(); // 确保 GAPI 客户端和 Drive API 已准备好
        } catch (e) {
            console.error("driveSync.findOrCreateFile: Failed to ensure GAPI client ready:", e);
            throw new Error(`GAPI client setup failed before findOrCreateFile: ${e.message}`);
        }
        if (!driveSync.gapi || !driveSync.gapi.client || !driveSync.gapi.client.drive) { // 再次检查
            throw new Error("driveSync.findOrCreateFile: Google Drive API client (driveSync.gapi.client.drive) not ready.");
        }
        const response = await driveSync.gapi.client.drive.files.list({
            q: `name='${driveSync.DRIVE_FILE_NAME}' and 'appDataFolder' in parents`,
            spaces: 'appDataFolder',
            fields: 'files(id, name)'
        });
        if (response.result.files && response.result.files.length > 0) {
            driveSync.driveFileId = response.result.files[0].id;
            return driveSync.driveFileId;
        } else {
            const createResponse = await driveSync.gapi.client.drive.files.create({
                resource: { name: driveSync.DRIVE_FILE_NAME, parents: ['appDataFolder'] },
                fields: 'id'
            });
            driveSync.driveFileId = createResponse.result.id;
            return driveSync.driveFileId;
        }
    },

    upload: async function(data) {
                try {
            await driveSync.ensureGapiClientReady();
        } catch (e) { /* ... */ throw new Error(`GAPI client setup failed before upload: ${e.message}`); }
        if (!driveSync.driveFileId) throw new Error("driveSync.upload: No Drive file ID.");
        if (!driveSync.gapi || !driveSync.gapi.client) {
            throw new Error("driveSync.upload: Google API client (driveSync.gapi.client) not ready.");
        }
        const boundary = '-------314159265358979323846';
        const delimiter = "\r\n--" + boundary + "\r\n";
        const close_delim = "\r\n--" + boundary + "--";
        const metadata = { 'mimeType': 'application/json' };
        const multipartRequestBody =
            delimiter + 'Content-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata) +
            delimiter + 'Content-Type: application/json\r\n\r\n' + JSON.stringify(data) + close_delim;
        await driveSync.gapi.client.request({
            'path': `/upload/drive/v3/files/${driveSync.driveFileId}`,
            'method': 'PATCH',
            'params': { 'uploadType': 'multipart' },
            'headers': { 'Content-Type': 'multipart/related; boundary="' + boundary + '"' },
            'body': multipartRequestBody
        });
        return { success: true, message: "已同步到云端" };
    },

    download: async function() {
                try {
            await driveSync.ensureGapiClientReady();
        } catch (e) { /* ... */ throw new Error(`GAPI client setup failed before download: ${e.message}`); }
        if (!driveSync.driveFileId) return null;
        if (!driveSync.gapi || !driveSync.gapi.client || !driveSync.gapi.client.drive) {
            throw new Error("driveSync.download: Google Drive API client (driveSync.gapi.client.drive) not ready.");
        }
        const response = await driveSync.gapi.client.drive.files.get({
            fileId: driveSync.driveFileId,
            alt: 'media'
        });
        if (response.body && response.body.length > 0) {
            try {
                return JSON.parse(response.body);
            } catch (e) {
                console.error("driveSync.download: Failed to parse downloaded JSON from Drive:", e, "Body:", response.body);
                throw new Error("云端数据已损坏或非有效JSON。");
            }
        }
        return null;
    }
};

// ========================================================================
// >>>>>>>>>>>>>>>>> 在这里定义 loadGoogleApis 函数 <<<<<<<<<<<<<<<<<
// ========================================================================
async function loadGoogleApis() {
    console.log("loadGoogleApis: Attempting to load Google APIs...");
    return new Promise((resolve, reject) => {
        // 等待全局 gapi 和 google.accounts.oauth2 对象可用
        // 这些对象是由 index.html 中通过 <script src="..."> 加载的 Google 脚本定义的

        let gapiReady = false;
        let gisReady = false;
        let attempts = 0;
        const maxAttempts = 50; // 大约 5 秒超时 (50 * 100ms)
        const intervalTime = 100;

        const checkLibraries = async () => {
            if (typeof gapi !== 'undefined' && gapi.load) { // 检查 gapi 是否已加载且可用
                driveSync.gapi = gapi; // 将全局 gapi 赋给 driveSync 模块
                gapiReady = true;
                console.log("loadGoogleApis: GAPI library is ready.");
            }

            if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2 && google.accounts.oauth2.initTokenClient) { // 检查 GIS 是否已加载且可用
                driveSync.gisOAuth2 = google.accounts.oauth2; // 将全局 GIS OAuth2 赋给 driveSync 模块
                gisReady = true;
                console.log("loadGoogleApis: Google Identity Services (GIS) OAuth2 is ready.");
            }

            if (gapiReady && gisReady) {
                            try {
                // driveSync.initClients() 内部会初始化 GAPI Client 和 GIS Token Client
                // GAPI Client 初始化后，我们还需要确保 Drive API 被加载
                console.log("loadGoogleApis: Both GAPI and GIS are ready. Initializing DriveSync clients and ensuring Drive API is loaded...");
                await driveSync.initClients(); // 这个函数内部有 gapi.client.init 和 initTokenClient
                driveSync._gapiInitialized = true; // 标记 gapi.client.init 已完成

                console.log("loadGoogleApis: DriveSync clients initialized. Loading Drive API...");
                await driveSync.gapi.client.load('drive', 'v3');
                driveSync._driveApiLoaded = true; // 标记 Drive API 已加载
                console.log("loadGoogleApis: Drive API v3 loaded successfully.");
                
                resolve({ gapi: driveSync.gapi, gisOAuth2: driveSync.gisOAuth2 });
            } catch (initError) {
    
                    console.error("loadGoogleApis: Error during driveSync.initClients:", initError);
                    reject(new Error(`Failed to initialize Google API clients after loading libraries: ${initError.message}`));
                }
                return;
            }

            attempts++;
            if (attempts >= maxAttempts) {
                let errorMsg = "loadGoogleApis: Timeout loading Google APIs. ";
                if (!gapiReady) errorMsg += "GAPI not available. ";
                if (!gisReady) errorMsg += "GIS not available. ";
                console.error(errorMsg);
                reject(new Error(errorMsg.trim()));
                return;
            }

            setTimeout(checkLibraries, intervalTime);
        };

        checkLibraries(); // 开始检查
    });
}

// ========================================================================
// 2. 状态变量和常量定义
// ========================================================================
let allTasks = {};
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
const faqs = [
    { question: "如何在手机上获得最佳体验？", answer: "推荐您将本应用“添加到主屏幕”。在大多数手机浏览器中，打开菜单（通常是三个点或分享按钮），选择“添加到主屏幕”或类似选项即可。这样应用会像原生App一样运行，支持离线和全屏。" },
    { question: "设置了提醒，为什么手机收不到通知？", answer: "请检查以下几点：<br>1. **App通知权限**：确保在手机的“设置”>“通知管理”中，允许了本应用（或您使用的浏览器）发送通知。<br>2. **浏览器通知权限**：在本应用内，点击顶部的铃铛图标，确保通知是开启状态，并已授予站点通知权限。<br>3. **省电模式/后台限制**：部分手机的省电模式或后台活动限制可能会阻止通知，请检查相关设置。<br>4. **网络连接**：部分提醒可能依赖网络（如通过Service Worker唤醒），请确保在提醒时间点有基本网络连接。" },
    { question: "数据如何同步到我的其他设备（如电脑）？", answer: "本应用使用Google Drive进行数据同步。在手机和电脑上都使用同一个Google账户登录并授权后，数据会自动（或通过手动点击同步按钮）在您的所有设备间保持一致。首次使用或更换设备后，请务必点击“云端同步”按钮并完成授权。" },
    { question: "如何调整每日或本月任务的顺序？", answer: "在每日清单或本月待办列表中，每个任务项的右侧操作区有“▲”（上移）和“▼”（下移）按钮。点击这些按钮即可调整任务的顺序。未来计划和记账本则保留了拖拽排序功能（在电脑上更易操作）。" },
    { question: "如何快速添加任务或备注？", answer: "在手机上，直接在对应模块的输入框输入内容并点击“+”即可添加。要添加备注或链接，请点击任务项右侧的对应图标（对话气泡是备注，回形针是链接）。" },
    { question: "数据安全吗？会丢失吗？", answer: "您的数据首先存储在您手机浏览器本地，支持离线使用。通过Google Drive同步后，数据会额外备份在您自己的Google Drive云端硬盘中，由您完全掌控，更加安全。建议定期进行云同步。" }
];

const features = [
    { title: "PWA 移动优先体验", description: "专为手机优化！支持“添加到主屏幕”，享受如原生App般流畅的离线访问和全屏体验。" },
    { title: "四大清单模块", description: "每日重复、本月核心、未来规划、简易记账，四大模块助您全面掌控任务与财务。" },
    { title: "便捷底部导航", description: "专为手机设计的底部标签栏，单手即可轻松切换不同功能区，操作更高效。" },
    { title: "桌面与移动端提醒", description: "“未来计划”支持设置精确提醒，无论是电脑桌面还是手机锁屏，都能及时收到通知，不错过重要安排。" },
    { title: "智能任务流转", description: "到期的未来计划自动转为每日任务，并以“[计划]”前缀标记，形成高效工作流。" },
    { title: "全新点击排序", description: "每日和本月清单任务支持点击“上移/下移”按钮轻松调整顺序，操作更直观便捷。" },
    { title: "Google Drive 云同步", description: "数据安全同步至您的Google Drive，实现跨设备（手机、电脑）无缝访问和可靠备份。" },
    { title: "丰富任务属性", description: "支持备注、链接、子任务、进度条、标签、优先级等，满足精细化管理。小技巧：编辑本月任务时，可用 `任务名_标签` 格式一次性修改任务和标签。" },
    { title: "个性化主题", description: "一键切换浅色/深色主题，适应不同光线环境和个人偏好。" },
    { title: "全面数据洞察", description: "“统计分析”模块通过图表清晰展示任务完成与财务支出，助您更好规划。" },
    { title: "Excel导入导出", description: "本月待办和记账本支持Excel数据导入导出，方便批量操作和数据备份。" }
];

const versionUpdateNotes = { "3.0.0": [ "【核心重构】引入Google Drive云同步功能，替换原有的Chrome同步机制作为主要数据存储：", "    - **数据更安全：** 您的所有任务和账单数据现在存储在您自己的Google Drive上的特定文件 (`efficienTodoData.json`) 中，由您完全掌控。", "    - **手动与自动同步：** 您可以随时手动点击“同步”按钮与Google Drive同步。同时，插件会在您进行修改后、打开时以及后台定期尝试自动同步，确保数据尽可能保持最新。", "    - **首次使用：** 新安装或从旧版本更新后，请点击“同步”按钮完成Google Drive授权，以启用云同步功能。", "【提醒功能改进】未来计划的提醒闹钟机制优化，提升了任务编辑后提醒的稳定性。", "【排序优化】每日和本月清单的任务排序方式改为点击上下箭头按钮，替代原有的拖拽排序和移动端长按排序。" ], "2.1.0": [ "【记账本增强】引入强大的财务管理功能：", "    - **预算管理**：现在可以为每个项目设置月度预算，并在统计中通过进度条直观地查看开销情况。", "    - **年度报告**：一键生成年度收支报告，清晰汇总全年总支出、月均消费，并按项目和月份提供详细分类，助您轻松回顾财务状况。", "    - **多货币支持**：新增货币符号切换功能，支持在全球热门货币（如¥, €, £等）之间选择，满足国际化记账需求。" ], "2.0.0": [ "【核心功能】新增“统计分析”模块，提供多维度任务和账单数据可视化报告，助您洞察效率与开销。", "【功能增强】“本月待办”模块引入任务优先级管理：", "    - 支持为任务设置高、中、低三个优先级。", "    - 可按优先级一键排序任务列表。", "    - 拖拽排序依然有效，提供灵活的任务组织方式。" ], "1.9.0": [ "【核心功能】新增快速添加任务方式：", "1. **右键菜单**：在任何网页上选中文本，右键选择“添加到高效待办清单”，即可快速创建到“本月待办”。", "2. **地址栏命令**：在浏览器地址栏输入 'todo'，按 Tab 或空格，再输入任务内容并回车，即可快速添加。" ], "1.8.0": ["【核心功能】“未来计划”模块新增桌面提醒功能，可以为任务设置精确到分钟的提醒时间。"], "1.7.0": ["优化看板页面体验，增加顶部固定导航，长页面滚动和切换不再繁琐。"], "1.6.0": ["新增搜索框，可以实时搜索所有列表中的任务和记账条目。"], "1.5.0": ["新增当月条目归档功能，将当月任务归档到过去月份。"], "1.4.0": [ "为“本月待办”和“记账本”模块增加了 Excel(xlsx) 导入导出功能。", "现在可以下载数据模板，方便地批量添加任务和账单。", "可以一键导出所有历史归档数据，便于备份和分析。" ], "1.3.0": [ "记账本模块新增历史数据归档与月度账单统计功能，方便回顾与分析。", "本月待办模块增加历史月份查阅功能，轻松回顾过往任务。", "本月待办任务完成后，自动标记完成日期。" ] };

// ========================================================================
// 3. 全局DOM元素变量
// ========================================================================
let statsBtn, statsModal, statsModalCloseBtn, faqBtn, faqModal, faqModalCloseBtn, faqListDiv, mainSearchInput, dailyTitleDate, themeToggleBtn, feedbackBtn, donateBtn, dailyTaskList, monthlyTaskList, futureTaskList, ledgerList, monthlyHeaderTitle, sortMonthlyByPriorityBtn, ledgerHeaderTitle, monthlyInputArea, ledgerInputArea, newDailyTaskInput, addDailyTaskBtn, newMonthlyTaskInput, newMonthlyTagsInput, addMonthlyTaskBtn, newFutureTaskInput, futureTaskDateTimeInput, addFutureTaskBtn, ledgerDateInput, ledgerItemInput, ledgerAmountInput, ledgerPaymentInput, ledgerDetailsInput, addLedgerBtn, monthlyTagsContainer, ledgerTagsContainer, ledgerSummaryContainer, monthlyHistoryBtn, ledgerHistoryBtn, historyModal, historyModalCloseBtn, historyModalTitle, historyPrevYearBtn, historyNextYearBtn, historyCurrentYearSpan, historyMonthsGrid, donateModal, modalCloseBtn, featuresBtn, featuresModal, featuresModalCloseBtn, featuresListUl, exportMonthlyHistoryBtn, importMonthlyBtn, downloadMonthlyTemplateBtn, importMonthlyFileInput, exportLedgerHistoryBtn, importLedgerBtn, downloadLedgerTemplateBtn, importLedgerFileInput, toggleNotificationsBtn, customPromptModal, customPromptTitleEl, customPromptMessageEl, customPromptInputContainer, customPromptConfirmBtn, customPromptCancelBtn, customPromptCloseBtn, setBudgetBtn, annualReportBtn, annualReportModal, annualReportCloseBtn, annualReportTitle, annualReportPrevYearBtn, annualReportNextYearBtn, annualReportCurrentYearSpan, annualReportSummaryDiv, annualReportDetailsDiv, currencyPickerBtn, syncDriveBtn, syncStatusSpan, bottomNav, allSections, isHistoryModalOpen;

// ========================================================================
// 4. 核心功能函数定义
// ========================================================================

async function loadTasks(callback) {
    let data;
    try {
        data = await db.get('allTasks');
    } catch (error) {
        console.error("[PWA] Error loading tasks from DB:", error);
        allTasks = {
            daily: [], monthly: [], future: [], ledger: [],
            history: {}, ledgerHistory: {}, budgets: {}, currencySymbol: '$',
            lastUpdatedLocal: Date.now(),
            lastDailyReset: new Date(0).toDateString()
        };
        await saveTasks();
        if (callback) callback();
        return;
    }

    let needsSaveAfterLoad = false;
    if (data && typeof data === 'object') {
        allTasks = data;
        const defaultStructure = { 
            daily: [], monthly: [], future: [], ledger: [],
            history: {}, ledgerHistory: {}, budgets: {}, currencySymbol: '$',
            lastUpdatedLocal: 0,
            lastDailyReset: new Date(0).toDateString()
        };
        for (const key in defaultStructure) {
            if (!allTasks.hasOwnProperty(key) || allTasks[key] === undefined) {
                allTasks[key] = defaultStructure[key];
                needsSaveAfterLoad = true;
            }
        }
        ['daily', 'monthly', 'future', 'ledger'].forEach(listKey => {
            if (!Array.isArray(allTasks[listKey])) {
                allTasks[listKey] = [];
                needsSaveAfterLoad = true;
            }
        });
        ['history', 'ledgerHistory', 'budgets'].forEach(objKey => {
            if (typeof allTasks[objKey] !== 'object' || allTasks[objKey] === null || Array.isArray(allTasks[objKey])) {
                allTasks[objKey] = {};
                needsSaveAfterLoad = true;
            }
        });
        if (typeof allTasks.currencySymbol !== 'string') {
             allTasks.currencySymbol = '$';
             needsSaveAfterLoad = true;
        }
        if (allTasks.hasOwnProperty('lastDailyReset') && typeof allTasks.lastDailyReset !== 'string') {
            allTasks.lastDailyReset = new Date(0).toDateString();
            needsSaveAfterLoad = true;
        }

    } else {
        allTasks = { 
            daily: [], monthly: [], future: [], ledger: [],
            history: {}, ledgerHistory: {}, budgets: {}, currencySymbol: '$',
            lastUpdatedLocal: Date.now(),
            lastDailyReset: new Date(0).toDateString()
        };
        needsSaveAfterLoad = true;
    }

    if (needsSaveAfterLoad) {
        await saveTasks();
    }
    if (callback) callback();
}

async function saveTasks() {
    allTasks.lastUpdatedLocal = Date.now();
    try {
        await db.set('allTasks', allTasks);
    } catch (error) {
        console.error('[PWA] Error saving tasks to DB:', error);
    }
}

// app.js
async function checkAndResetDailyTasks() {
    if (!allTasks || !allTasks.daily || !Array.isArray(allTasks.daily)) {
        console.log("[PWA] checkAndResetDailyTasks: 每日任务数据无效或不存在，跳过重置。");
        return false;
    }

    const todayStr = new Date().toDateString();
    let dailyListChanged = false; // 用于标记每日列表是否有实质性更改（重置或移除）

    if (allTasks.lastDailyReset !== todayStr) {
        console.log(`[PWA] 每日任务重置/清理检查：最后处理日期 (${allTasks.lastDailyReset || '从未'}) 与今天 (${todayStr}) 不同。`);

        const newDailyTasks = [];
        allTasks.daily.forEach(task => {
            // 检查是否是由未来计划转换来的任务 (可以根据 text 前缀或 originalFutureId)
            const isFromFuturePlan = task.text.startsWith('[计划]') || task.originalFutureId;

            if (isFromFuturePlan) {
                if (task.completed) {
                    // 如果是从未来计划转来且已完成，则第二天移除
                    console.log(`[PWA] 移除已完成的计划任务: ${task.text}`);
                    dailyListChanged = true;
                    // 不将其添加到 newDailyTasks 数组，即为移除
                } else {
                    // 如果未完成，则保留
                    newDailyTasks.push(task);
                }
            } else {
                // 对于普通的每日重复任务
                if (task.completed) {
                    task.completed = false; // 重置为未完成
                    dailyListChanged = true;
                    console.log(`[PWA] 重置每日任务: ${task.text}`);
                }
                newDailyTasks.push(task); // 保留（无论是重置了还是原本就未完成）
            }
        });

        allTasks.daily = newDailyTasks; // 更新每日任务列表
        allTasks.lastDailyReset = todayStr; // 更新最后处理日期

        if (dailyListChanged) {
            console.log("[PWA] 每日任务已处理（重置或移除）。");
        } else {
            console.log("[PWA] 每日任务无需重置或移除（没有已完成的或今日已处理）。");
        }
        return true; // 返回 true 因为 lastDailyReset 更新了，或者列表内容变了
    } else {
        console.log("[PWA] 每日任务今日已检查/处理过。");
        return false;
    }
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

function openModal(modalElement) { if (modalElement) modalElement.classList.remove('hidden'); }
function closeModal(modalElement) { if (modalElement) modalElement.classList.add('hidden'); }
function applyTheme(theme) { document.documentElement.setAttribute('data-theme', theme); currentTheme = theme; }
function toggleTheme() { const newTheme = currentTheme === 'light' ? 'dark' : 'light'; applyTheme(newTheme); localStorage.setItem('theme', newTheme); }
function loadTheme() { const savedTheme = localStorage.getItem('theme') || 'light'; applyTheme(savedTheme); }
function generateUniqueId() { return `task_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`; }

function addTask(inputElement, taskArrayRefName, onCompleteCallback, options = {}) {
    const { type, tagsInputElement, dateElement } = options;
    if (!inputElement || !type) return;
    const taskText = inputElement.value.trim();
    if (!taskText) {
        if (type === 'future' && dateElement && dateElement.value) {
            openCustomPrompt({ title: "输入不完整", message: "请输入计划内容！", inputType: 'none', confirmText: "好的", hideCancelButton: true });
        } else if (type === 'monthly' && tagsInputElement && tagsInputElement.value.trim() && !taskText) {
            openCustomPrompt({ title: "输入不完整", message: "请输入本月待办内容！", inputType: 'none', confirmText: "好的", hideCancelButton: true });
        }
        return;
    }
    let newTask = {};
    if (type === 'daily') {
        newTask = { id: generateUniqueId(), text: taskText, completed: false, note: '', links: [] };
    } else if (type === 'monthly') {
        const tagsString = tagsInputElement ? tagsInputElement.value.trim() : '';
        newTask = { id: generateUniqueId(), text: taskText, completed: false, links: [], progress: 0, progressText: '', subtasks: [], tags: tagsString ? tagsString.split(',').map(tag => tag.trim()).filter(Boolean) : [], completionDate: null, priority: 2 };
    } else if (type === 'future') {
        const taskDateTimeValue = dateElement ? dateElement.value : '';
        newTask = { id: generateUniqueId(), text: taskText, completed: false, links: [] };
        if (taskDateTimeValue) {
            const reminderDate = new Date(taskDateTimeValue);
            const reminderTimestamp = reminderDate.getTime();
            if (!isNaN(reminderTimestamp) && reminderTimestamp > Date.now()) {
                newTask.reminderTime = reminderTimestamp;
                if (notificationsEnabled && 'serviceWorker' in navigator && navigator.serviceWorker.controller) {
                    navigator.serviceWorker.controller.postMessage({ type: 'SCHEDULE_REMINDER', payload: { task: newTask } });
                }
            } else {
                if (!isNaN(reminderDate.getTime())) newTask.date = taskDateTimeValue.split('T')[0];
            }
        }
    } else { return; }
    if (!allTasks[taskArrayRefName] || !Array.isArray(allTasks[taskArrayRefName])) {
        allTasks[taskArrayRefName] = [];
    }
    allTasks[taskArrayRefName].unshift(newTask);
    inputElement.value = '';
    if (tagsInputElement) tagsInputElement.value = '';
    if (dateElement) dateElement.value = '';
    saveTasks().then(() => {
        if (onCompleteCallback && typeof onCompleteCallback === 'function') {
            onCompleteCallback();
        }
    });
}

async function loadNotificationSetting() {
    const storedSetting = localStorage.getItem('notificationsEnabled');
    notificationsEnabled = storedSetting === null ? true : storedSetting === 'true';
    await updateNotificationButtonUI();
}

async function toggleNotificationSetting() {
    notificationsEnabled = !notificationsEnabled;
    localStorage.setItem('notificationsEnabled', notificationsEnabled);
    if (notificationsEnabled) {
        try {
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                openCustomPrompt({title:"权限不足", message:'请在浏览器设置中允许本站的通知权限。', inputType:'none', hideCancelButton:true, confirmText:'好的'});
                notificationsEnabled = false;
                localStorage.setItem('notificationsEnabled', 'false');
            } else {
                await handleNotificationToggle();
            }
        } catch (error) {
            notificationsEnabled = false;
            localStorage.setItem('notificationsEnabled', 'false');
        }
    }
    await updateNotificationButtonUI();
}

function getMonthlyDataForDisplay() {
    if (!allTasks) return [];
    return selectedMonthlyDisplayMonth === 'current'
        ? (allTasks.monthly || [])
        : (allTasks.history && allTasks.history[selectedMonthlyDisplayMonth] ? allTasks.history[selectedMonthlyDisplayMonth] : []);
}

function getLedgerDataForDisplay() {
    if (!allTasks) return [];
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

function downloadMonthlyTemplate() { const headers = ["text", "completed", "completionDate", "tags (comma-separated)", "subtasks (text|completed;...)", "links (comma-separated)", "progressText"]; const exampleData = ["开发导入功能", false, "", "dev,feature", "设计UI|true;编写代码|false;测试|false", "https://github.com/SheetJS/sheetjs", "核心功能，需要尽快完成"]; const data = [headers, exampleData]; const ws = XLSX.utils.aoa_to_sheet(data); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "MonthlyTasks"); XLSX.writeFile(wb, "monthly_tasks_template.xlsx"); }
function downloadLedgerTemplate() { const headers = ["date (YYYY-MM-DD)", "item", "amount", "payment", "details"]; const exampleData = [getTodayString(), "午餐", 15.50, "微信支付", "公司楼下的快餐店"]; const data = [headers, exampleData]; const ws = XLSX.utils.aoa_to_sheet(data); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Ledger"); XLSX.writeFile(wb, "ledger_template.xlsx"); }
function exportMonthlyHistory() { const historyKeys = Object.keys(allTasks.history || {}); if (historyKeys.length === 0) { openCustomPrompt({title:"无数据", message:'没有可导出的历史归档任务。', inputType:'none', confirmText:'好的', hideCancelButton:true}); return; } const wb = XLSX.utils.book_new(); const headers = ["text", "completed", "completionDate", "tags", "subtasks", "links", "progress", "progressText"]; historyKeys.sort().reverse().forEach(key => { const tasks = allTasks.history[key]; const dataToExport = tasks.map(task => [task.text, task.completed, task.completionDate || '', (task.tags || []).join(','), (task.subtasks || []).map(st => `${st.text}|${st.completed}`).join(';'), (task.links || []).join(','), task.progress || 0, task.progressText || '']); const ws = XLSX.utils.aoa_to_sheet([headers, ...dataToExport]); XLSX.utils.book_append_sheet(wb, ws, key); }); XLSX.writeFile(wb, "monthly_tasks_history.xlsx"); openCustomPrompt({title:"导出成功", message:'历史任务已成功导出！', inputType:'none', confirmText:'好的', hideCancelButton:true}); }
function exportLedgerHistory() { const historyKeys = Object.keys(allTasks.ledgerHistory || {}); if (historyKeys.length === 0) { openCustomPrompt({title:"无数据", message:'没有可导出的历史账单。', inputType:'none', confirmText:'好的', hideCancelButton:true}); return; } const wb = XLSX.utils.book_new(); const headers = ["date", "item", "amount", "payment", "details"]; historyKeys.sort().reverse().forEach(key => { const entries = allTasks.ledgerHistory[key]; const dataToExport = entries.map(entry => [entry.date, entry.item, entry.amount, entry.payment || '', entry.details || '']); const ws = XLSX.utils.aoa_to_sheet([headers, ...dataToExport]); XLSX.utils.book_append_sheet(wb, ws, key); }); XLSX.writeFile(wb, "ledger_history.xlsx"); openCustomPrompt({title:"导出成功", message:'历史账单已成功导出！', inputType:'none', confirmText:'好的', hideCancelButton:true}); }
function handleMonthlyImport(event) { const file = event.target.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = (e) => { try { const data = new Uint8Array(e.target.result); const workbook = XLSX.read(data, { type: 'array' }); const firstSheetName = workbook.SheetNames[0]; const worksheet = workbook.Sheets[firstSheetName]; const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }); if (jsonData.length <= 1) { openCustomPrompt({title: "导入提示", message: '导入的文件是空的或只有表头。', inputType: 'none', confirmText: "好的", hideCancelButton: true}); return; } const importedTasks = []; for (let i = 1; i < jsonData.length; i++) { const row = jsonData[i]; if (!row[0]) continue; const newTask = { id: generateUniqueId(), text: row[0] || '', completed: String(row[1]).toLowerCase() === 'true', completionDate: row[2] || null, tags: row[3] ? String(row[3]).split(',').map(t => t.trim()).filter(Boolean) : [], subtasks: row[4] ? String(row[4]).split(';').map(st => { const parts = st.split('|'); return { text: parts[0] || '', completed: String(parts[1]).toLowerCase() === 'true' }; }).filter(st => st.text) : [], links: row[5] ? String(row[5]).split(',').map(l => l.trim()).filter(Boolean) : [], progressText: row[6] || '', progress: 0, priority: 2 }; updateMonthlyTaskProgress(newTask); importedTasks.push(newTask); } if (importedTasks.length > 0) { allTasks.monthly.unshift(...importedTasks); saveTasks(); renderAllLists(); openCustomPrompt({title: "导入成功", message: `成功导入 ${importedTasks.length} 条任务！`, inputType: 'none', confirmText: "好的", hideCancelButton: true}); } else { openCustomPrompt({title: "导入提示", message: '未找到有效数据进行导入。', inputType: 'none', confirmText: "好的", hideCancelButton: true}); } } catch (error) { console.error("导入失败:", error); openCustomPrompt({ title: "导入失败", message: "导入失败，请确保文件格式正确，并与模板一致。", inputType: 'none', confirmText: "好的", hideCancelButton: true}); } finally { event.target.value = ''; } }; reader.readAsArrayBuffer(file); }
function handleLedgerImport(event) { const file = event.target.files[0]; if (!file) return; const reader = new FileReader(); reader.onload = (e) => { try { const data = new Uint8Array(e.target.result); const workbook = XLSX.read(data, { type: 'array' }); const firstSheetName = workbook.SheetNames[0]; const worksheet = workbook.Sheets[firstSheetName]; const jsonData = XLSX.utils.sheet_to_json(worksheet, { header: 1 }); if (jsonData.length <= 1) { openCustomPrompt({title: "导入提示", message: '导入的文件是空的或只有表头。', inputType: 'none', confirmText: "好的", hideCancelButton: true}); return; } const importedEntries = []; for (let i = 1; i < jsonData.length; i++) { const row = jsonData[i]; if (!row[0] || !row[1] || row[2] === undefined || row[2] === null || String(row[2]).trim() === '') continue; const newEntry = { date: row[0], item: row[1], amount: parseFloat(row[2]), payment: row[3] || '', details: row[4] || '' }; if (typeof newEntry.date === 'number') { const excelEpoch = new Date(1899, 11, 30); const jsDate = new Date(excelEpoch.getTime() + newEntry.date * 24 * 60 * 60 * 1000); newEntry.date = `${jsDate.getFullYear()}-${String(jsDate.getMonth() + 1).padStart(2, '0')}-${String(jsDate.getDate()).padStart(2, '0')}`; } else if (newEntry.date && !/^\d{4}-\d{2}-\d{2}$/.test(newEntry.date)) { try { const parsedDate = new Date(newEntry.date); if (!isNaN(parsedDate)) { newEntry.date = `${parsedDate.getFullYear()}-${String(parsedDate.getMonth() + 1).padStart(2, '0')}-${String(parsedDate.getDate()).padStart(2, '0')}`; } else { continue; } } catch (dateParseError) { continue; } } if (isNaN(newEntry.amount)) { continue; } importedEntries.push(newEntry); } if (importedEntries.length > 0) { allTasks.ledger.unshift(...importedEntries); saveTasks(); renderAllLists(); openCustomPrompt({title: "导入成功", message: `成功导入 ${importedEntries.length} 条账单记录！`, inputType: 'none', confirmText: "好的", hideCancelButton: true}); } else { openCustomPrompt({title: "导入提示", message: '未找到有效数据进行导入。', inputType: 'none', confirmText: "好的", hideCancelButton: true}); } } catch (error) { console.error("导入失败:", error); openCustomPrompt({ title: "导入失败", message: "导入失败，请确保文件格式正确，并与模板一致。", inputType: 'none', confirmText: "好的", hideCancelButton: true}); } finally { event.target.value = ''; } }; reader.readAsArrayBuffer(file); }

function renderDailyTasks(tasksToRender) {
    if (!dailyTaskList) return;
    const now = new Date();
    if(dailyTitleDate) dailyTitleDate.textContent = `(${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')})`;
    dailyTaskList.innerHTML = '';
    const fragment = document.createDocumentFragment();
    tasksToRender.forEach((task, index) => { // 【修改】使用渲染列表的 index
        const originalIndexInAllTasks = allTasks.daily.findIndex(t => t.id === task.id);
        const li = document.createElement('li');
        li.className = 'li-daily';
        if (task.completed) { li.classList.add('completed'); }
        // 【移除】不再添加拖拽手柄: li.appendChild(createDragHandle());
        const taskMainWrapper = document.createElement('div');
        taskMainWrapper.className = 'task-main-wrapper';
        const taskContent = createTaskContent(task, originalIndexInAllTasks, 'daily', false);
        taskMainWrapper.appendChild(taskContent);
        if (task.links && task.links.length > 0) {
            const linksContainer = createLinkPills(task, 'daily', originalIndexInAllTasks);
            taskMainWrapper.appendChild(linksContainer);
        }
        const taskActions = createTaskActions(task, 'daily', originalIndexInAllTasks, false, tasksToRender.length, index); // 【修改】传递列表长度和当前渲染索引
        li.appendChild(taskMainWrapper);
        li.appendChild(taskActions);
        fragment.appendChild(li);
    });
    dailyTaskList.appendChild(fragment);
}

function renderMonthlyTasks(dataToRender, isHistoryView) {
    if (!monthlyTaskList) return;
    if (isHistoryView) {
        monthlyHeaderTitle.innerHTML = `本月待办 <span class="header-date">(${selectedMonthlyDisplayMonth})</span>`;
        if(monthlyHistoryBtn) monthlyHistoryBtn.innerHTML = `<img src="images/icon-back.svg" alt="Back">`;
        if(monthlyHistoryBtn) monthlyHistoryBtn.title = '返回当月视图';
    } else {
        const now = new Date();
        monthlyHeaderTitle.innerHTML = `本月待办 <span class="header-date">(${now.getFullYear()}-${String(now.getMonth()+1).padStart(2, '0')})</span>`;
        if(monthlyHistoryBtn) monthlyHistoryBtn.innerHTML = `<img src="images/icon-history.svg" alt="History">`;
        if(monthlyHistoryBtn) monthlyHistoryBtn.title = '查看历史记录';
    }
    if (monthlyInputArea) monthlyInputArea.style.display = isHistoryView ? 'none' : 'grid';
    monthlyTaskList.innerHTML = '';
    const fragment = document.createDocumentFragment();

    const tasksToDisplay = Array.isArray(dataToRender) ? dataToRender : [];
    const filteredMonthlyTasks = tasksToDisplay.filter(task => currentMonthlyTagFilter === 'all' || (task.tags && task.tags.includes(currentMonthlyTagFilter)));

    filteredMonthlyTasks.forEach((task, index) => { // 【修改】使用渲染列表的 index
        const li = document.createElement('li');
        li.className = 'li-monthly';
        if (task.completed) li.classList.add('completed');
        if (isHistoryView) li.classList.add('is-history-item');

        const originalIndexInSourceArray = isHistoryView
            ? (allTasks.history[selectedMonthlyDisplayMonth] || []).findIndex(t => t.id === task.id)
            : allTasks.monthly.findIndex(t => t.id === task.id);

        if (!isHistoryView && originalIndexInSourceArray > -1 && allTasks.monthly[originalIndexInSourceArray]) {
            updateMonthlyTaskProgress(allTasks.monthly[originalIndexInSourceArray]);
        }

        const progressBar = document.createElement('div');
        progressBar.className = 'progress-bar';
        progressBar.style.width = `${task.progress || 0}%`;
        li.appendChild(progressBar);

        // 【移除】不再为非历史视图添加拖拽手柄: if (!isHistoryView) li.appendChild(createDragHandle());

        const taskMainWrapper = document.createElement('div');
        taskMainWrapper.className = 'task-main-wrapper';
        taskMainWrapper.appendChild(createTaskContent(task, originalIndexInSourceArray, 'monthly', isHistoryView));

        if (task.subtasks && task.subtasks.length > 0) taskMainWrapper.appendChild(createSubtaskList(task, originalIndexInSourceArray, isHistoryView));
        if (!isHistoryView && originalIndexInSourceArray > -1) taskMainWrapper.appendChild(createSubtaskInput(originalIndexInSourceArray));
        if (task.links && task.links.length > 0) taskMainWrapper.appendChild(createLinkPills(task, isHistoryView ? 'history' : 'monthly', originalIndexInSourceArray));

        li.appendChild(taskMainWrapper);
        li.appendChild(createTaskActions(task, 'monthly', originalIndexInSourceArray, isHistoryView, filteredMonthlyTasks.length, index)); // 【修改】传递列表长度和当前渲染索引

        // 【移除】移动端长按排序的逻辑和按钮
        fragment.appendChild(li);
    });
    monthlyTaskList.appendChild(fragment);

    // 【移除】移动端长按排序相关的 body 点击事件监听器
}

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
        const li = document.createElement('li');
        li.className = 'li-future';
        const isOverdue = (task.reminderTime && task.reminderTime < Date.now()) || (task.date && new Date(task.date + 'T23:59:59') < Date.now());
        if (isOverdue) { li.style.opacity = '0.6'; }
        li.appendChild(createDragHandle()); // 未来计划保留拖拽
        const taskMainWrapper = document.createElement('div');
        taskMainWrapper.className = 'task-main-wrapper';
        const titleGroup = document.createElement('div');
        titleGroup.className = 'task-title-group';
        const taskText = document.createElement('span');
        taskText.className = 'task-text';
        taskText.textContent = task.text;
        titleGroup.appendChild(taskText);
        if (task.reminderTime && task.reminderTime > Date.now()) {
            const reminderSpan = document.createElement('span');
            reminderSpan.className = 'reminder-info';
            reminderSpan.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>`;
            const reminderDate = new Date(task.reminderTime);
            reminderSpan.title = `提醒于: ${reminderDate.toLocaleString()}`;
            titleGroup.appendChild(reminderSpan);
        } else if (task.date) {
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
            ? (allTasks.ledgerHistory[selectedLedgerMonth] || []).findIndex(item => item.date === entry.date && item.item === entry.item && item.amount === entry.amount && item.payment === entry.payment && item.details === entry.details)
            : allTasks.ledger.indexOf(entry);
        if (isHistoryView) li.classList.add('is-history-item');
        if (!isHistoryView) li.appendChild(createDragHandle()); // 记账本保留拖拽
        const contentWrapper = document.createElement('div');
        contentWrapper.className = 'ledger-content-wrapper';
        Object.keys(labels).forEach(key => {
            const span = document.createElement('span');
            span.setAttribute('data-label', labels[key]);
            span.textContent = (key === 'amount') ? `${currency} ${parseFloat(entry[key] || 0).toFixed(2)}` : (entry[key] || '-');
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
    const titleGroup = document.createElement('div');
    titleGroup.className = 'task-title-group';
    if (type === 'daily' || type === 'monthly') {
        const checkbox = document.createElement('span');
        checkbox.className = 'checkbox';
        if (!isHistoryView) {
            checkbox.addEventListener('click', (e) => {
                e.stopPropagation();
                let taskToUpdate;
                if (type === 'daily') {
                    if (index > -1 && allTasks.daily[index]) {
                        taskToUpdate = allTasks.daily[index];
                    } else { return; }
                } else {
                    if (index > -1 && allTasks.monthly[index]) {
                        taskToUpdate = allTasks.monthly[index];
                    } else { return; }
                }
                taskToUpdate.completed = !taskToUpdate.completed;
                if(type === 'monthly'){
                    taskToUpdate.progress = taskToUpdate.completed ? 100 : 0;
                    taskToUpdate.completionDate = taskToUpdate.completed ? getTodayString() : null;
                    if (taskToUpdate.subtasks && taskToUpdate.subtasks.length > 0) {
                        taskToUpdate.subtasks.forEach(st => st.completed = taskToUpdate.completed);
                    }
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
    if (type === 'monthly' && !isHistoryView && task) {
        const priorityIndicator = document.createElement('span');
        priorityIndicator.className = 'priority-indicator';
        const prioritySymbols = { 1: '!', 2: '!!', 3: '!!!' };
        const priorityColors = { 1: 'var(--priority-low)', 2: 'var(--priority-medium)', 3: 'var(--priority-high)'};
        const currentPriority = task.priority || 2;
        priorityIndicator.textContent = prioritySymbols[currentPriority];
        priorityIndicator.style.color = priorityColors[currentPriority];
        priorityIndicator.style.fontWeight = 'bold';
        priorityIndicator.style.marginRight = '8px';
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
    if (type === 'monthly' && task && task.tags && task.tags.length > 0) {
        titleGroup.appendChild(createTaskTags(task.tags));
    }
    const taskText = document.createElement('span');
    taskText.className = 'task-text';
    taskText.textContent = task ? task.text : '';
    titleGroup.appendChild(taskText);
    if (type === 'monthly' && task && task.completed && task.completionDate) {
        const completionMarker = document.createElement('div');
        completionMarker.className = 'completion-date-marker';
        completionMarker.innerHTML = `✓ ${task.completionDate}`;
        completionMarker.title = `完成于 ${task.completionDate}`;
        titleGroup.appendChild(completionMarker);
    }
    taskContent.appendChild(titleGroup);
    if (task) {
        const noteTextValue = (type === 'daily') ? task.note : task.progressText;
        if (noteTextValue && noteTextValue.trim() !== '') {
            const noteDisplayDiv = document.createElement('div');
            noteDisplayDiv.className = 'note-display-text';
            noteDisplayDiv.textContent = noteTextValue;
            taskContent.appendChild(noteDisplayDiv);
        }
    }
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

function createSubtaskList(mainTask, mainTaskIndex, isHistoryView) { const ul = document.createElement('ul'); ul.className = 'subtask-list'; if (!mainTask || !mainTask.subtasks) return ul; mainTask.subtasks.forEach((subtask, subtaskIndex) => { const li = document.createElement('li'); li.className = 'subtask-item'; if (subtask.completed) { li.classList.add('completed'); } const checkbox = document.createElement('span'); checkbox.className = 'checkbox'; if (isHistoryView) { checkbox.style.cursor = 'default'; } else { checkbox.addEventListener('click', (e) => { e.stopPropagation(); if (mainTaskIndex > -1 && allTasks.monthly[mainTaskIndex] && allTasks.monthly[mainTaskIndex].subtasks[subtaskIndex]) { const targetSubtask = allTasks.monthly[mainTaskIndex].subtasks[subtaskIndex]; targetSubtask.completed = !targetSubtask.completed; updateMonthlyTaskProgress(allTasks.monthly[mainTaskIndex]); saveTasks(); renderAllLists(); } }); } const textSpan = document.createElement('span'); textSpan.className = 'task-text'; textSpan.textContent = subtask.text; li.appendChild(checkbox); li.appendChild(textSpan); if (!isHistoryView) { const deleteBtn = document.createElement('button'); deleteBtn.className = 'action-btn delete-btn'; deleteBtn.innerHTML = '×'; deleteBtn.title = '删除子任务'; deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); if (mainTaskIndex > -1 && allTasks.monthly[mainTaskIndex] && allTasks.monthly[mainTaskIndex].subtasks) { allTasks.monthly[mainTaskIndex].subtasks.splice(subtaskIndex, 1); updateMonthlyTaskProgress(allTasks.monthly[mainTaskIndex]); saveTasks(); renderAllLists(); } }); li.appendChild(deleteBtn); } ul.appendChild(li); }); return ul; }
function createSubtaskInput(mainTaskIndex) { const div = document.createElement('div'); div.className = 'subtask-input-area'; const input = document.createElement('input'); input.type = 'text'; input.placeholder = '添加子任务...'; const btn = document.createElement('button'); btn.textContent = '+'; btn.title = '添加子任务'; btn.addEventListener('click', (e) => { e.stopPropagation(); const text = input.value.trim(); if (text && mainTaskIndex > -1 && allTasks.monthly[mainTaskIndex]) { if(!allTasks.monthly[mainTaskIndex].subtasks) { allTasks.monthly[mainTaskIndex].subtasks = []; } allTasks.monthly[mainTaskIndex].subtasks.push({ text: text, completed: false }); updateMonthlyTaskProgress(allTasks.monthly[mainTaskIndex]); input.value = ''; saveTasks(); renderAllLists(); } }); input.addEventListener('keypress', (e) => { if (e.key === 'Enter') btn.click(); }); div.appendChild(input); div.appendChild(btn); return div; }
function updateMonthlyTaskProgress(task) { if (task && task.subtasks && task.subtasks.length > 0) { const completedCount = task.subtasks.filter(st => st.completed).length; const totalCount = task.subtasks.length; const newProgress = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0; const wasCompleted = task.completed; task.progress = newProgress; task.completed = totalCount > 0 && completedCount === totalCount; if (task.completed && !wasCompleted) { task.completionDate = getTodayString(); } else if (!task.completed && wasCompleted) { task.completionDate = null; } } else if (task) { task.progress = task.completed ? 100 : 0; if (task.completed && !task.completionDate) { task.completionDate = getTodayString(); } else if (!task.completed) { task.completionDate = null; } } }
function renderMonthlyTags(dataToRender) { if (!monthlyTagsContainer) return; monthlyTagsContainer.innerHTML = ''; const tasks = Array.isArray(dataToRender) ? dataToRender : []; const allTags = new Set(tasks.flatMap(task => task.tags || [])); if (allTags.size === 0 && tasks.length > 0) { createTagButton('全部', 'all', currentMonthlyTagFilter, monthlyTagsContainer, (filter) => { currentMonthlyTagFilter = filter; renderAllLists(); }); return; } if (allTags.size === 0) return; createTagButton('全部', 'all', currentMonthlyTagFilter, monthlyTagsContainer, (filter) => { currentMonthlyTagFilter = filter; renderAllLists(); }); [...allTags].sort().forEach(tag => { createTagButton(tag, tag, currentMonthlyTagFilter, monthlyTagsContainer, (filter) => { currentMonthlyTagFilter = filter; renderAllLists(); }); }); }
function renderLedgerTags(dataToRender) { if (!ledgerTagsContainer) return; ledgerTagsContainer.innerHTML = ''; const entries = Array.isArray(dataToRender) ? dataToRender : []; const items = [...new Set(entries.map(entry => entry.item))].filter(Boolean); if (items.length === 0 && entries.length > 0) { createTagButton('全部', 'all', currentLedgerFilter, ledgerTagsContainer, (filter) => { currentLedgerFilter = filter; renderAllLists(); }); return; } if (items.length === 0) return; createTagButton('全部', 'all', currentLedgerFilter, ledgerTagsContainer, (filter) => { currentLedgerFilter = filter; renderAllLists(); }); items.sort().forEach(item => { createTagButton(item, item, currentLedgerFilter, ledgerTagsContainer, (filter) => { currentLedgerFilter = filter; renderAllLists(); }); }); }
function createTagButton(text, filterValue, currentFilter, container, onClick) { const btn = document.createElement('button'); btn.className = 'tag-button'; btn.textContent = text; if (currentFilter === filterValue) { btn.classList.add('active'); } btn.addEventListener('click', () => onClick(filterValue)); container.appendChild(btn); }
function createTaskTags(tags) { const container = document.createElement('div'); container.className = 'tags-on-task'; tags.forEach(tag => { const span = document.createElement('span'); span.className = 'task-tag-pill'; span.textContent = tag; container.appendChild(span); }); return container; }
function renderFeaturesList() { if (!featuresListUl) return; featuresListUl.innerHTML = ''; features.forEach(feature => { const li = document.createElement('li'); li.innerHTML = `<strong>${feature.title}:</strong> ${feature.description}`; featuresListUl.appendChild(li); }); const sortedVersions = Object.keys(versionUpdateNotes).sort((a, b) => { const partsA = a.split('.').map(Number); const partsB = b.split('.').map(Number); for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) { const valA = partsA[i] || 0; const valB = partsB[i] || 0; if (valA !== valB) return valB - valA; } return 0; }); sortedVersions.forEach(versionKey => { const notes = versionUpdateNotes[versionKey]; if (notes && notes.length > 0) { const updateTitleLi = document.createElement('li'); updateTitleLi.className = 'features-update-title'; updateTitleLi.innerHTML = `<strong>版本 ${versionKey} 更新亮点:</strong>`; featuresListUl.appendChild(updateTitleLi); const updatesSubList = document.createElement('ul'); updatesSubList.className = 'features-update-list'; notes.forEach(note => { const noteLi = document.createElement('li'); let formattedNote = note.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>'); formattedNote = formattedNote.replace(/^( {4,}|\t+)(.*)/gm, (match, p1, p2) => { return `<span style="display: block; margin-left: ${p1.length * 0.5}em;">- ${p2}</span>`; }); noteLi.innerHTML = formattedNote; updatesSubList.appendChild(noteLi); }); featuresListUl.appendChild(updatesSubList); } }); let manifestVersion = "未知"; fetch('manifest.json') .then(response => response.json()) .then(manifest => { manifestVersion = manifest.version || "3.0.0"; const versionLi = document.createElement('li'); versionLi.classList.add('features-version-info'); versionLi.innerHTML = `<strong>当前版本:</strong> ${manifestVersion}`; featuresListUl.appendChild(versionLi); }) .catch(e => { manifestVersion = "3.0.0"; const versionLi = document.createElement('li'); versionLi.classList.add('features-version-info'); versionLi.innerHTML = `<strong>当前版本:</strong> ${manifestVersion}`; featuresListUl.appendChild(versionLi); }); }
function hideFeaturesModal() { if (featuresModal) { featuresModal.classList.add('hidden'); } }
function showFeaturesModal() { if(featuresModal) { renderFeaturesList(); featuresModal.classList.remove('hidden'); } }
function showFaqModal() { if(!faqListDiv) return; faqListDiv.innerHTML = ''; faqs.forEach(faq => { const item = document.createElement('div'); item.className = 'faq-item'; item.innerHTML = `<div class="faq-question">${faq.question}</div><div class="faq-answer">${faq.answer}</div>`; faqListDiv.appendChild(item); }); if(faqModal) faqModal.classList.remove('hidden'); }
function hideFaqModal() { if (faqModal) faqModal.classList.add('hidden'); }

function initSortable() {
    const onDragEnd = (dataArray, evt, listType) => {
        if (!Array.isArray(dataArray) || evt.oldIndex === undefined || evt.newIndex === undefined || evt.oldIndex < 0 || evt.newIndex < 0) {
            return;
        }
        const [movedItem] = dataArray.splice(evt.oldIndex, 1);
        dataArray.splice(evt.newIndex, 0, movedItem);
        saveTasks();
        if (listType === 'ledger') {
            renderLedger(allTasks.ledger, selectedLedgerMonth !== 'current');
        }
    };
    const sortableOptions = { animation: 150, ghostClass: 'sortable-ghost', handle: '.drag-handle' };

    // 【移除】每日和本月清单的拖拽初始化
    // if(dailyTaskList) new Sortable(dailyTaskList, { ...sortableOptions, onEnd: (evt) => onDragEnd(allTasks.daily, evt, 'daily') });
    // if(monthlyTaskList) new Sortable(monthlyTaskList, { ...sortableOptions, onEnd: (evt) => { if (selectedMonthlyDisplayMonth === 'current') { onDragEnd(allTasks.monthly, evt, 'monthly'); } } });
    
    // 保留未来计划和记账本的拖拽
    if(futureTaskList) new Sortable(futureTaskList, { ...sortableOptions, onEnd: (evt) => onDragEnd(allTasks.future, evt, 'future') });
    if(ledgerList) new Sortable(ledgerList, { ...sortableOptions, filter: '.ledger-header', onEnd: (evt) => { if (selectedLedgerMonth === 'current') { onDragEnd(allTasks.ledger, evt, 'ledger'); } } });
}

function createLinkPills(task, type, taskIndex) { const container = document.createElement('div'); container.className = 'links-container'; if (task && task.links && task.links.length > 0) { task.links.forEach((link, linkIndex) => { if (!link) return; const pill = document.createElement('a'); pill.className = 'link-pill'; pill.href = link; pill.target = '_blank'; pill.title = `打开链接: ${link}`; const linkTextSpan = document.createElement('span'); try { const url = new URL(link); linkTextSpan.textContent = url.hostname.replace(/^www\./, ''); } catch (e) { linkTextSpan.textContent = link.length > 20 ? link.substring(0, 17) + '...' : link; } pill.appendChild(linkTextSpan); if (type !== 'history') { const deleteLinkBtn = document.createElement('button'); deleteLinkBtn.className = 'delete-link-btn'; deleteLinkBtn.innerHTML = '×'; deleteLinkBtn.title = '删除此链接'; deleteLinkBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); let targetTask; if(type === 'daily' && taskIndex > -1 && allTasks.daily[taskIndex]) targetTask = allTasks.daily[taskIndex]; else if(type === 'monthly' && taskIndex > -1 && allTasks.monthly[taskIndex]) targetTask = allTasks.monthly[taskIndex]; else if(type === 'future' && taskIndex > -1 && allTasks.future[taskIndex]) targetTask = allTasks.future[taskIndex]; if (targetTask && targetTask.links) { targetTask.links.splice(linkIndex, 1); saveTasks(); renderAllLists(); } }); pill.appendChild(deleteLinkBtn); } container.appendChild(pill); }); } return container; }
function archiveSingleItem(type, index) { const sourceArrayName = type; const historyArrayName = type === 'monthly' ? 'history' : 'ledgerHistory'; if (!allTasks || !allTasks[sourceArrayName]) { return; } const sourceArray = allTasks[sourceArrayName]; if (index < 0 || index >= sourceArray.length) { return; } const itemToArchive = JSON.parse(JSON.stringify(sourceArray[index])); openCustomPrompt({ title: `选择归档日期`, message: `请为要归档的${type === 'monthly' ? '任务' : '记录'}选择一个完成/记录日期。\n该日期不能是未来。`, inputType: 'date', initialValue: getTodayString(), confirmText: '确认归档', onConfirm: (selectedDate) => { const todayString = getTodayString(); if (!selectedDate || selectedDate > todayString) { openCustomPrompt({ title: "日期无效", message: `选择的日期 (${selectedDate}) 不能是未来。\n\n请选择今天或之前的日期。`, inputType: 'none', confirmText: '好的，重试', hideCancelButton: true, onConfirm: () => archiveSingleItem(type, index) }); return false; } const targetMonth = selectedDate.substring(0, 7); if (type === 'monthly') { itemToArchive.completionDate = selectedDate; if (!itemToArchive.completed) { itemToArchive.completed = true; itemToArchive.progress = 100; if (itemToArchive.subtasks && itemToArchive.subtasks.length > 0) { itemToArchive.subtasks.forEach(st => st.completed = true); } } } else { itemToArchive.date = selectedDate; } if (!allTasks[historyArrayName]) { allTasks[historyArrayName] = {}; } if (!allTasks[historyArrayName][targetMonth]) { allTasks[historyArrayName][targetMonth] = []; } allTasks[historyArrayName][targetMonth].unshift(itemToArchive); sourceArray.splice(index, 1); saveTasks(); renderAllLists(); openCustomPrompt({ title: "归档成功", message: `已成功将1条数据归档到 ${targetMonth}！`, inputType: 'none', confirmText: "好的", hideCancelButton: true }); } }); }

// 【修改】createTaskActions 函数，增加 currentListLength 和 currentRenderIndex 参数
function createTaskActions(task, type, originalItemIndex, isHistoryView, currentListLength, currentRenderIndex) {
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
            if (!allTasks[historyArrayName] || !allTasks[historyArrayName][selectedMonth]) return;
            const historyArray = allTasks[historyArrayName][selectedMonth];
            openCustomPrompt({
                title: '确认删除', message: `您确定要永久删除这条历史记录吗？\n“${task.text || task.item}”`, inputType: 'none', confirmText: '确认删除', cancelText: '取消',
                onConfirm: () => {
                    let realIndex = -1;
                    if (type === 'monthly' && task.id) {
                        realIndex = historyArray.findIndex(item => item.id === task.id);
                    } else if (type === 'ledger') {
                        realIndex = originalItemIndex; // 假设 originalItemIndex 对于历史账本是准确的
                    }
                    if (realIndex > -1 && realIndex < historyArray.length) {
                        historyArray.splice(realIndex, 1);
                        if (historyArray.length === 0) { delete allTasks[historyArrayName][selectedMonth]; }
                        saveTasks();
                        renderAllLists();
                    }
                }
            });
        });
        actionsContainer.appendChild(deleteBtn);
        return actionsContainer;
    }

    // --- 【新增】上移和下移按钮 (仅用于每日和本月清单的非历史视图) ---
    if (!isHistoryView && (type === 'daily' || type === 'monthly')) {
        const moveUpBtn = document.createElement('button');
        moveUpBtn.className = 'action-btn move-up-btn';
        moveUpBtn.innerHTML = '▲';
        moveUpBtn.title = '上移';
        if (currentRenderIndex === 0) { // 使用渲染列表中的索引判断是否为第一个
            moveUpBtn.disabled = true;
        }
        moveUpBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            moveItemInList(type, originalItemIndex, -1); // 使用在 allTasks 中的原始索引
        });
        actionsContainer.appendChild(moveUpBtn);

        const moveDownBtn = document.createElement('button');
        moveDownBtn.className = 'action-btn move-down-btn';
        moveDownBtn.innerHTML = '▼';
        moveDownBtn.title = '下移';
        if (currentRenderIndex === currentListLength - 1) { // 使用渲染列表中的索引和长度判断是否为最后一个
            moveDownBtn.disabled = true;
        }
        moveDownBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            moveItemInList(type, originalItemIndex, 1); // 使用在 allTasks 中的原始索引
        });
        actionsContainer.appendChild(moveDownBtn);
    }


    if (type === 'daily' || type === 'monthly') {
        const noteBtn = document.createElement('button');
        noteBtn.className = 'action-btn note-btn';
        noteBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`;
        const noteText = (type === 'daily') ? (task.note || '') : (task.progressText || '');
        if (noteText) { noteBtn.title = `编辑备注: ${noteText.substring(0,20)}${noteText.length > 20 ? '...' : ''}`; noteBtn.classList.add('has-note'); } else { noteBtn.title = '添加备注'; }
        noteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (originalItemIndex < 0) return;
            const currentTask = (type === 'daily' ? allTasks.daily : allTasks.monthly)[originalItemIndex];
            if (!currentTask) return;
            openCustomPrompt({
                title: noteText ? '编辑备注' : '添加备注', inputType: 'textarea', initialValue: noteText, placeholder: '请输入备注内容...', confirmText: '保存',
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
            if (originalItemIndex < 0) return;
            const li = e.target.closest('li');
            if (!li) return;
            const taskTextElement = li.querySelector('.task-text');
            if (!taskTextElement) return;
            const currentTaskArray = allTasks[type];
            if (!currentTaskArray || !currentTaskArray[originalItemIndex]) { renderAllLists(); return; }
            const currentTask = currentTaskArray[originalItemIndex];
            let initialInputValue = currentTask.text;
            if (type === 'monthly' && currentTask.tags && currentTask.tags.length > 0) { initialInputValue += `_${currentTask.tags.join(',')}`; }
            const input = document.createElement('input');
            input.type = 'text'; input.className = 'task-edit-input'; input.value = initialInputValue;
            if (type === 'monthly') input.placeholder = '任务名_标签1,标签2...';
            const titleGroup = taskTextElement.parentElement;
            if (!titleGroup) return;
            titleGroup.replaceChild(input, taskTextElement);
            input.focus(); input.select();
            const saveEdit = () => {
                const newFullString = input.value.trim();
                if (!newFullString) { renderAllLists(); return; }
                let finalTaskText = newFullString;
                let finalTags = type === 'monthly' ? [...(currentTask.tags || [])] : [];
                if (type === 'monthly') {
                    const separatorIndex = newFullString.lastIndexOf('_');
                    if (separatorIndex > 0 && separatorIndex < newFullString.length -1) {
                        finalTaskText = newFullString.substring(0, separatorIndex).trim();
                        const tagsPart = newFullString.substring(separatorIndex + 1);
                        finalTags = tagsPart.trim() ? tagsPart.split(',').map(tag => tag.trim()).filter(Boolean) : [];
                    } else { finalTaskText = newFullString; }
                }
                if (!finalTaskText && currentTask.text) finalTaskText = currentTask.text;
                const textChanged = currentTask.text !== finalTaskText;
                const tagsChanged = type === 'monthly' ? (currentTask.tags || []).join(',') !== finalTags.join(',') : false;
                if (textChanged || tagsChanged) {
                    currentTask.text = finalTaskText;
                    if (type === 'monthly') currentTask.tags = finalTags;
                    if (type === 'future' && currentTask.id && currentTask.reminderTime && textChanged && 'serviceWorker' in navigator && navigator.serviceWorker.controller) {
                        navigator.serviceWorker.controller.postMessage({ type: 'UPDATE_REMINDER', payload: { task: currentTask } });
                    }
                    saveTasks();
                }
                renderAllLists();
            };
            input.addEventListener('blur', saveEdit);
            input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); else if (e.key === 'Escape') { if (titleGroup && input.parentNode === titleGroup) { titleGroup.replaceChild(taskTextElement, input); } } });
        });
        actionsContainer.appendChild(editBtn);
    }

    if (type === 'daily' || type === 'monthly' || type === 'future') {
        const linkBtn = document.createElement('button');
        linkBtn.className = 'action-btn link-btn';
        const hasLinks = task.links && task.links.length > 0;
        linkBtn.innerHTML = `<img src="${hasLinks ? 'images/icon-link.svg' : 'images/icon-add-link.svg'}" alt="Links">`;
        linkBtn.title = hasLinks ? `查看/添加链接 (${task.links.length}/5)` : "添加链接";
        linkBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (originalItemIndex < 0) return;
            const currentTaskArray = allTasks[type];
            if (!currentTaskArray || !currentTaskArray[originalItemIndex]) { renderAllLists(); return; }
            const currentTaskObject = currentTaskArray[originalItemIndex];
            if (!currentTaskObject.links) currentTaskObject.links = [];
            if (currentTaskObject.links.length >= 5) { openCustomPrompt({ title: "链接已达上限", message: "每个任务最多只能添加 5 条链接。", inputType: 'none', confirmText: "好的", hideCancelButton: true }); return; }
            openCustomPrompt({
                title: "添加网址链接", inputType: 'url', initialValue: 'https://', placeholder: '请输入或粘贴网址', confirmText: '添加',
                onConfirm: (newLinkValue) => {
                    const newLink = newLinkValue.trim();
                    if (newLink && newLink !== 'https://') {
                        try { new URL(newLink); currentTaskObject.links.push(newLink); saveTasks(); renderAllLists(); }
                        catch (err) { openCustomPrompt({ title: "链接无效", message: `您输入的链接 "${newLink}" 格式不正确。请重新输入。`, inputType: 'none', confirmText: "好的", hideCancelButton: true }); return false; }
                    }
                }
            });
        });
        actionsContainer.appendChild(linkBtn);
    }

    if (type === 'monthly' || type === 'ledger') {
        const archiveBtn = document.createElement('button');
        archiveBtn.className = 'action-btn archive-btn';
        archiveBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v13H3V8"></path><rect x="1" y="3" width="22" height="5"></rect><line x1="10" y1="12" x2="14" y2="12"></line></svg>`;
        archiveBtn.title = (type === 'monthly') ? '归档此任务' : '归档此记录';
        archiveBtn.addEventListener('click', (e) => { e.stopPropagation(); if (originalItemIndex < 0) return; archiveSingleItem(type, originalItemIndex); });
        actionsContainer.appendChild(archiveBtn);
    }

    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'action-btn delete-btn';
    deleteBtn.innerHTML = '×';
    deleteBtn.title = (type === 'ledger') ? '删除此记录' : '删除此任务';
    deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (originalItemIndex < 0) return;
        if (type === 'future' && task.id && task.reminderTime && 'serviceWorker' in navigator && navigator.serviceWorker.controller) {
            navigator.serviceWorker.controller.postMessage({ type: 'CANCEL_REMINDER', payload: { taskId: task.id } });
        }
        const currentTaskArray = allTasks[type];
        if (currentTaskArray && currentTaskArray[originalItemIndex]) {
            currentTaskArray.splice(originalItemIndex, 1);
            saveTasks();
            renderAllLists();
        } else {
            renderAllLists();
        }
    });
    actionsContainer.appendChild(deleteBtn);
    return actionsContainer;
}

// 【新增】处理项目在列表内移动的函数
function moveItemInList(listName, itemOriginalIndexInAllTasks, direction) {
    if (!allTasks[listName] || !Array.isArray(allTasks[listName])) {
        console.error(`moveItemInList: List ${listName} not found or not an array.`);
        return;
    }

    const list = allTasks[listName];
    // 确保 itemOriginalIndexInAllTasks 是有效的
    if (itemOriginalIndexInAllTasks < 0 || itemOriginalIndexInAllTasks >= list.length) {
        console.error(`moveItemInList: Invalid originalItemIndexInAllTasks. List: ${listName}, Index: ${itemOriginalIndexInAllTasks}`);
        // 尝试通过 ID 查找，如果原始索引不可靠 (例如，当列表被搜索/过滤时)
        // 但由于我们现在在渲染时传递了原始索引，这里应该可以信任它。
        // 如果仍然出问题，需要重新评估索引的传递方式。
        renderAllLists(); // 刷新列表以避免状态不一致
        return;
    }

    const newIndex = itemOriginalIndexInAllTasks + direction;

    if (newIndex < 0 || newIndex >= list.length) {
        // 已经是顶部或底部，理论上按钮会被禁用，但以防万一
        console.warn(`moveItemInList: Cannot move item further. List: ${listName}, Index: ${itemOriginalIndexInAllTasks}, Direction: ${direction}`);
        return;
    }

    // 交换元素
    const itemToMove = list.splice(itemOriginalIndexInAllTasks, 1)[0];
    list.splice(newIndex, 0, itemToMove);

    saveTasks();
    // 重新渲染整个应用状态，或者只渲染受影响的列表
    // 为简单起见，且考虑到搜索/过滤状态，全列表渲染更安全
    renderAllLists();
}


function renderLedgerSummary(dataToRender) { if (!ledgerSummaryContainer) return; const summaryTitleText = ledgerSummaryContainer.querySelector('.summary-title'); const now = new Date(); const currentMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`; const currency = allTasks.currencySymbol || '$'; if (summaryTitleText) { if (selectedLedgerMonth === 'current') { summaryTitleText.textContent = `${currentMonthKey} 统计`; } else { summaryTitleText.textContent = `${selectedLedgerMonth} 统计`; } } const entriesToSummarize = Array.isArray(dataToRender) ? dataToRender : []; const totalExpense = entriesToSummarize.reduce((sum, entry) => sum + Number(entry.amount || 0), 0); const ledgerSummaryTotal = ledgerSummaryContainer.querySelector('#ledger-summary-total'); const ledgerSummaryBreakdown = ledgerSummaryContainer.querySelector('#ledger-summary-breakdown'); if (!ledgerSummaryTotal || !ledgerSummaryBreakdown) return; const categories = {}; entriesToSummarize.forEach(entry => { const item = entry.item || '未分类'; if (!categories[item]) categories[item] = 0; categories[item] += Number(entry.amount || 0); }); const sortedCategories = Object.entries(categories) .map(([name, amount]) => ({ name, amount })) .sort((a, b) => b.amount - a.amount); ledgerSummaryBreakdown.innerHTML = ''; if (totalExpense === 0 && sortedCategories.length === 0) { ledgerSummaryTotal.textContent = '暂无支出记录'; ledgerSummaryTotal.classList.add('no-expense'); ledgerSummaryContainer.style.display = 'none'; return; } ledgerSummaryContainer.style.display = 'block'; ledgerSummaryTotal.textContent = `${currency} ${totalExpense.toFixed(2)}`; ledgerSummaryTotal.classList.remove('no-expense'); const monthlyBudgets = (allTasks.budgets && allTasks.budgets[selectedLedgerMonth === 'current' ? currentMonthKey : selectedLedgerMonth]) ? allTasks.budgets[selectedLedgerMonth === 'current' ? currentMonthKey : selectedLedgerMonth] : {}; sortedCategories.forEach(category => { const itemDiv = document.createElement('div'); itemDiv.className = 'summary-item'; const labelSpan = document.createElement('span'); labelSpan.className = 'summary-item-label'; labelSpan.textContent = category.name; labelSpan.title = category.name; const valueSpan = document.createElement('span'); valueSpan.className = 'summary-item-value'; const percentageOfTotal = totalExpense > 0 ? (category.amount / totalExpense) * 100 : 0; valueSpan.innerHTML = `<span class="amount">${currency}${category.amount.toFixed(2)}</span> (${percentageOfTotal.toFixed(1)}%)`; const barContainer = document.createElement('div'); barContainer.className = 'summary-item-bar-container'; const bar = document.createElement('div'); bar.className = 'summary-item-bar'; requestAnimationFrame(() => { bar.style.width = `${percentageOfTotal}%`; }); barContainer.appendChild(bar); itemDiv.appendChild(labelSpan); itemDiv.appendChild(valueSpan); itemDiv.appendChild(barContainer); const budgetForCategory = monthlyBudgets[category.name]; if (budgetForCategory > 0 && (selectedLedgerMonth === 'current' || allTasks.budgets[selectedLedgerMonth])) { const budgetProgressContainer = document.createElement('div'); budgetProgressContainer.className = 'budget-progress-container'; const budgetProgressBar = document.createElement('div'); budgetProgressBar.className = 'budget-progress-bar'; const budgetPercentage = Math.min((category.amount / budgetForCategory) * 100, 100); requestAnimationFrame(() => { budgetProgressBar.style.width = `${budgetPercentage}%`; }); if (category.amount > budgetForCategory) { itemDiv.classList.add('over-budget'); budgetProgressBar.classList.add('over-budget-bar'); } const budgetProgressText = document.createElement('span'); budgetProgressText.className = 'budget-progress-text'; budgetProgressText.textContent = `预算: ${currency}${category.amount.toFixed(2)} / ${currency}${budgetForCategory.toFixed(2)}`; budgetProgressContainer.appendChild(budgetProgressBar); itemDiv.appendChild(budgetProgressContainer); itemDiv.appendChild(budgetProgressText); } ledgerSummaryBreakdown.appendChild(itemDiv); }); }
function getTodayString() { const today = new Date(); const year = today.getFullYear(); const month = String(today.getMonth() + 1).padStart(2, '0'); const day = String(today.getDate()).padStart(2, '0'); return `${year}-${month}-${day}`; }
function createDragHandle() { const handle = document.createElement('div'); handle.className = 'drag-handle'; handle.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M2 11h12v2H2zm0-5h12v2H2zm0-5h12v2H2z"/></svg>`; handle.title = '拖拽排序'; return handle; }
function openHistoryModal(type) { historyModalFor = type; historyDisplayYear = new Date().getFullYear(); updateHistoryModalTitle(); renderHistoryCalendar(); if (historyModal) historyModal.classList.remove('hidden'); isHistoryModalOpen = true; }
function closeHistoryModal() { if (historyModal) historyModal.classList.add('hidden'); isHistoryModalOpen = false; historyModalFor = null; }
function updateHistoryModalTitle() { if (!historyModalTitle) return; if (historyModalFor === 'monthly') { historyModalTitle.textContent = '选择“本月待办”历史月份'; } else if (historyModalFor === 'ledger') { historyModalTitle.textContent = '选择“记账本”历史月份'; } }
function renderHistoryCalendar() { if (!historyCurrentYearSpan || !historyMonthsGrid) return; historyCurrentYearSpan.textContent = historyDisplayYear; historyMonthsGrid.innerHTML = ''; const historySource = historyModalFor === 'monthly' ? allTasks.history : allTasks.ledgerHistory; for (let i = 1; i <= 12; i++) { const monthBtn = document.createElement('button'); monthBtn.className = 'month-button'; monthBtn.textContent = `${i}月`; const monthKey = `${historyDisplayYear}-${String(i).padStart(2, '0')}`; if (historySource && historySource[monthKey] && historySource[monthKey].length > 0) { monthBtn.classList.add('has-history'); monthBtn.dataset.monthKey = monthKey; monthBtn.addEventListener('click', () => selectHistoryMonth(monthKey)); } else { monthBtn.disabled = true; } historyMonthsGrid.appendChild(monthBtn); } }
function changeHistoryYear(offset) { historyDisplayYear += offset; renderHistoryCalendar(); }
function selectHistoryMonth(monthKey) { if (historyModalFor === 'monthly') { selectedMonthlyDisplayMonth = monthKey; currentMonthlyTagFilter = 'all'; } else if (historyModalFor === 'ledger') { selectedLedgerMonth = monthKey; currentLedgerFilter = 'all'; } closeHistoryModal(); renderAllLists(); }
function resetToCurrent(type) { if (type === 'monthly') { selectedMonthlyDisplayMonth = 'current'; currentMonthlyTagFilter = 'all'; } else if (type === 'ledger') { selectedLedgerMonth = 'current'; currentLedgerFilter = 'all'; } renderAllLists(); }
function openBudgetModal() { const now = new Date(); const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`; const currency = allTasks.currencySymbol || '$'; const currentBudgets = (allTasks.budgets && allTasks.budgets[monthKey]) ? allTasks.budgets[monthKey] : {}; const categories = new Set(); (allTasks.ledger || []).forEach(entry => { if (entry.item) categories.add(entry.item); }); Object.values(allTasks.ledgerHistory || {}).flat().forEach(entry => { if (entry.item) categories.add(entry.item); }); Object.keys(currentBudgets).forEach(cat => categories.add(cat)); const sortedCategories = [...categories].sort((a, b) => a.localeCompare(b)); if (sortedCategories.length === 0) { openCustomPrompt({ title: '无项目', message: '您的账本中没有任何消费项目或已设预算的项目。请先添加一些记账条目或手动添加预算项目，才能为其设置预算。', inputType: 'none', confirmText: '好的', hideCancelButton: true }); return; } let formHtml = `<div class="budget-input-form" data-month="${monthKey}">`; sortedCategories.forEach(cat => { formHtml += ` <div class="budget-input-row"> <label for="budget-${cat.replace(/\s+/g, '-')}" class="budget-input-label" title="${cat}">${cat}:</label> <div class="budget-input-wrapper" data-currency="${currency}"> <input type="number" id="budget-${cat.replace(/\s+/g, '-')}" class="budget-input-field" placeholder="输入预算金额" value="${currentBudgets[cat] || ''}" step="10" min="0"> </div> </div>`; }); formHtml += '</div>'; openCustomPrompt({ title: `设置 ${monthKey} 预算`, htmlContent: formHtml, confirmText: '保存预算', onConfirm: () => { const newBudgets = {}; sortedCategories.forEach(cat => { const input = document.getElementById(`budget-${cat.replace(/\s+/g, '-')}`); if (input) { const value = parseFloat(input.value); if (!isNaN(value) && value > 0) { newBudgets[cat] = value; } } }); if (!allTasks.budgets) allTasks.budgets = {}; allTasks.budgets[monthKey] = newBudgets; saveTasks(); renderLedgerSummary(getLedgerDataForDisplay()); } }); }
function openAnnualReportModal() { annualReportYear = new Date().getFullYear(); renderAnnualReport(); if(annualReportModal) annualReportModal.classList.remove('hidden'); document.addEventListener('keydown', handleAnnualReportKeyDown); }
function closeAnnualReportModal() { if(annualReportModal) annualReportModal.classList.add('hidden'); document.removeEventListener('keydown', handleAnnualReportKeyDown); }
function changeAnnualReportYear(offset) { annualReportYear += offset; renderAnnualReport(); }
function handleAnnualReportKeyDown(e) { if (e.key === 'Escape') { closeAnnualReportModal(); } }
function renderAnnualReport() { if(!annualReportCurrentYearSpan || !annualReportSummaryDiv || !annualReportDetailsDiv) return; annualReportCurrentYearSpan.textContent = annualReportYear; const currency = allTasks.currencySymbol || '$'; let annualData = []; const yearPrefix = `${annualReportYear}-`; for (const monthKey in (allTasks.ledgerHistory || {})) { if (monthKey.startsWith(yearPrefix)) { annualData.push(...(allTasks.ledgerHistory[monthKey] || [])); } } const currentYearDate = new Date().getFullYear(); if (annualReportYear === currentYearDate) { const currentYearData = (allTasks.ledger || []).filter(entry => entry.date && entry.date.startsWith(yearPrefix)); annualData.push(...currentYearData); } if (annualData.length === 0) { annualReportSummaryDiv.innerHTML = `<div class="summary-total no-expense">${annualReportYear}年无支出记录</div>`; annualReportDetailsDiv.innerHTML = ''; return; } const totalExpense = annualData.reduce((sum, entry) => sum + (Number(entry.amount) || 0), 0); const monthlyExpenses = {}; const categoryExpenses = {}; annualData.forEach(entry => { if (!entry.date || !entry.amount) return; const month = entry.date.substring(5, 7); const category = entry.item || '未分类'; monthlyExpenses[month] = (monthlyExpenses[month] || 0) + Number(entry.amount); categoryExpenses[category] = (categoryExpenses[category] || 0) + Number(entry.amount); }); const monthsWithExpenses = Object.keys(monthlyExpenses).length; const averageMonthlyExpense = monthsWithExpenses > 0 ? totalExpense / monthsWithExpenses : 0; annualReportSummaryDiv.innerHTML = ` <h3 class="summary-title">${annualReportYear}年支出摘要</h3> <div class="summary-total">${currency} ${totalExpense.toFixed(2)}</div> <div class="annual-report-breakdown"> <span>总月份数: <strong>${monthsWithExpenses}</strong></span> <span>月均支出: <strong>${currency} ${averageMonthlyExpense.toFixed(2)}</strong></span> </div>`; let detailsHtml = ''; const sortedCategories = Object.entries(categoryExpenses).sort((a, b) => b[1] - a[1]); detailsHtml += '<h4 class="annual-report-section-title">按项目分类</h4><ul>'; sortedCategories.forEach(([name, amount]) => { detailsHtml += `<li><div class="faq-question">${name}</div><div class="faq-answer">${currency} ${amount.toFixed(2)}</div></li>`; }); detailsHtml += '</ul>'; const sortedMonths = Object.entries(monthlyExpenses).sort((a, b) => a[0].localeCompare(b[0])); detailsHtml += '<h4 class="annual-report-section-title">按月份分类</h4><ul>'; sortedMonths.forEach(([month, amount]) => { detailsHtml += `<li><div class="faq-question">${annualReportYear}-${month}</div><div class="faq-answer">${currency} ${amount.toFixed(2)}</div></li>`; }); detailsHtml += '</ul>'; annualReportDetailsDiv.innerHTML = detailsHtml; }
function openCurrencyPicker() { const currencies = ['$', '¥', '€', '£', '₽', '₩', '₹', '฿', 'CAD', 'AUD', 'CHF', 'NZD', 'SGD']; const currentCurrency = allTasks.currencySymbol || '$'; let optionsHtml = '<div class="currency-options-grid">'; currencies.forEach(c => { const isActive = c === currentCurrency ? 'active' : ''; optionsHtml += `<button class="custom-prompt-btn currency-option-btn ${isActive}" data-currency="${c}">${c}</button>`; }); optionsHtml += '</div>'; openCustomPrompt({ title: '选择货币符号', htmlContent: optionsHtml, hideConfirmButton: true, hideCancelButton: true, onRender: () => { document.querySelectorAll('.currency-option-btn').forEach(btn => { btn.addEventListener('click', () => { allTasks.currencySymbol = btn.dataset.currency; saveTasks(); renderAllLists(); closeCustomPrompt(); }); }); } }); }

// 【移除】旧的 moveTask, enterSortMode, exitSortMode 函数
// function moveTask(fromIndex, direction) { ... }
// function enterSortMode(targetLi) { ... }
// function exitSortMode() { ... }

async function updateNotificationButtonUI() { if (!toggleNotificationsBtn) return; const icon = toggleNotificationsBtn.querySelector('img'); if (!icon) return; try { const permissionState = await navigator.permissions.query({ name: 'notifications' }); let pushSubscription = null; try { pushSubscription = await db.get('pushSubscription'); } catch(dbError) { console.warn("更新通知按钮UI失败：无法从DB获取推送订阅状态:", dbError); } if (permissionState.state === 'granted') { if (pushSubscription) { icon.src = 'images/icon-notifications-on.svg'; toggleNotificationsBtn.title = '通知已开启 (已订阅)'; } else { icon.src = 'images/icon-notifications-issue.svg'; toggleNotificationsBtn.title = '通知已授权，但订阅失败 (点击重试)'; } } else if (permissionState.state === 'prompt') { icon.src = 'images/icon-notifications-off.svg'; toggleNotificationsBtn.title = '点击开启通知 (需要授权)'; } else { icon.src = 'images/icon-notifications-blocked.svg'; toggleNotificationsBtn.title = '通知已被阻止 (请在浏览器设置中更改)'; } } catch (error) { icon.src = 'images/icon-notifications-off.svg'; toggleNotificationsBtn.title = '检查通知状态时出错'; } }
async function handleNotificationToggle() { if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) { openCustomPrompt({title:"功能不支持", message:'您的浏览器不支持桌面通知或推送功能。', inputType:'none', hideCancelButton:true, confirmText:'好的'}); notificationsEnabled = false; localStorage.setItem('notificationsEnabled', 'false'); await updateNotificationButtonUI(); return; } try { if (notificationsEnabled) { const permission = await Notification.requestPermission(); if (permission === 'granted') { await subscribeUserToPush(); } else { if (permission === 'denied') { notificationsEnabled = false; localStorage.setItem('notificationsEnabled', 'false'); } } } else { await unsubscribeUserFromPush(); } } catch (error) { notificationsEnabled = !notificationsEnabled; localStorage.setItem('notificationsEnabled', String(notificationsEnabled)); } await updateNotificationButtonUI(); }
async function unsubscribeUserFromPush() { if (!('serviceWorker' in navigator)) { return; } try { const registration = await navigator.serviceWorker.ready; const subscription = await registration.pushManager.getSubscription(); if (subscription) { const unsubscribed = await subscription.unsubscribe(); if (unsubscribed) { await db.set('pushSubscription', null); } } else { await db.set('pushSubscription', null); } } catch (error) { console.error('取消订阅推送失败:', error); } }
async function subscribeUserToPush() { if (!('serviceWorker' in navigator) || !navigator.serviceWorker.ready) { return null; } try { const registration = await navigator.serviceWorker.ready; const existingSubscription = await registration.pushManager.getSubscription(); if (existingSubscription) { await db.set('pushSubscription', existingSubscription); return existingSubscription; } const vapidPublicKey = 'BOPBv2iLpTziiOOTjw8h2cT24-R_5c0s_q2ITf0JOTooBKiJBDl3bBROi4e_d_2dJd_quNBs2LrqEa2K_u_XGgY'; if (!vapidPublicKey) { openCustomPrompt({title:"配置错误", message:'推送通知配置不完整，无法订阅。', inputType:'none', hideCancelButton:true, confirmText:'好的'}); return null; } const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) }); await db.set('pushSubscription', subscription); return subscription; } catch (error) { if (error.name === 'InvalidStateError') { openCustomPrompt({title:"订阅失败", message:'无法订阅推送通知，可能是由于浏览器设置或网络问题。请稍后重试。', inputType:'none', hideCancelButton:true, confirmText:'好的'}); } else if (error.name === 'NotAllowedError') { openCustomPrompt({title:"权限问题", message:'浏览器阻止了通知订阅。请检查通知权限设置。', inputType:'none', hideCancelButton:true, confirmText:'好的'}); } await db.set('pushSubscription', null); return null; } }
function urlBase64ToUint8Array(base64String) { const padding = '='.repeat((4 - base64String.length % 4) % 4); const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/'); const rawData = window.atob(base64); const outputArray = new Uint8Array(rawData.length); for (let i = 0; i < rawData.length; ++i) { outputArray[i] = rawData.charCodeAt(i); } return outputArray; }
function openCustomPrompt(config) { currentPromptConfig = config; if(customPromptModal && customPromptTitleEl && customPromptMessageEl && customPromptInputContainer && customPromptConfirmBtn && customPromptCancelBtn) { customPromptTitleEl.textContent = config.title || '提示'; customPromptMessageEl.textContent = config.message || ''; customPromptMessageEl.style.display = config.message ? 'block' : 'none'; customPromptInputContainer.innerHTML = ''; if (config.inputType && config.inputType !== 'none') { let inputEl; if (config.inputType === 'textarea') { inputEl = document.createElement('textarea'); inputEl.rows = config.rows || 4; } else { inputEl = document.createElement('input'); inputEl.type = config.inputType; } inputEl.id = 'custom-prompt-input-field'; inputEl.className = 'custom-prompt-input'; if (config.placeholder) inputEl.placeholder = config.placeholder; if (config.initialValue !== undefined) inputEl.value = config.initialValue; if (config.inputAttributes) { for (const attr in config.inputAttributes) { inputEl.setAttribute(attr, config.inputAttributes[attr]); } } customPromptInputContainer.appendChild(inputEl); customPromptInputContainer.style.display = 'block'; setTimeout(() => inputEl.focus(), 50); } else { customPromptInputContainer.style.display = 'none'; } if (config.htmlContent) { customPromptInputContainer.innerHTML = config.htmlContent; customPromptInputContainer.style.display = 'block'; } customPromptConfirmBtn.textContent = config.confirmText || '确认'; customPromptCancelBtn.textContent = config.cancelText || '取消'; customPromptConfirmBtn.style.display = config.hideConfirmButton ? 'none' : 'inline-block'; customPromptCancelBtn.style.display = config.hideCancelButton ? 'none' : 'inline-block'; customPromptModal.classList.remove('hidden'); if (typeof config.onRender === 'function') { config.onRender(); } } }
function closeCustomPrompt() { if(customPromptModal) customPromptModal.classList.add('hidden'); currentPromptConfig = {}; if (activeKeydownHandler) { document.removeEventListener('keydown', activeKeydownHandler); activeKeydownHandler = null; } }
function checkAndMoveFutureTasks() { const now = Date.now(); let tasksWereMoved = false; if (allTasks.future && allTasks.future.length > 0) { const dueFutureTasks = []; const remainingFutureTasks = []; allTasks.future.forEach(task => { let taskDateTimestamp = Infinity; if (task.date) { try { taskDateTimestamp = new Date(task.date + 'T23:59:59').getTime(); } catch (e) { console.warn("Invalid date format for future task:", task.date); } } if ((task.reminderTime && task.reminderTime <= now) || (taskDateTimestamp <= now)) { dueFutureTasks.push(task); } else { remainingFutureTasks.push(task); } }); if (dueFutureTasks.length > 0) { if (!allTasks.daily) allTasks.daily = []; dueFutureTasks.forEach(task => { allTasks.daily.unshift({ id: generateUniqueId(), text: `[计划] ${task.text}`, completed: false, note: task.note || (task.progressText || ''), links: task.links || [] }); }); allTasks.future = remainingFutureTasks; tasksWereMoved = true; } } if (tasksWereMoved) { saveTasks().then(renderAllLists); } }

let GAPI_INSTANCE = null;
let GIS_OAUTH2_INSTANCE = null;

// ========================================================================
// 8. 应用初始化
// ========================================================================
function bindEventListeners() {
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
    if (statsBtn) statsBtn.addEventListener('click', () => { if (statsModal) { handleStatsButtonClick(); } });
    if (faqBtn) faqBtn.addEventListener('click', showFaqModal);
    if (featuresBtn) featuresBtn.addEventListener('click', showFeaturesModal);
    if (donateBtn) donateBtn.addEventListener('click', () => openModal(donateModal));
    if (monthlyHistoryBtn) { monthlyHistoryBtn.addEventListener('click', () => { if (selectedMonthlyDisplayMonth !== 'current') { resetToCurrent('monthly'); } else { openHistoryModal('monthly'); } }); }
    if (ledgerHistoryBtn) { ledgerHistoryBtn.addEventListener('click', () => { if (selectedLedgerMonth !== 'current') { resetToCurrent('ledger'); } else { openHistoryModal('ledger'); } }); }
    const moreActionsBtn = document.getElementById('more-actions-btn');
    const moreActionsMenu = document.getElementById('more-actions-menu');
    if (moreActionsBtn && moreActionsMenu) {
        moreActionsBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            moreActionsMenu.classList.toggle('visible');
            const isExpanded = moreActionsMenu.classList.contains('visible');
            moreActionsBtn.setAttribute('aria-expanded', isExpanded.toString());
        });
        document.addEventListener('click', (event) => {
            if (moreActionsMenu.classList.contains('visible') && !moreActionsMenu.contains(event.target) && event.target !== moreActionsBtn && !moreActionsBtn.contains(event.target) ) {
                moreActionsMenu.classList.remove('visible');
                moreActionsBtn.setAttribute('aria-expanded', 'false');
            }
        });
        moreActionsMenu.querySelectorAll('button').forEach(button => {
            button.addEventListener('click', () => {
                moreActionsMenu.classList.remove('visible');
                moreActionsBtn.setAttribute('aria-expanded', 'false');
            });
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && moreActionsMenu.classList.contains('visible')) {
                moreActionsMenu.classList.remove('visible');
                moreActionsBtn.setAttribute('aria-expanded', 'false');
            }
        });
    }
    if (themeToggleBtn) themeToggleBtn.addEventListener('click', toggleTheme);
    if (feedbackBtn) feedbackBtn.addEventListener('click', () => { window.open('mailto:martinlinzhiwu@gmail.com?subject=Regarding EfficienTodo PWA', '_blank'); });
    if (toggleNotificationsBtn) toggleNotificationsBtn.addEventListener('click', toggleNotificationSetting);
    if (mainSearchInput) { mainSearchInput.addEventListener('input', (e) => { currentSearchTerm = e.target.value.trim().toLowerCase(); renderAllLists(); }); }
    if (addDailyTaskBtn && newDailyTaskInput) { addDailyTaskBtn.addEventListener('click', () => addTask(newDailyTaskInput, 'daily', renderAllLists, { type: 'daily' })); newDailyTaskInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') addDailyTaskBtn.click(); }); }
    if (addMonthlyTaskBtn && newMonthlyTaskInput && newMonthlyTagsInput) { const addMonthlyHandler = () => addTask(newMonthlyTaskInput, 'monthly', renderAllLists, { type: 'monthly', tagsInputElement: newMonthlyTagsInput }); addMonthlyTaskBtn.addEventListener('click', addMonthlyHandler); newMonthlyTaskInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') addMonthlyHandler(); }); newMonthlyTagsInput.addEventListener('keypress', (e) => { if (e.key === 'Enter') addMonthlyHandler(); }); }
    if (addFutureTaskBtn && newFutureTaskInput && futureTaskDateTimeInput) { addFutureTaskBtn.addEventListener('click', () => addTask(newFutureTaskInput, 'future', renderAllLists, { type: 'future', dateElement: futureTaskDateTimeInput })); }
    if (addLedgerBtn && ledgerDateInput && ledgerItemInput && ledgerAmountInput) { const addLedgerEntry = () => { const date = ledgerDateInput.value; const item = ledgerItemInput.value.trim(); const amountStr = ledgerAmountInput.value.trim(); const payment = ledgerPaymentInput ? ledgerPaymentInput.value.trim() : ''; const details = ledgerDetailsInput ? ledgerDetailsInput.value.trim() : ''; if (!date || !item || !amountStr) { openCustomPrompt({ title: "输入不完整", message: "请完整填写日期、项目和金额！", inputType: 'none', confirmText: "好的", hideCancelButton: true }); return; } const amount = parseFloat(amountStr); if (isNaN(amount) || amount <= 0) { openCustomPrompt({ title: "金额无效", message: "请输入有效的正数金额！", inputType: 'none', confirmText: "好的", hideCancelButton: true }); return; } if (!allTasks.ledger) allTasks.ledger = []; allTasks.ledger.unshift({ date, item, amount, payment, details }); ledgerDateInput.valueAsDate = new Date(); ledgerItemInput.value = ''; ledgerAmountInput.value = ''; if(ledgerPaymentInput) ledgerPaymentInput.value = ''; if(ledgerDetailsInput) ledgerDetailsInput.value = ''; ledgerItemInput.focus(); saveTasks().then(renderAllLists); }; addLedgerBtn.addEventListener('click', addLedgerEntry); const ledgerInputsForEnter = [ledgerItemInput, ledgerAmountInput, ledgerPaymentInput, ledgerDetailsInput].filter(Boolean); ledgerInputsForEnter.forEach((input, idx) => { if (input) { input.addEventListener('keypress', e => { if (e.key === 'Enter') { if (idx === ledgerInputsForEnter.length - 1 || (ledgerInputsForEnter[idx+1] === ledgerAmountInput && !ledgerAmountInput.value.trim()) || (ledgerInputsForEnter[idx+1] !== ledgerAmountInput && !ledgerInputsForEnter[idx+1].value.trim()) ) { addLedgerEntry(); } else if (ledgerInputsForEnter[idx+1]) { ledgerInputsForEnter[idx+1].focus(); } } }); } }); }
    if (historyPrevYearBtn) historyPrevYearBtn.addEventListener('click', () => changeHistoryYear(-1));
    if (historyNextYearBtn) historyNextYearBtn.addEventListener('click', () => changeHistoryYear(1));
    if (downloadMonthlyTemplateBtn) downloadMonthlyTemplateBtn.addEventListener('click', downloadMonthlyTemplate);
    if (exportMonthlyHistoryBtn) exportMonthlyHistoryBtn.addEventListener('click', exportMonthlyHistory);
    if (importMonthlyBtn && importMonthlyFileInput) { importMonthlyBtn.addEventListener('click', () => importMonthlyFileInput.click()); importMonthlyFileInput.addEventListener('change', handleMonthlyImport); }
    if (downloadLedgerTemplateBtn) downloadLedgerTemplateBtn.addEventListener('click', downloadLedgerTemplate);
    if (exportLedgerHistoryBtn) exportLedgerHistoryBtn.addEventListener('click', exportLedgerHistory);
    if (importLedgerBtn && importLedgerFileInput) { importLedgerBtn.addEventListener('click', () => importLedgerFileInput.click()); importLedgerFileInput.addEventListener('change', handleLedgerImport); }
    if (sortMonthlyByPriorityBtn) sortMonthlyByPriorityBtn.addEventListener('click', sortMonthlyTasksByPriority);
    if (setBudgetBtn) setBudgetBtn.addEventListener('click', openBudgetModal);
    if (annualReportBtn) annualReportBtn.addEventListener('click', openAnnualReportModal);
    if (currencyPickerBtn) currencyPickerBtn.addEventListener('click', openCurrencyPicker);
    if (customPromptConfirmBtn) { customPromptConfirmBtn.addEventListener('click', () => { if(typeof currentPromptConfig.onConfirm === 'function') { const inputField = document.getElementById('custom-prompt-input-field'); const value = inputField ? inputField.value : undefined; if(currentPromptConfig.onConfirm(value) !== false) { closeCustomPrompt(); } } else { closeCustomPrompt(); } }); }
    if(customPromptCancelBtn) { customPromptCancelBtn.addEventListener('click', () => { if(typeof currentPromptConfig.onCancel === 'function') currentPromptConfig.onCancel(); closeCustomPrompt(); }); }
    if (syncDriveBtn && syncStatusSpan) {
        syncDriveBtn.addEventListener('click', async () => {
            syncStatusSpan.textContent = '初始化同步...';
            syncDriveBtn.disabled = true;
            try {
                if (!driveSync.gapi || !driveSync.gisOAuth2 || (driveSync.gisOAuth2 && !driveSync.tokenClient) ) {
                    await loadGoogleApis(); 
                    if (!driveSync.gapi || !driveSync.gisOAuth2 || (driveSync.gisOAuth2 && !driveSync.tokenClient)) {
                        throw new Error('Google API 客户端未能成功初始化。');
                    }
                }
                syncStatusSpan.textContent = '正在授权...';
                const auth = await driveSync.authenticate();
                if (!auth || !auth.success) throw new Error('Google Drive 授权失败。');
                syncStatusSpan.textContent = '查找云文件...';
                await driveSync.findOrCreateFile();
                if (!driveSync.driveFileId) throw new Error('未能找到或创建云端文件。');
                syncStatusSpan.textContent = '下载云数据...';
                const cloudData = await driveSync.download();
                let localData = await db.get('allTasks');
                if (!localData || typeof localData !== 'object') {
                    localData = { daily: [], monthly: [], future: [], ledger: [], history: {}, ledgerHistory: {}, budgets: {}, currencySymbol: '$', lastUpdatedLocal: 0 };
                }
                if (cloudData && typeof cloudData === 'object' && cloudData.lastUpdatedLocal && (!localData.lastUpdatedLocal || cloudData.lastUpdatedLocal > localData.lastUpdatedLocal)) {
                    syncStatusSpan.textContent = '云端数据较新，正在合并...';
                    allTasks = cloudData;
                    await db.set('allTasks', allTasks);
                    await loadTasks(renderAllLists);
                    syncStatusSpan.textContent = '已从云端同步！';
                } else if (localData && (!cloudData || !cloudData.lastUpdatedLocal || localData.lastUpdatedLocal >= (cloudData.lastUpdatedLocal || 0))) {
                    syncStatusSpan.textContent = '上传本地数据...';
                    if(allTasks.lastUpdatedLocal !== localData.lastUpdatedLocal) {
                        allTasks = localData;
                    }
                    const uploadResult = await driveSync.upload(allTasks);
                    syncStatusSpan.textContent = uploadResult.message;
                } else {
                     syncStatusSpan.textContent = '数据已是最新，无需同步。';
                }
            } catch (error) {
                syncStatusSpan.textContent = `同步错误: ${error.message ? error.message.substring(0, 30) : '未知错误'}...`;
                 if (error.message && (error.message.includes("Token has been expired or revoked") || error.message.includes("popup_closed_by_user") || error.message.includes("access_denied"))) {
                    openCustomPrompt({ title: "授权问题", message: "Google Drive 授权失败或被取消。请确保您已授权，并重试同步。", inputType: 'none', confirmText: '好的', hideCancelButton: true });
                }
            } finally {
                syncDriveBtn.disabled = false;
                setTimeout(() => { if (syncStatusSpan) syncStatusSpan.textContent = ''; }, 7000);
            }
        });
    }
    setupStatsTimespanSelectors();
}

async function initializeApp() {
    statsModal = document.getElementById('stats-modal');
    if (!statsModal) console.error("关键错误：未能获取到 stats-modal 元素！请检查 HTML ID。");
    statsBtn = document.getElementById('stats-btn');
    const statsModals = document.querySelectorAll('#stats-modal');
    if (statsModals.length > 0) {
        statsModal = statsModals[0];
        if (statsModal) statsModalCloseBtn = statsModal.querySelector('#stats-modal-close-btn');
    }
    faqBtn = document.getElementById('faq-btn');
    faqModal = document.getElementById('faq-modal');
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
    historyModalTitle = document.getElementById('history-modal-title');
    historyPrevYearBtn = document.getElementById('history-prev-year-btn');
    historyNextYearBtn = document.getElementById('history-next-year-btn');
    historyCurrentYearSpan = document.getElementById('history-current-year');
    historyMonthsGrid = document.getElementById('history-months-grid');
    donateModal = document.getElementById('donate-modal');
    featuresBtn = document.getElementById('features-btn');
    featuresModal = document.getElementById('features-modal');
    featuresListUl = document.getElementById('features-list');
    exportMonthlyHistoryBtn = document.getElementById('export-monthly-history-btn');
    importMonthlyBtn = document.getElementById('import-monthly-btn');
    downloadMonthlyTemplateBtn = document.getElementById('download-monthly-template-btn');
    importMonthlyFileInput = document.getElementById('import-monthly-file-input');
    exportLedgerHistoryBtn = document.getElementById('export-ledger-history-btn');
    importLedgerBtn = document.getElementById('import-ledger-btn');
    downloadLedgerTemplateBtn = document.getElementById('download-ledger-template-btn');
    importLedgerFileInput = document.getElementById('import-ledger-file-input');
    toggleNotificationsBtn = document.getElementById('toggle-notifications-btn');
    customPromptModal = document.getElementById('custom-prompt-modal');
    customPromptTitleEl = document.getElementById('custom-prompt-title');
    customPromptMessageEl = document.getElementById('custom-prompt-message');
    customPromptInputContainer = document.getElementById('custom-prompt-input-container');
    customPromptConfirmBtn = document.getElementById('custom-prompt-confirm-btn');
    customPromptCancelBtn = document.getElementById('custom-prompt-cancel-btn');
    setBudgetBtn = document.getElementById('set-budget-btn');
    annualReportBtn = document.getElementById('annual-report-btn');
    annualReportModal = document.getElementById('annual-report-modal');
    annualReportTitle = document.getElementById('annual-report-title');
    annualReportPrevYearBtn = document.getElementById('annual-report-prev-year-btn');
    annualReportNextYearBtn = document.getElementById('annual-report-next-year-btn');
    annualReportCurrentYearSpan = document.getElementById('annual-report-current-year');
    annualReportSummaryDiv = document.getElementById('annual-report-summary');
    annualReportDetailsDiv = document.getElementById('annual-report-details');
    currencyPickerBtn = document.getElementById('currency-picker-btn');
    syncDriveBtn = document.getElementById('sync-drive-btn');
    syncStatusSpan = document.getElementById('sync-status');
    bottomNav = document.querySelector('.bottom-tab-nav');
    allSections = document.querySelectorAll('.section[id]');

    bindEventListeners();
    loadTheme();
    await loadNotificationSetting();
    try {
        await loadGoogleApis();
    } catch (error) {
        if (syncStatusSpan) syncStatusSpan.textContent = 'Google 服务加载失败。';
    }
    try {
        await loadTasks();
        const dailyTasksChanged = await checkAndResetDailyTasks();
        if (dailyTasksChanged) await saveTasks();
        checkAndMoveFutureTasks();
    } catch (e) {
        openCustomPrompt({title:"加载数据失败", message:"无法加载您的数据，请尝试刷新页面或清除应用数据。", inputType:'none', confirmText:'好的', hideCancelButton:true});
        return;
    }
    renderAllLists();
    initSortable();
    if (ledgerDateInput) ledgerDateInput.valueAsDate = new Date();
    switchView('daily-section');
}

// 统计图表功能 (保持不变)
let taskCompletionByTagChartInstance = null;
let taskTagDistributionChartInstance = null;
function formatChartDateLabel(dateObj, span) { const year = dateObj.getFullYear(); const month = dateObj.getMonth() + 1; const day = dateObj.getDate(); if (span === 'daily') { return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`; } else if (span === 'weekly') { const d = new Date(Date.UTC(year, dateObj.getMonth(), day)); d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7)); const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1)); const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7); return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`; } else if (span === 'monthly') { return `${year}-${String(month).padStart(2, '0')}`; } else if (span === 'yearly') { return `${year}`; } return dateObj.toISOString().slice(0, 10); }
function generateChartDateLabels(span, periodCount) { const labels = []; const today = new Date(); today.setHours(0, 0, 0, 0); if (span === 'daily') { for (let i = 0; i < periodCount; i++) { const date = new Date(today); date.setDate(today.getDate() - (periodCount - 1 - i)); labels.push(formatChartDateLabel(date, span)); } } else if (span === 'weekly') { let currentIterDate = new Date(today); currentIterDate.setDate(today.getDate() - (today.getDay() === 0 ? 6 : today.getDay() - 1)); for (let i = 0; i < periodCount; i++) { const date = new Date(currentIterDate); date.setDate(currentIterDate.getDate() - (periodCount - 1 - i) * 7); labels.push(formatChartDateLabel(date, span)); } } else if (span === 'monthly') { for (let i = 0; i < periodCount; i++) { const date = new Date(today.getFullYear(), today.getMonth() - (periodCount - 1 - i), 1); labels.push(formatChartDateLabel(date, span)); } } else if (span === 'yearly') { for (let i = 0; i < periodCount; i++) { const year = today.getFullYear() - (periodCount - 1 - i); labels.push(formatChartDateLabel(new Date(year, 0, 1), span)); } } return labels; }
function prepareTaskCompletionData(span = 'daily', period = 30) { if (!allTasks || (!allTasks.monthly && !allTasks.history)) { return { labels: [], datasets: [] }; } const labels = generateChartDateLabels(span, period); const datasetsMap = new Map(); const totalCounts = new Array(labels.length).fill(0); const processTask = (task) => { if (task.completed && task.completionDate) { const completionDateObj = new Date(task.completionDate); const labelForCompletion = formatChartDateLabel(completionDateObj, span); const labelIndex = labels.indexOf(labelForCompletion); if (labelIndex !== -1) { totalCounts[labelIndex]++; const taskTags = task.tags && task.tags.length > 0 ? task.tags : ['无标签']; taskTags.forEach(tag => { if (!datasetsMap.has(tag)) { datasetsMap.set(tag, new Array(labels.length).fill(0)); } datasetsMap.get(tag)[labelIndex]++; }); } } }; (allTasks.monthly || []).forEach(processTask); Object.values(allTasks.history || {}).flat().forEach(processTask); const finalDatasets = []; finalDatasets.push({ label: '总计完成', data: totalCounts, borderColor: 'rgba(75, 192, 192, 1)', backgroundColor: 'rgba(75, 192, 192, 0.2)', tension: 0.1, fill: true, order: 0 }); const tagColors = ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40', '#C9CBCF']; let colorIndex = 0; datasetsMap.forEach((counts, tag) => { finalDatasets.push({ label: tag, data: counts, borderColor: tagColors[colorIndex % tagColors.length], backgroundColor: tagColors[colorIndex % tagColors.length].replace(')', ', 0.1)').replace('rgb', 'rgba'), tension: 0.1, fill: false, order: colorIndex + 1 }); colorIndex++; }); return { labels, datasets: finalDatasets }; }
function renderTaskCompletionByTagChart(span = 'daily', period = 30) { if (typeof Chart === 'undefined') return; const ctx = document.getElementById('taskCompletionByTagChart')?.getContext('2d'); if (!ctx) return; const chartData = prepareTaskCompletionData(span, period); if (taskCompletionByTagChartInstance) taskCompletionByTagChartInstance.destroy(); taskCompletionByTagChartInstance = new Chart(ctx, { type: 'line', data: chartData, options: { responsive: true, maintainAspectRatio: false, scales: { y: { beginAtZero: true, ticks: { stepSize: 1, precision: 0 } } }, plugins: { title: { display: false }, legend: { position: 'top' } } } }); }
function prepareTaskTagDistributionData(period = 'today') { if (!allTasks || (!allTasks.monthly && !allTasks.history)) { return { labels: [], datasets: [{ data: [] }] }; } const tagCounts = {}; const now = new Date(); const todayFormatted = formatChartDateLabel(now, 'daily'); const thisMonthFormatted = formatChartDateLabel(now, 'monthly'); const thisYearFormatted = formatChartDateLabel(now, 'yearly'); const processTask = (task) => { if (task.completed && task.completionDate) { const completionDateObj = new Date(task.completionDate); let includeTask = false; if (period === 'today' && formatChartDateLabel(completionDateObj, 'daily') === todayFormatted) { includeTask = true; } else if (period === 'thisMonth' && formatChartDateLabel(completionDateObj, 'monthly') === thisMonthFormatted) { includeTask = true; } else if (period === 'thisYear' && formatChartDateLabel(completionDateObj, 'yearly') === thisYearFormatted) { includeTask = true; } if (includeTask) { const taskTags = task.tags && task.tags.length > 0 ? task.tags : ['无标签']; taskTags.forEach(tag => { tagCounts[tag] = (tagCounts[tag] || 0) + 1; }); } } }; (allTasks.monthly || []).forEach(processTask); Object.values(allTasks.history || {}).flat().forEach(processTask); const sortedTags = Object.entries(tagCounts).sort(([, a], [, b]) => b - a); return { labels: sortedTags.map(([tag]) => tag), datasets: [{ data: sortedTags.map(([, count]) => count), backgroundColor: [ '#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40', '#C9CBCF', '#E7E9ED', '#8A2BE2', '#7FFF00' ], hoverOffset: 4 }] }; }
function renderTaskTagDistributionChart(period = 'today') { if (typeof Chart === 'undefined') return; const ctx = document.getElementById('taskTagDistributionChart')?.getContext('2d'); if (!ctx) return; const chartData = prepareTaskTagDistributionData(period); if (taskTagDistributionChartInstance) taskTagDistributionChartInstance.destroy(); taskTagDistributionChartInstance = new Chart(ctx, { type: 'pie', data: chartData, options: { responsive: true, maintainAspectRatio: false, plugins: { title: { display: false }, legend: { position: 'right' }, tooltip: { callbacks: { label: function(context) { let label = context.label || ''; if (label) label += ': '; const value = context.parsed; label += value; const total = context.dataset.data.reduce((a, b) => a + b, 0); const percentage = total > 0 ? (value / total * 100).toFixed(1) + '%' : '0%'; label += ` (${percentage})`; return label; } } } } } }); }
function renderAllStatsCharts() { if (!allTasks || Object.keys(allTasks).length === 0) { const statsGrid = document.querySelector('#stats-modal .stats-grid'); if (statsGrid) statsGrid.innerHTML = '<p style="text-align:center; padding: 20px;">统计数据正在加载中或暂无数据...</p>'; return; } const activeCompletionSelector = document.querySelector('#task-completion-timespan-selector button.active') || document.querySelector('#task-completion-timespan-selector button[data-span="daily"]'); const completionSpan = activeCompletionSelector.dataset.span; const completionPeriod = parseInt(activeCompletionSelector.dataset.period, 10); const activeDistributionSelector = document.querySelector('#task-tag-distribution-timespan-selector button.active') || document.querySelector('#task-tag-distribution-timespan-selector button[data-period="today"]'); const distributionPeriod = activeDistributionSelector.dataset.period; const statsGrid = document.querySelector('#stats-modal .stats-grid'); if (statsGrid && statsGrid.querySelector('p')) { statsGrid.innerHTML = ` <div class="chart-card"> <div class="chart-header"> <h2>已完成任务趋势 (按标签)</h2> <div id="task-completion-timespan-selector" class="timespan-selector"> <button data-span="daily" data-period="30" class="${completionSpan === 'daily' ? 'active' : ''}">近30天 (日)</button> <button data-span="weekly" data-period="26" class="${completionSpan === 'weekly' ? 'active' : ''}">近半年 (周)</button> <button data-span="monthly" data-period="12" class="${completionSpan === 'monthly' ? 'active' : ''}">近1年 (月)</button> <button data-span="yearly" data-period="5" class="${completionSpan === 'yearly' ? 'active' : ''}">近5年 (年)</button> </div> </div> <div class="chart-canvas-container"><canvas id="taskCompletionByTagChart"></canvas></div> </div> <div class="chart-card"> <div class="chart-header"> <h2>已完成任务标签分布</h2> <div id="task-tag-distribution-timespan-selector" class="timespan-selector"> <button data-period="today" class="${distributionPeriod === 'today' ? 'active' : ''}">今日</button> <button data-period="thisMonth" class="${distributionPeriod === 'thisMonth' ? 'active' : ''}">本月</button> <button data-period="thisYear" class="${distributionPeriod === 'thisYear' ? 'active' : ''}">今年</button> </div> </div> <div class="chart-canvas-container"><canvas id="taskTagDistributionChart"></canvas></div> </div>`; setupStatsTimespanSelectors(); } renderTaskCompletionByTagChart(completionSpan, completionPeriod); renderTaskTagDistributionChart(distributionPeriod); }
function handleStatsButtonClick() { if (!allTasks || Object.keys(allTasks).length === 0) { const statsModalElement = document.getElementById('stats-modal'); if (statsModalElement) { const statsModalContent = statsModalElement.querySelector('.stats-grid'); if (statsModalContent) statsModalContent.innerHTML = '<p style="text-align:center; padding: 20px;">正在准备统计数据...</p>'; openModal(statsModalElement); if (typeof loadTasks === 'function') { loadTasks(() => { renderAllStatsCharts(); }); } } return; } renderAllStatsCharts(); openModal(document.getElementById('stats-modal')); }
function setupStatsTimespanSelectors() { const taskCompletionSelector = document.getElementById('task-completion-timespan-selector'); if (taskCompletionSelector) { const newSelector = taskCompletionSelector.cloneNode(true); taskCompletionSelector.parentNode.replaceChild(newSelector, taskCompletionSelector); newSelector.addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') { const buttons = newSelector.querySelectorAll('button'); buttons.forEach(btn => btn.classList.remove('active')); e.target.classList.add('active'); const span = e.target.dataset.span; const period = parseInt(e.target.dataset.period, 10); renderTaskCompletionByTagChart(span, period); } }); } const taskTagDistributionSelector = document.getElementById('task-tag-distribution-timespan-selector'); if (taskTagDistributionSelector) { const newSelector = taskTagDistributionSelector.cloneNode(true); taskTagDistributionSelector.parentNode.replaceChild(newSelector, taskTagDistributionSelector); newSelector.addEventListener('click', (e) => { if (e.target.tagName === 'BUTTON') { const buttons = newSelector.querySelectorAll('button'); buttons.forEach(btn => btn.classList.remove('active')); e.target.classList.add('active'); const period = e.target.dataset.period; renderTaskTagDistributionChart(period); } }); } }

// 最终的启动入口
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}

// Service Worker 更新逻辑
let newWorker;
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready.then(reg => {
        if (!reg) return;
        reg.addEventListener('updatefound', () => {
            newWorker = reg.installing;
            if (!newWorker) return;
            newWorker.addEventListener('statechange', () => {
                if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    openCustomPrompt({ title: "应用更新", message: "新版本已准备就绪，刷新以应用更新吗？", confirmText: "刷新", cancelText: "稍后", onConfirm: () => { newWorker.postMessage({ action: 'skipWaiting' }); } });
                }
            });
        });
    }).catch(error => console.error("Error getting SW registration for update check:", error));
    navigator.serviceWorker.getRegistration().then(reg => {
        if (reg && reg.waiting) {
            newWorker = reg.waiting;
             openCustomPrompt({ title: "应用更新", message: "检测到应用有更新，刷新以应用最新版本吗？", confirmText: "刷新", cancelText: "稍后", onConfirm: () => { newWorker.postMessage({ action: 'skipWaiting' }); } });
        }
    }).catch(error => console.error("Error getting SW registration for waiting check:", error));
    let refreshing;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        window.location.reload();
        refreshing = true;
    });
}
