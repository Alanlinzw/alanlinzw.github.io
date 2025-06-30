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
    API_KEY: 'AIzaSyAHn27YYXEIwQuLRWi1lh2A48ffmr_wKcQ',
    SCOPES: 'https://www.googleapis.com/auth/drive.file',
    DISCOVERY_DOCS: ["https://www.googleapis.com/discovery/v1/apis/drive/v3/rest"],
    DRIVE_FILE_NAME: 'efficienTodoData.json',
    tokenClient: null,
    driveFileId: null,
    gapi: null, // 将在此模块外部由 loadGoogleApis 函数设置
    gisOAuth2: null, // 将在此模块外部由 loadGoogleApis 函数设置

   // 【CORRECTED】
// (在 driveSync 对象内部)
initClients: async function() {
    console.log("driveSync.initClients: 开始初始化客户端。");
    return new Promise((resolve, reject) => {
        // 检查 gapi 和 gis 是否已由 loadGoogleApis 设置
        if (!driveSync.gapi) {
            return reject(new Error("driveSync.initClients: driveSync.gapi 未定义。"));
        }
        if (!driveSync.gis) { // 使用统一的 'gis' 属性名
            return reject(new Error("driveSync.initClients: driveSync.gis (google.accounts.oauth2) 未定义。"));
        }

        driveSync.gapi.load('client', async () => {
            try {
                await driveSync.gapi.client.init({
                    apiKey: driveSync.API_KEY,
                    discoveryDocs: driveSync.DISCOVERY_DOCS,
                });
                console.log("driveSync.initClients: gapi.client.init 成功。");

                // 使用 driveSync.gis 初始化 token 客户端
                driveSync.tokenClient = driveSync.gis.initTokenClient({
                    client_id: driveSync.CLIENT_ID,
                    scope: driveSync.SCOPES,
                    callback: '', // 回调在 authenticate 方法中按需设置
                });

                if (driveSync.tokenClient) {
                    console.log("driveSync.initClients: Google API 客户端 (gapi 和 gis) 初始化成功。");
                    resolve();
                } else {
                    reject(new Error("driveSync.initClients: GIS Token Client 初始化失败，返回了 null 或 undefined。"));
                }
                
            } catch (initError) {
                console.error("driveSync.initClients: 初始化过程中出错:", initError);
                reject(initError);
            }
        });
    });
},

authenticate: function() { // 注意：这里不需要 async，因为它返回一个 Promise
    console.log("driveSync.authenticate: Method invoked.");
    return new Promise((resolve, reject) => {
        if (!driveSync.tokenClient) {
             const errMsg = "driveSync.authenticate: GIS Token Client not initialized.";
             console.error(errMsg);
             return reject(new Error(errMsg));
        }

        // 设置回调函数，用于处理来自GIS库的响应
        driveSync.tokenClient.callback = (resp) => {
            // 移除回调，避免下次调用时意外触发
            driveSync.tokenClient.callback = null; 
            
            if (resp.error !== undefined) {
                console.error('driveSync.authenticate: Google Auth Error in callback:', resp);
                // 统一返回一个清晰的错误信息
                let errorMessage = `授权失败: ${resp.error}`;
                if (resp.error === "popup_closed_by_user" || resp.error === "access_denied") {
                    errorMessage = "用户取消了授权。";
                } else if (resp.error === "popup_failed_to_open") {
                     errorMessage = "无法打开授权窗口，请检查浏览器是否阻止了弹出窗口。";
                }
                reject(new Error(errorMessage));
            } else {
                console.log("driveSync.authenticate: GSI token acquired successfully.");
                // 令牌已经由GIS库自动设置给GAPI，我们只需resolve表示成功即可
                resolve({ success: true });
            }
        };
        
        // 【核心修正】不再自行判断 prompt 类型。
        // 直接调用 requestAccessToken，让GIS库自己去决定是否需要弹出窗口。
        // GIS的默认行为是：如果可能，就静默获取；如果必须，才弹出窗口。这正是我们想要的！
        console.log("driveSync.authenticate: Requesting access token. Let GIS handle the prompt.");
        driveSync.tokenClient.requestAccessToken(); 
    });
},
            
// 【CORRECTED】
// (在 app.js 的 driveSync 对象中)
findOrCreateFile: async function() {
    console.log("driveSync.findOrCreateFile: Searching in 'drive' space (user-visible area).");
    if (!driveSync.gapi || !driveSync.gapi.client || !driveSync.gapi.client.drive) {
        throw new Error("driveSync.findOrCreateFile: Google Drive API client not ready.");
    }

    // --- 核心修改：在正确的地方查找文件 ---
    const response = await driveSync.gapi.client.drive.files.list({
        // 查询条件：文件名匹配，并且文件没有被放入回收站
        q: `name='${driveSync.DRIVE_FILE_NAME}' and trashed = false`, 
        // 搜索空间：用户可见的 Google Drive
        spaces: 'drive', 
        // 需要返回的字段
        fields: 'files(id, name)'
    });

    if (response.result.files && response.result.files.length > 0) {
        // 找到了文件
        driveSync.driveFileId = response.result.files[0].id;
        console.log("driveSync.findOrCreateFile: Found existing file in 'drive' space:", driveSync.driveFileId);
        return driveSync.driveFileId;
    } else {
        // 没找到，就创建一个新的
        console.log("driveSync.findOrCreateFile: File not found in 'drive' space, creating a new one.");
        
        // --- 核心修改：在正确的地方创建文件 ---
        const createResponse = await driveSync.gapi.client.drive.files.create({
            // 资源信息：只指定文件名，默认会创建在根目录
            resource: { name: driveSync.DRIVE_FILE_NAME }, 
            // 需要返回的字段
            fields: 'id'
        });
        driveSync.driveFileId = createResponse.result.id;
        console.log("driveSync.findOrCreateFile: Created new file in 'drive' space:", driveSync.driveFileId);
        return driveSync.driveFileId;
    }
},

    upload: async function(data) {
        console.log("driveSync.upload: Method invoked.");
        if (!driveSync.driveFileId) throw new Error("driveSync.upload: No Drive file ID.");
        if (!driveSync.gapi || !driveSync.gapi.client) { // 检查模块内的 gapi.client
            throw new Error("driveSync.upload: Google API client (driveSync.gapi.client) not ready.");
        }

        const boundary = '-------314159265358979323846';
        const delimiter = "\r\n--" + boundary + "\r\n";
        const close_delim = "\r\n--" + boundary + "--";
        const metadata = { 'mimeType': 'application/json' };
        const multipartRequestBody =
            delimiter + 'Content-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(metadata) +
            delimiter + 'Content-Type: application/json\r\n\r\n' + JSON.stringify(data) + close_delim;
        
        console.log("driveSync.upload: Attempting to upload data to file ID:", driveSync.driveFileId);
        // 使用 driveSync.gapi.client.request
        await driveSync.gapi.client.request({
            'path': `/upload/drive/v3/files/${driveSync.driveFileId}`,
            'method': 'PATCH',
            'params': { 'uploadType': 'multipart' },
            'headers': { 'Content-Type': 'multipart/related; boundary="' + boundary + '"' },
            'body': multipartRequestBody
        });
        console.log("driveSync.upload: Upload successful.");
        return { success: true, message: "已同步到云端" }; // 修改提示信息
    },

    download: async function() {
        console.log("driveSync.download: Method invoked.");
        if (!driveSync.driveFileId) {
            console.warn("driveSync.download: No Drive file ID for download.");
            // 考虑返回 null 或一个空对象结构，而不是抛出错误，以便同步逻辑可以处理新文件的情况
            return null; 
        }
        if (!driveSync.gapi || !driveSync.gapi.client || !driveSync.gapi.client.drive) {
            throw new Error("driveSync.download: Google Drive API client (driveSync.gapi.client.drive) not ready.");
        }
        console.log("driveSync.download: Attempting to download from file ID:", driveSync.driveFileId);
        // 使用 driveSync.gapi.client.drive.files.get
        const response = await driveSync.gapi.client.drive.files.get({
            fileId: driveSync.driveFileId,
            alt: 'media'
        });
        if (response.body && response.body.length > 0) {
            try {
                const parsedData = JSON.parse(response.body);
                console.log("driveSync.download: Download and parse successful.");
                return parsedData;
            } catch (e) {
                console.error("driveSync.download: Failed to parse downloaded JSON from Drive:", e, "Body:", response.body);
                throw new Error("云端数据已损坏或非有效JSON。");
            }
        }
        console.log("driveSync.download: Downloaded empty or no data from Drive.");
        return null; // 如果文件为空或未找到内容，返回null
    }
};

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

const versionUpdateNotes = { "3.0.0": [ "【核心重构】引入Google Drive云同步功能，替换原有的Chrome同步机制作为主要数据存储：", "    - **数据更安全：** 您的所有任务和账单数据现在存储在您自己的Google Drive上的特定文件 (`efficienTodoData.json`) 中，由您完全掌控。", "    - **手动与自动同步：** 您可以随时手动点击“同步”按钮与Google Drive同步。同时，插件会在您进行修改后、打开时以及后台定期尝试自动同步，确保数据尽可能保持最新。", "    - **首次使用：** 新安装或从旧版本更新后，请点击“同步”按钮完成Google Drive授权，以启用云同步功能。", "【提醒功能改进】未来计划的提醒闹钟机制优化，提升了任务编辑后提醒的稳定性。", ], "2.1.0": [ "【记账本增强】引入强大的财务管理功能：", "    - **预算管理**：现在可以为每个项目设置月度预算，并在统计中通过进度条直观地查看开销情况。", "    - **年度报告**：一键生成年度收支报告，清晰汇总全年总支出、月均消费，并按项目和月份提供详细分类，助您轻松回顾财务状况。", "    - **多货币支持**：新增货币符号切换功能，支持在全球热门货币（如¥, €, £等）之间选择，满足国际化记账需求。" ], "2.0.0": [ "【核心功能】新增“统计分析”模块，提供多维度任务和账单数据可视化报告，助您洞察效率与开销。", "【功能增强】“本月待办”模块引入任务优先级管理：", "    - 支持为任务设置高、中、低三个优先级。", "    - 可按优先级一键排序任务列表。", "    - 拖拽排序依然有效，提供灵活的任务组织方式。" ], "1.9.0": [ "【核心功能】新增快速添加任务方式：", "1. **右键菜单**：在任何网页上选中文本，右键选择“添加到高效待办清单”，即可快速创建到“本月待办”。", "2. **地址栏命令**：在浏览器地址栏输入 'todo'，按 Tab 或空格，再输入任务内容并回车，即可快速添加。" ], "1.8.0": ["【核心功能】“未来计划”模块新增桌面提醒功能，可以为任务设置精确到分钟的提醒时间。"], "1.7.0": ["优化看板页面体验，增加顶部固定导航，长页面滚动和切换不再繁琐。"], "1.6.0": ["新增搜索框，可以实时搜索所有列表中的任务和记账条目。"], "1.5.0": ["新增当月条目归档功能，将当月任务归档到过去月份。"], "1.4.0": [ "为“本月待办”和“记账本”模块增加了 Excel(xlsx) 导入导出功能。", "现在可以下载数据模板，方便地批量添加任务和账单。", "可以一键导出所有历史归档数据，便于备份和分析。" ], "1.3.0": [ "记账本模块新增历史数据归档与月度账单统计功能，方便回顾与分析。", "本月待办模块增加历史月份查阅功能，轻松回顾过往任务。", "本月待办任务完成后，自动标记完成日期。" ] };

// ========================================================================
// 3. 全局DOM元素变量
// (保持你现有的这部分代码不变)
// ========================================================================
let statsBtn, statsModal, statsModalCloseBtn, faqBtn, faqModal, faqModalCloseBtn, faqListDiv, mainSearchInput, dailyTitleDate, themeToggleBtn, feedbackBtn, donateBtn, dailyTaskList, monthlyTaskList, futureTaskList, ledgerList, monthlyHeaderTitle, sortMonthlyByPriorityBtn, ledgerHeaderTitle, monthlyInputArea, ledgerInputArea, newDailyTaskInput, addDailyTaskBtn, newMonthlyTaskInput, newMonthlyTagsInput, addMonthlyTaskBtn, newFutureTaskInput, futureTaskDateTimeInput, addFutureTaskBtn, ledgerDateInput, ledgerItemInput, ledgerAmountInput, ledgerPaymentInput, ledgerDetailsInput, addLedgerBtn, monthlyTagsContainer, ledgerTagsContainer, ledgerSummaryContainer, monthlyHistoryBtn, ledgerHistoryBtn, historyModal, historyModalCloseBtn, historyModalTitle, historyPrevYearBtn, historyNextYearBtn, historyCurrentYearSpan, historyMonthsGrid, donateModal, modalCloseBtn, featuresBtn, featuresModal, featuresModalCloseBtn, featuresListUl, exportMonthlyHistoryBtn, importMonthlyBtn, downloadMonthlyTemplateBtn, importMonthlyFileInput, exportLedgerHistoryBtn, importLedgerBtn, downloadLedgerTemplateBtn, importLedgerFileInput, toggleNotificationsBtn, customPromptModal, customPromptTitleEl, customPromptMessageEl, customPromptInputContainer, customPromptConfirmBtn, customPromptCancelBtn, customPromptCloseBtn, setBudgetBtn, annualReportBtn, annualReportModal, annualReportCloseBtn, annualReportTitle, annualReportPrevYearBtn, annualReportNextYearBtn, annualReportCurrentYearSpan, annualReportSummaryDiv, annualReportDetailsDiv, currencyPickerBtn, syncDriveBtn, syncStatusSpan, bottomNav, allSections, isHistoryModalOpen;

// ========================================================================
// 4. 核心功能函数定义
// (保持你现有的这部分代码不变，直到 bindEventListeners)
// ========================================================================
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
async function loadTasks(callback) {
    console.log("[PWA] Loading tasks from DB...");
    let data;
    try {
        data = await db.get('allTasks');
    } catch (error) {
        console.error("[PWA] Error loading tasks from DB:", error);
        allTasks = { daily: [], monthly: [], future: [], ledger: [], history: {}, ledgerHistory: {}, budgets: {}, currencySymbol: '$', lastUpdatedLocal: Date.now() };
        await saveTasks();
        if (callback) callback();
        return;
    }
    
    let needsSaveAfterLoad = false;
    if (data && typeof data === 'object') {
        allTasks = data;
        // console.log("[PWA] Tasks loaded from DB. Timestamp:", allTasks.lastUpdatedLocal ? new Date(allTasks.lastUpdatedLocal).toLocaleString() : 'N/A');
        const defaultStructure = { daily: [], monthly: [], future: [], ledger: [], history: {}, ledgerHistory: {}, budgets: {}, currencySymbol: '$', lastUpdatedLocal: 0 };
        for (const key in defaultStructure) {
            if (!allTasks.hasOwnProperty(key) || allTasks[key] === undefined) {
                allTasks[key] = defaultStructure[key];
                needsSaveAfterLoad = true;
            }
        }
    } else {
        console.log("[PWA] No tasks data found in DB or data is not an object. Initializing.");
        allTasks = { daily: [], monthly: [], future: [], ledger: [], history: {}, ledgerHistory: {}, budgets: {}, currencySymbol: '$', lastUpdatedLocal: Date.now() };
        needsSaveAfterLoad = true;
    }

    if (needsSaveAfterLoad) {
        await saveTasks();
    }
    if (callback) callback();
}

async function saveTasks() {
    allTasks.lastUpdatedLocal = Date.now();
    isDataDirty = true; // 标记数据为“脏”
    updateSyncIndicator(); // 更新UI提示
    try {
        await db.set('allTasks', allTasks);
        triggerAutoSync();
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
    const taskText = inputElement.value.trim();
    if (!taskText) return;

    let newTask = {};
    const taskArray = allTasks[taskArrayRefName] || [];

    if (type === 'future') {
        const taskDateTimeValue = dateElement ? dateElement.value : '';
        newTask = { id: generateUniqueId(), text: taskText, completed: false, links: [] };
        
        if (taskDateTimeValue) {
            const reminderDate = new Date(taskDateTimeValue);
            const reminderTimestamp = reminderDate.getTime();

            // 检查时间是否有效且在未来
            if (!isNaN(reminderTimestamp) && reminderTimestamp > Date.now()) {
                newTask.reminderTime = reminderTimestamp;
                
                // ==================== 【核心修改】 ====================
                //  不再使用 setTimeout!
                //  改为向 Service Worker 发送消息
                // ====================================================
                if (notificationsEnabled && 'serviceWorker' in navigator) {
                    navigator.serviceWorker.ready.then(registration => {
                        if (registration.active) {
                            registration.active.postMessage({ 
                                type: 'SCHEDULE_REMINDER' 
                                // 我们不需要发送任务本身，因为SW会从DB读取
                            });
                            console.log(`[App] 已向 Service Worker 发送 SCHEDULE_REMINDER 消息，任务: ${newTask.text}`);
                        } else {
                             console.warn(`[App] 无法发送提醒：Service Worker 已就绪但未激活。`);
                        }
                    }).catch(error => {
                        console.error(`[App] 获取 Service Worker registration 时出错:`, error);
                    });
                }
            } else { 
                // 如果时间无效或已过去，只存储日期部分
                newTask.date = taskDateTimeValue.split('T')[0]; 
            }
        }
    } else if (type === 'daily') {
        newTask = { id: generateUniqueId(), text: taskText, completed: false, note: '', links: [] };
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

function renderDailyTasks(tasksToRender) {
    if (!dailyTaskList) return;
    const now = new Date();
    if (dailyTitleDate) dailyTitleDate.textContent = `(${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')})`;
    dailyTaskList.innerHTML = '';
    const fragment = document.createDocumentFragment();
    tasksToRender.forEach((task) => {
        const originalIndex = allTasks.daily.findIndex(t => t.id === task.id);
        if (originalIndex === -1 && !task.id) {
            console.warn("Daily task missing ID, cannot determine originalIndex:", task);
        }
        const li = document.createElement('li');
        li.className = 'li-daily';
        if (task.completed) { li.classList.add('completed'); }

        // 添加点击事件以展开/折叠
        li.addEventListener('click', (e) => {
            if (e.target.closest('a, button, input, .checkbox')) {
                return;
            }
            const isExpanded = li.classList.toggle('is-expanded');
            if (isExpanded) {
                dailyTaskList.querySelectorAll('li.is-expanded').forEach(item => {
                    if (item !== li) item.classList.remove('is-expanded');
                });
            }
        });

        // Drag handle 不在移动端渲染，但桌面端可能需要，所以用 createDragHandle
        li.appendChild(createDragHandle());

        // createTaskContent 现在会创建所有需要的内部结构
        li.appendChild(createTaskContent(task, originalIndex, 'daily', false));

        fragment.appendChild(li);
    });
    dailyTaskList.appendChild(fragment);
}

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
    featuresListUl.innerHTML = '';
    features.forEach(feature => {
        const li = document.createElement('li');
        li.innerHTML = `<strong>${feature.title}:</strong> ${feature.description}`;
        featuresListUl.appendChild(li);
    });
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
    
    let manifestVersion = "未知"; 
    fetch('manifest.json')
        .then(response => response.json())
        .then(manifest => {
            manifestVersion = manifest.version || "3.0.0"; 
            const versionLi = document.createElement('li');
            versionLi.classList.add('features-version-info');
            versionLi.innerHTML = `<strong>当前版本:</strong> ${manifestVersion}`;
            featuresListUl.appendChild(versionLi);
        })
        .catch(e => {
            console.warn("无法从 manifest.json 获取版本号，将使用默认值。错误:", e);
            manifestVersion = "3.0.0"; 
             const versionLi = document.createElement('li');
            versionLi.classList.add('features-version-info');
            versionLi.innerHTML = `<strong>当前版本:</strong> ${manifestVersion}`;
            featuresListUl.appendChild(versionLi);
        });
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

    // 【新增逻辑】如果删除的是一个有提醒的未来任务，通知SW
    if (type === 'future' && task.id && task.reminderTime && 'serviceWorker' in navigator) {
        navigator.serviceWorker.ready.then(registration => {
            if (registration.active) {
                registration.active.postMessage({ type: 'CANCEL_REMINDER' });
                console.log(`[App] 已向 SW 发送 CANCEL_REMINDER 消息，任务 ID ${task.id}`);
            }
        });
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

async function subscribeUserToPush() {
    // 1. 首先进行功能检测
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        console.warn("此浏览器不支持推送消息。");
        openCustomPrompt({title:"功能不支持", message:'您的浏览器不支持推送通知功能。', inputType:'none', hideCancelButton:true, confirmText:'好的'});
        return null;
    }
    
    try {
        const registration = await navigator.serviceWorker.ready;
        const existingSubscription = await registration.pushManager.getSubscription();

        if (existingSubscription) {
            console.log('用户已经订阅:', existingSubscription);
            await db.set('pushSubscription', existingSubscription.toJSON());
            return existingSubscription;
        }

        const vapidPublicKey = 'BOPBv2iLpTziiOOTjw8h2cT24-R_5c0s_q2ITf0JOTooBKiJBDl3bBROi4e_d_2dJd_quNBs2LrqEa2K_u_XGgY';
        const subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
        });
        
        console.log('新的订阅成功:', subscription);
        await db.set('pushSubscription', subscription.toJSON());
        // (可选) 在此将订阅信息发送到您的后端服务器
        return subscription;

    } catch (error) {
        console.error('用户订阅失败: ', error);
        await db.set('pushSubscription', null); // 确保失败时清除本地记录

        // ================== 【核心改进：智能错误提示】 ==================
        let title = "订阅失败";
        let message = `无法订阅推送通知，发生错误: ${error.name}.`;

        // 检测是否在 iOS 环境
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

        if (error.name === 'NotAllowedError') {
            title = "权限被拒绝";
            message = '您阻止了通知权限。请在浏览器的设置中为本站开启通知权限，然后重试。';
        } else if (isIOS) {
            title = "iOS 订阅提示";
            message = "在 iPhone/iPad 上，您需要先将本应用【添加到主屏幕】，然后从主屏幕打开它，才能成功开启通知功能。请确保您的系统版本为 iOS 16.4 或更高。";
        } else if (error.name === 'InvalidStateError') {
             message = '无法创建订阅，可能是由于浏览器处于隐私模式或 Service Worker 未完全激活。请刷新页面后重试。';
        }
        
        openCustomPrompt({title: title, message: message, inputType:'none', hideCancelButton:true, confirmText:'好的'});
        // =============================================================
        
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
function openCustomPrompt(config) {
    currentPromptConfig = config;
    if(customPromptModal && customPromptTitleEl && customPromptMessageEl && customPromptInputContainer && customPromptConfirmBtn && customPromptCancelBtn) {
        customPromptTitleEl.textContent = config.title || '提示';
        customPromptMessageEl.textContent = config.message || '';
        customPromptMessageEl.style.display = config.message ? 'block' : 'none';
        
        customPromptInputContainer.innerHTML = ''; 
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
            customPromptInputContainer.style.display = 'none';
        }

        if (config.htmlContent) {
            customPromptInputContainer.innerHTML = config.htmlContent;
            customPromptInputContainer.style.display = 'block';
        }

        customPromptConfirmBtn.textContent = config.confirmText || '确认';
        customPromptCancelBtn.textContent = config.cancelText || '取消';
        
        customPromptConfirmBtn.style.display = config.hideConfirmButton ? 'none' : 'inline-block';
        customPromptCancelBtn.style.display = config.hideCancelButton ? 'none' : 'inline-block';
        
        customPromptModal.classList.remove('hidden');
        
        if (typeof config.onRender === 'function') {
            config.onRender();
        }
    } else {
        console.error("Custom prompt modal elements not found.");
    }
}
function closeCustomPrompt() {
    if(customPromptModal) customPromptModal.classList.add('hidden');
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
                    links: task.links || [] 
                });
            });
            allTasks.future = remainingFutureTasks; // 更新 future 列表
            tasksWereMoved = true;
        }
    }
    if (tasksWereMoved) {
        saveTasks().then(renderAllLists);
    }
}

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
    

// 建议添加到 bindEventListeners 函数中
let syncTimeout = null;
const triggerSync = () => {
    // 使用防抖，避免短时间内（如快速切换窗口）重复触发
    clearTimeout(syncTimeout);
    syncTimeout = setTimeout(() => {
        const syncButton = document.getElementById('sync-drive-btn');
        if (syncButton && !syncButton.disabled) {
            console.log('Visibility change or focus detected, triggering auto-sync.');
            syncButton.click(); // 模拟点击同步按钮
        }
    }, 1000); // 延迟1秒触发
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
        if (autoSyncTimer) {
            clearTimeout(autoSyncTimer);
            autoSyncTimer = null;
        }

        console.log("同步按钮被点击。");
        syncStatusSpan.textContent = '初始化同步...';
        syncDriveBtn.disabled = true;
        let syncSucceeded = false;

        try {
            // 确保 API 客户端已加载
            if (!driveSync.tokenClient) {
                await loadGoogleApis();
                if (!driveSync.tokenClient) throw new Error('Google API 客户端未能成功初始化。');
            }

            // 定义核心同步操作，以便重试
            const performSyncOperations = async () => {
                // ... (这部分内部逻辑和您原来的一样，包括 findOrCreateFile, download, 数据合并/覆盖等)
                syncStatusSpan.textContent = '查找云文件...';
                await driveSync.findOrCreateFile();
                if (!driveSync.driveFileId) throw new Error('未能找到或创建云端文件。');

                syncStatusSpan.textContent = '下载云数据...';
                const cloudData = await driveSync.download();
                
                let localData = await db.get('allTasks');
                if (!localData || typeof localData !== 'object') {
                    localData = { daily: [], monthly: [], future: [], ledger: [], history: {}, ledgerHistory: {}, budgets: {}, currencySymbol: '$', lastUpdatedLocal: 0 };
                }
                
                const isFirstSyncCompleted = await db.get('isFirstSyncCompleted');
                
                if (isFirstSyncCompleted !== true && cloudData && Object.keys(cloudData).length > 0) {
                    syncStatusSpan.textContent = '首次同步，合并数据...';
                    const mergedData = { /* ... 您的合并逻辑 ... */ 
                        daily: [...(cloudData.daily || []), ...(localData.daily || [])],
                        monthly: [...(cloudData.monthly || []), ...(localData.monthly || [])],
                        future: [...(cloudData.future || []), ...(localData.future || [])],
                        ledger: [...(cloudData.ledger || []), ...(localData.ledger || [])],
                        history: { ...(cloudData.history || {}), ...(localData.history || {}) },
                        ledgerHistory: { ...(cloudData.ledgerHistory || {}), ...(localData.ledgerHistory || {}) },
                        budgets: { ...(cloudData.budgets || {}), ...(localData.budgets || {}) },
                        currencySymbol: localData.currencySymbol || cloudData.currencySymbol || '$',
                        lastUpdatedLocal: Date.now()
                    };
                    allTasks = mergedData;
                    await driveSync.upload(allTasks);
                    await db.set('allTasks', allTasks);
                    await db.set('isFirstSyncCompleted', true);
                    renderAllLists();
                    syncStatusSpan.textContent = '数据合并并同步成功！';
                } else {
                    if (cloudData && typeof cloudData === 'object' && cloudData.lastUpdatedLocal > (localData.lastUpdatedLocal || 0)) {
                        syncStatusSpan.textContent = '云端数据较新，正在同步...';
                        allTasks = cloudData;
                        await db.set('allTasks', allTasks);
                        renderAllLists();
                        syncStatusSpan.textContent = '已从云端同步！';
                    } else {
                        syncStatusSpan.textContent = '上传本地数据...';
                        allTasks = localData;
                        const uploadResult = await driveSync.upload(allTasks);
                        syncStatusSpan.textContent = uploadResult.message;
                    }
                    if (isFirstSyncCompleted !== true) {
                        await db.set('isFirstSyncCompleted', true);
                    }
                }
            };

            // 【新的、更简洁的重试逻辑】
            try {
                // 直接尝试执行。如果未授权，这里就会因为 API 调用失败而抛出 401 错误。
                await performSyncOperations();
            } catch (apiError) {
                // 只有在遇到 401 (未授权) 错误时才尝试重新授权
                if (apiError && (apiError.status === 401 || (apiError.result && apiError.result.error.code === 401))) {
                    console.warn("API 调用失败 (401)，需要授权。");
                    syncStatusSpan.textContent = '需要授权...';
                    
                    // 调用 authenticate。它会智能地决定是弹窗还是静默刷新。
                    await driveSync.authenticate();
                    
                    console.log("授权成功，正在重试同步操作...");
                    syncStatusSpan.textContent = '重试同步...';
                    await performSyncOperations(); // 再次执行核心操作
                } else {
                    // 如果是其他网络错误或API错误，直接抛出
                    throw apiError;
                }
            }

            syncSucceeded = true;
            isDataDirty = false;
            updateSyncIndicator();



        } catch (error) { // 捕获上面 try 块中发生的任何错误
            console.error("同步操作最终失败:", error);
            const errorMessage = error.message || '未知错误';
            syncStatusSpan.textContent = `同步错误: ${errorMessage.substring(0, 40)}...`;
            // ... (您现有的 openCustomPrompt 错误提示逻辑)
        } finally { // 无论成功或失败，都会执行这里
            syncDriveBtn.disabled = false;
            console.log("同步流程结束，按钮已重新启用。");

            // 4. 使用 syncSucceeded 标志位来判断最终状态
            if (syncSucceeded) {
                const now = new Date();
                const timeString = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                localStorage.setItem('lastSyncTime', timeString);
                
                // 只有在数据不是“脏”状态时，才显示最后同步时间
                if (!isDataDirty && syncStatusSpan) {
                    syncStatusSpan.textContent = `同步于 ${timeString}`;
                }
            }

            // 5. 在一段时间后，清空状态提示（除非有未同步的更改）
            setTimeout(() => {
                if (!isDataDirty && syncStatusSpan) {
                    syncStatusSpan.textContent = '';
                }
            }, 7000);
        }
    });
}



// 在 app.js 的 loadTasks 成功后，或 initializeApp 的末尾

async function initializeApp() {
    // ...
    try {
        await loadTasks();
        console.log("initializeApp: 任务已从 DB 加载。");
    } catch (e) {
        // ...
    }
    // ...
    renderAllLists();
    // ...
}




async function loadGoogleApis() {
    return new Promise((resolve, reject) => {
        const checkInterval = setInterval(() => {
            // 检查 GAPI 和新的 GIS 库是否都已加载
            if (window.gapi && window.google && window.google.accounts && window.google.accounts.oauth2) {
                clearInterval(checkInterval);
                console.log("loadGoogleApis: GAPI 和 GIS 库已加载。");
                
                // 统一将 gapi 和 gis 实例设置到 driveSync 模块上
                driveSync.gapi = window.gapi;
                driveSync.gis = window.google.accounts.oauth2; // 使用 'gis' 作为统一的属性名
                
                // 现在可以安全地初始化 driveSync 的内部客户端了
                driveSync.initClients()
                    .then(() => {
                        console.log("loadGoogleApis: driveSync 客户端初始化成功。");
                        resolve(); // 表示API已完全准备好
                    })
                    .catch(error => {
                        console.error("loadGoogleApis: 初始化 driveSync 客户端失败:", error);
                        if (typeof syncStatusSpan !== 'undefined' && syncStatusSpan) {
                             syncStatusSpan.textContent = 'Google服务初始化失败。';
                        }
                        reject(error);
                    });
            }
        }, 200);

        // 设置一个超时，以防脚本永远不加载
        setTimeout(() => {
            // 检查 driveSync 模块内的引用是否已设置
            if (!driveSync.gapi || !driveSync.gis) { 
                clearInterval(checkInterval);
                const errorMsg = "loadGoogleApis: 加载 Google API 脚本超时。";
                console.error(errorMsg);
                if (typeof syncStatusSpan !== 'undefined' && syncStatusSpan) {
                     syncStatusSpan.textContent = '加载Google服务超时。';
                }
                reject(new Error(errorMsg));
            }
        }, 15000); // 15秒超时
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

async function initializeApp() {
    console.log("initializeApp: 开始应用初始化。");
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
    
    console.log("initializeApp: 所有 DOM 元素已获取。");

    // 2. 绑定所有事件
    bindEventListeners(); 
    console.log("initializeApp: 事件监听器已绑定。");

    // 3. 加载非 DOM 相关的设置
    loadTheme();
    await loadNotificationSetting(); // loadNotificationSetting 内部会调用 updateNotificationButtonUI
    console.log("initializeApp: 主题和通知设置已加载。");

    try {
        console.log("initializeApp: 尝试加载 Google API...");
        await loadGoogleApis();
        console.log("initializeApp: Google API 已加载。");
    } catch (error) {
        console.error("initializeApp: 启动时加载 Google API 失败:", error);
        if (syncStatusSpan) syncStatusSpan.textContent = 'Google 服务加载失败。';
    }


// 5. 加载数据并检查过期任务
try {
    await loadTasks(); // 加载本地数据
    console.log("initializeApp: 任务已从 DB 加载。");

    // 【新逻辑】检查首次同步状态
    const firstSyncStatus = await db.get('isFirstSyncCompleted');
    if (firstSyncStatus !== true && syncStatusSpan) {
        syncStatusSpan.textContent = '请同步以合并数据';
        setTimeout(() => {
            if (syncStatusSpan.textContent === '请同步以合并数据') {
                syncStatusSpan.textContent = '';
            }
        }, 8000);
    }

} catch (e) {
        console.error("initializeApp: 初始任务加载时发生严重错误:", e);
        openCustomPrompt({title:"加载数据失败", message:"无法加载您的数据，请尝试刷新页面或清除应用数据。", inputType:'none', confirmText:'好的', hideCancelButton:true});
        return; // 阻止后续执行
    }
    
    checkAndMoveFutureTasks(); // 检查并移动到期的未来任务
    console.log("initializeApp: 到期的未来任务已检查并移动。");

    // 6. 初始渲染和设置
    renderAllLists(); // 初始渲染所有列表
    initSortable(); // 初始化拖拽排序
    console.log("initializeApp: 所有列表已渲染且拖拽功能已初始化。");

    if (ledgerDateInput) { // 设置记账本默认日期为今天
        ledgerDateInput.valueAsDate = new Date();
    }

    // 7. 设置初始视图
    switchView('daily-section'); // 默认显示每日清单
    console.log("initializeApp: 初始视图已切换到每日清单。");

    console.log("initializeApp: 应用初始化完成。");
}

// 最终的启动入口
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    initializeApp();
}

// Service Worker 更新逻辑 (保持不变)
// ... (你现有的 Service Worker 更新逻辑) ...
let newWorker;
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.ready.then(reg => {
        if (!reg) return;
        reg.addEventListener('updatefound', () => {
            newWorker = reg.installing;
            if (!newWorker) return;
            newWorker.addEventListener('statechange', () => {
                if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    openCustomPrompt({
                        title: "应用更新",
                        message: "新版本已准备就绪，刷新以应用更新吗？",
                        confirmText: "刷新",
                        cancelText: "稍后",
                        onConfirm: () => {
                            newWorker.postMessage({ action: 'skipWaiting' });
                        },
                        onCancel: () => console.log("User chose to update later.")
                    });
                }
            });
        });
    }).catch(error => console.error("Error getting SW registration for update check:", error));

    navigator.serviceWorker.getRegistration().then(reg => {
        if (reg && reg.waiting) {
            newWorker = reg.waiting;
             openCustomPrompt({
                title: "应用更新",
                message: "检测到应用有更新，刷新以应用最新版本吗？",
                confirmText: "刷新",
                cancelText: "稍后",
                onConfirm: () => {
                    newWorker.postMessage({ action: 'skipWaiting' });
                },
                onCancel: () => console.log("User chose to update later (on load).")
            });
        }
    }).catch(error => console.error("Error getting SW registration for waiting check:", error));

    let refreshing;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        console.log("Controller changed, reloading page.");
        window.location.reload();
        refreshing = true;
    });
}
