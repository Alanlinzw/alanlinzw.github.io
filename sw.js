// sw.js

// ========================================================================
// 0. IndexedDB 帮助库 (已修复版本号问题)
// ========================================================================

// --- START OF FIX ---
// 定义与 app.js 同步的数据库版本号
const MAIN_DB_NAME = 'EfficienTodoDB';
const MAIN_DB_STORE = 'data';
const MAIN_DB_VERSION = 3; // 关键：与 app.js 中的 DB_VERSION 保持一致

const BACKUP_DB_NAME = 'EfficienTodo_Backups';
const BACKUP_DB_STORE = 'versions';
const BACKUP_DB_VERSION = 1; // 备份数据库版本号，通常保持为 1 即可
// --- END OF FIX ---
const VERSION_STORE_NAME = 'versions';
const MAX_BACKUPS = 14;

function promisifyRequest(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = (event) => reject(event.target.error || 'IndexedDB a_request_error');
    });
}

// --- START OF FIX ---
// 修改函数签名，增加 version 参数
function createStore(dbName, storeName, version, retries = 3, delay = 100) {
// --- END OF FIX ---
    return new Promise((resolve, reject) => {
        const attemptOpen = (currentAttempt) => {
            // --- START OF FIX ---
            // 使用传入的 version 参数，而不是硬编码的 1
            const request = indexedDB.open(dbName, version);
            // --- END OF FIX ---

            request.onerror = (event) => {
                console.error(`[SW-DB] 打开数据库 '${dbName}' 失败 (尝试 ${currentAttempt}):`, event.target.error);
                if (currentAttempt < retries) {
                    console.log(`[SW-DB] 将在 ${delay}ms 后重试...`);
                    setTimeout(() => attemptOpen(currentAttempt + 1), delay);
                } else {
                    reject(`无法打开数据库: ${dbName}，已达到最大重试次数。`);
                }
            };

            request.onsuccess = (event) => {
                console.log(`[SW-DB] 成功打开数据库 '${dbName}' (尝试 ${currentAttempt})`);
                resolve(event.target.result);
            };

            request.onupgradeneeded = (event) => {
                console.log(`[SW-DB] onupgradeneeded for '${dbName}'`);
                const db = event.target.result;
                if (!db.objectStoreNames.contains(storeName)) {
                    db.createObjectStore(storeName);
                }
            };
            
            request.onblocked = (event) => {
                console.warn(`[SW-DB] 打开数据库 '${dbName}' 被阻塞 (尝试 ${currentAttempt}). 这通常意味着其他页面持有未关闭的连接。`);
                 if (currentAttempt < retries) {
                    console.log(`[SW-DB] 将在 ${delay * 2}ms 后重试 (因为被阻塞)...`);
                    setTimeout(() => attemptOpen(currentAttempt + 1), delay * 2);
                } else {
                    reject(`无法打开数据库: ${dbName}，因为连接持续被阻塞。`);
                }
            };
        };

        attemptOpen(1);
    });
}

// 主数据存储
const mainDb = {
    get: async (key) => {
        // --- START OF FIX ---
        // 传递正确的数据库名称、存储名称和版本号
        const db = await createStore(MAIN_DB_NAME, MAIN_DB_STORE, MAIN_DB_VERSION);
        // --- END OF FIX ---
        const tx = db.transaction(MAIN_DB_STORE, 'readonly');
        const store = tx.objectStore(MAIN_DB_STORE);
        const result = await promisifyRequest(store.get(key));
        db.close();
        return result;
    }
};

// 备份数据存储
const backupDb = {
    get: async (key) => {
        // --- START OF FIX ---
        // 传递正确的数据库名称、存储名称和版本号
        const db = await createStore(BACKUP_DB_NAME, BACKUP_DB_STORE, BACKUP_DB_VERSION);
        // --- END OF FIX ---
        const tx = db.transaction(BACKUP_DB_STORE, 'readonly');
        const store = tx.objectStore(BACKUP_DB_STORE);
        const result = await promisifyRequest(store.get(key));
        db.close();
        return result;
    },
    set: async (key, value) => {
        const db = await createStore(BACKUP_DB_NAME, BACKUP_DB_STORE, BACKUP_DB_VERSION);
        const tx = db.transaction(BACKUP_DB_STORE, 'readwrite');
        const store = tx.objectStore(BACKUP_DB_STORE);
        await promisifyRequest(store.put(value, key));
        db.close();
    },
    delete: async (key) => {
        const db = await createStore(BACKUP_DB_NAME, BACKUP_DB_STORE, BACKUP_DB_VERSION);
        const tx = db.transaction(BACKUP_DB_STORE, 'readwrite');
        const store = tx.objectStore(BACKUP_DB_STORE);
        await promisifyRequest(store.delete(key));
        db.close();
    },
    getAllKeys: async () => {
        const db = await createStore(BACKUP_DB_NAME, BACKUP_DB_STORE, BACKUP_DB_VERSION);
        const tx = db.transaction(BACKUP_DB_STORE, 'readonly');
        const store = tx.objectStore(BACKUP_DB_STORE);
        const keys = await promisifyRequest(store.getAllKeys());
        db.close();
        return keys;
    }
};

// ========================================================================
// 1. Service Worker 生命周期事件
// ========================================================================
const CACHE_NAME = 'todo-list-cache-v12'; // 【MODIFIED】缓存版本号更新
// 应用外壳通常是相对路径
const APP_SHELL_URLS = [
  '/', 
  '/index.html', 
  '/favicon.ico',
  '/style.css', 
  '/app.js',
  '/stats.js', // 【MODIFIED】添加 stats.js 到缓存列表
  '/manifest.json',
  '/images/icons/icon-192x192.png', 
  '/images/icons/icon-512x512.png',
  '/images/icon-notifications-on.svg', 
  '/images/icon-notifications-off.svg',
  '/images/icon-notifications-issue.svg', // 【NEW】新增通知状态图标
  '/images/icon-notifications-blocked.svg', // 【NEW】新增通知状态图标
  '/images/icon-refresh.svg',
  '/images/icon-drive.svg',
  '/images/icon-stats.svg',
  '/images/icon-faq.svg',
  '/images/icon-features.svg',
  '/images/icon-theme.svg',
  '/images/icon-feedback.svg',
  '/images/icon-donate.svg',
  '/images/icon-search.svg',
  '/images/icon-daily.svg',
  '/images/icon-monthly.svg',
  '/images/icon-future.svg',
  '/images/icon-ledger.svg',
  '/images/icon-sort-priority.svg',
  '/images/icon-history.svg',
  '/images/icon-back.svg',
  '/images/icon-currency.svg',
  '/images/icon-link.svg',
  '/images/icon-add-link.svg',
  '/images/icon-celebrate.svg',
  '/images/icon-backup.svg',
];
// 第三方库 CDN URL
const VENDOR_URLS = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js',
  'https://apis.google.com/js/api.js', // 【NEW】缓存 Google API 加载器
  'https://accounts.google.com/gsi/client', // 【NEW】缓存 Google Identity Services 加载器
  '/xlsx.full.min.js', 
  '/Sortable.min.js'
];

self.addEventListener('install', event => {
  console.log('[SW] Install event');
  self.skipWaiting(); 
  event.waitUntil(
    (async () => {
        try {
            const cache = await caches.open(CACHE_NAME);
            console.log('[SW] Cache opened. Caching app shell and vendor files...');
            
            const urlsToCache = [...APP_SHELL_URLS, ...VENDOR_URLS].filter(
                url => !url.startsWith('chrome-extension://') && (url.startsWith('http') || url.startsWith('/'))
            );

            console.log('[SW] URLs to cache:', urlsToCache);

            // 【核心修复】使用 for...of 循环和独立的 add 请求，而不是 addAll
            for (const url of urlsToCache) {
                try {
                    await cache.add(url);
                } catch (err) {
                    // 如果某个特定文件缓存失败，只打印警告，不中断整个安装过程
                    console.warn(`[SW] Failed to cache individual file: ${url}`, err);
                }
            }
            
            console.log('[SW] Caching process completed.');
        } catch (err) {
            console.error("[SW] Major error during install event:", err);
        }
    })()
  );
});

self.addEventListener('activate', event => {
    console.log('[SW] Activate event');
    event.waitUntil(
        (async () => {
            const cacheWhitelist = [CACHE_NAME];
            const cacheNames = await caches.keys();
            await Promise.all(
                cacheNames.map(cacheName => {
                    if (!cacheWhitelist.includes(cacheName)) {
                        console.log('[SW] Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
            console.log('[SW] Old caches deleted.');
            
            // 立即控制客户端，并同时触发一次备份检查
            // Promise.all 确保两件事都完成后，waitUntil 才结束
            await Promise.all([
                self.clients.claim(),
                handleAutoBackup()
            ]);
            console.log('[SW] Clients claimed and initial backup check on activation complete.');
        })()
    );
});
self.addEventListener('fetch', event => {
  const requestUrl = new URL(event.request.url);

  // 对于 chrome-extension:// 协议的请求，直接通过网络获取
  if (requestUrl.protocol === 'chrome-extension:') {
    return; // 让浏览器自己处理
  }
  
  // 判断是否是应用核心资源 (HTML, JS)
  const isAppShellPage = requestUrl.origin === self.location.origin && 
                         (event.request.mode === 'navigate' || requestUrl.pathname.endsWith('.js'));
  
  // 判断是否是其他已知的静态资源 (CSS, images, etc.)
  const isStaticAsset = APP_SHELL_URLS.some(
      assetUrl => requestUrl.pathname.endsWith(assetUrl)
  ) && !isAppShellPage;

   // 策略 1: 【核心修复】对于应用核心 HTML 和 JS，使用 Network First
  if (isAppShellPage) {
    event.respondWith(
      (async () => {
        try {
          const networkResponse = await fetch(event.request);
          
          // 检查网络响应是否有效
          if (networkResponse && networkResponse.status === 200) {
            // --- START OF FIX ---
            // 关键：在这里立即克隆响应。一个用于缓存，一个用于返回给浏览器。
            const responseToCache = networkResponse.clone();
            
            // 异步地将克隆的响应放入缓存，不阻塞主流程
            caches.open(CACHE_NAME).then(cache => {
                cache.put(event.request, responseToCache);
            });
            
            // 返回原始的响应给浏览器
            return networkResponse;
            // --- END OF FIX ---
          }
          
          // 如果网络请求失败或返回错误状态码，尝试从缓存中获取
          console.log(`[SW] Network request failed or returned status ${networkResponse.status}. Trying cache for ${event.request.url}`);
          const cachedResponse = await caches.match(event.request);
          if (cachedResponse) {
            return cachedResponse;
          }
          // 如果缓存也没有，则返回网络错误响应（或者一个自定义的离线页面）
          return networkResponse;

        } catch (error) {
          // 网络完全断开，从缓存中获取
          console.log(`[SW] Network fetch failed for ${event.request.url}, falling back to cache.`, error);
          const cachedResponse = await caches.match(event.request);
          // 如果缓存中有，则返回缓存的响应
          if (cachedResponse) {
            return cachedResponse;
          }
          // 如果连缓存都没有，则无法提供服务（浏览器会显示默认的离线错误）
          // 可以在这里返回一个自定义的离线页面 Response.error() 或 new Response(...)
          return new Response("Network error and no cache available.", {
            status: 408,
            statusText: "Request Timeout",
            headers: { 'Content-Type': 'text/plain' },
          });
        }
      })()
    );
  }
  // 策略 2: 对于图片、CSS等其他静态资源，Stale-While-Revalidate
  else if (isStaticAsset) {
      // 这里的逻辑是正确的，不需要修改
      event.respondWith(
        caches.open(CACHE_NAME).then(cache => {
          return cache.match(event.request).then(cachedResponse => {
            const fetchPromise = fetch(event.request).then(networkResponse => {
              if (networkResponse && networkResponse.status === 200) {
                // 这里也是先克隆再操作，是正确的
                cache.put(event.request, networkResponse.clone());
              }
              return networkResponse;
            });
            // 优先返回缓存，后台更新
            return cachedResponse || fetchPromise;
          });
        })
      );
  }
  // 策略 3: 对于其他请求，直接走网络
  else {
      // 保持默认行为
  }
});

// ========================================================================
// 2. 新增：Periodic Background Sync (如果浏览器支持)
// ========================================================================
self.addEventListener('periodicsync', event => {
    if (event.tag === 'daily-todo-backup') {
        console.log('[SW] Periodic Sync triggered for "daily-todo-backup".');
        event.waitUntil(handleAutoBackup());
    }
});

// 在 app.js 中，需要有逻辑来注册这个 periodic sync
// if ('serviceWorker' in navigator && 'PeriodicSyncManager' in window) {
//     navigator.serviceWorker.ready.then(async (registration) => {
//         try {
//             await registration.periodicSync.register('daily-todo-backup', {
//                 minInterval: 24 * 60 * 60 * 1000, // 24 hours
//             });
//             console.log('Periodic sync for daily backup registered.');
//         } catch (e) {
//             console.error('Periodic sync could not be registered!', e);
//         }
//     });
// }


// ========================================================================
// 2. 监听来自主应用的消息来安排提醒
// ========================================================================
self.addEventListener('message', event => {
    if (!event.data) return;

    const { action, type, payload, timestamp } = event.data;
    const messageType = action || type;
    const port = event.ports[0];

    switch (messageType) {
case 'triggerAutoBackup':
            console.log('[SW] Received request to trigger auto backup from client.');
            event.waitUntil(handleAutoBackup());
            break;
        case 'getBackupVersions':
            (async () => {
                try {
                    // 【修复】使用新的 backupDb 辅助库
                    const keys = await backupDb.getAllKeys();
                    // 在这里排序，确保发送到前端的是有序的
                    if (port) port.postMessage({ success: true, versions: keys.sort((a, b) => b - a) });
                } catch (error) {
                    if (port) port.postMessage({ success: false, message: error.message });
                }
            })();
            break;

        case 'restoreFromBackup':
            (async () => {
                try {
                    // 【修复】使用新的 backupDb 辅助库
                    const restoredData = await backupDb.get(timestamp);
                    if (restoredData) {
                        // 【修改】将恢复的数据发送回前端，由前端处理保存和UI更新
                        if (port) port.postMessage({ success: true, data: restoredData });
                    } else {
                        throw new Error('找不到指定的备份版本。');
                    }
                } catch (error) {
                    if (port) port.postMessage({ success: false, message: error.message });
                }
            })();
            break;
            
        case 'SCHEDULE_REMINDER':
            if (payload?.task?.id && payload?.task?.reminderTime) {
                const { task } = payload;
                const delay = new Date(task.reminderTime).getTime() - Date.now();
                if (delay > 0) {
                    setTimeout(() => checkAndShowNotifications(), delay);
                }
            }
            break;

        case 'skipWaiting':
            self.skipWaiting();
            break;
            
        default:
            // 其他如 UPDATE_REMINDER, CANCEL_REMINDER 等消息可以忽略或只打印日志
            // console.warn('[SW] Received unhandled message:', event.data);
            break;
    }
});

// sw.js




async function handleAutoBackup() {
    console.log('[SW-Backup] 开始执行每日自动备份...');
    try {
        // 【修复】使用正确的 key 'allTasks' 从主数据库获取数据
        const tasks = await mainDb.get('allTasks');
        if (!tasks || (!tasks.daily?.length && !tasks.monthly?.length)) {
            console.log('[SW-Backup] 主数据为空，跳过本次备份。');
            return;
        }
        const timestamp = Date.now();
        // 使用新的 backupDb 辅助库进行设置
        await backupDb.set(timestamp, tasks);
        console.log(`[SW-Backup] 成功创建新的备份快照: ${new Date(timestamp).toLocaleString()}`);
        
        // 【完成】实现清理旧备份的逻辑
        const allKeys = await backupDb.getAllKeys();
        if (allKeys.length > MAX_BACKUPS) {
            allKeys.sort((a, b) => a - b); // 排序，最旧的在前
            const keysToDelete = allKeys.slice(0, allKeys.length - MAX_BACKUPS);
            for (const key of keysToDelete) {
                await backupDb.delete(key);
                console.log(`[SW-Backup] 已删除旧的备份快照: ${new Date(key).toLocaleString()}`);
            }
        }
    } catch (error) {
        console.error('[SW-Backup] 自动备份过程中发生错误:', error);
    }
}

// ========================================================================
// 3. 核心：本地通知检查与显示逻辑 (重构)
// ========================================================================

async function checkAndShowNotifications() {
    try {
        const allTasksData = await mainDb.get('allTasks');
        if (!allTasksData?.future?.length) return;
        
        const allTasks = JSON.parse(JSON.stringify(allTasksData)); 
        const now = Date.now();
        const dueTasks = [];
        const remainingFutureTasks = [];
        let dbChanged = false;

        allTasks.future.forEach(task => {
            if (task.reminderTime && task.reminderTime <= now) {
                dueTasks.push(task);
                dbChanged = true;
            } else {
                remainingFutureTasks.push(task);
            }
        });
        
        if (dbChanged) {
            allTasks.future = remainingFutureTasks;

            for (const task of dueTasks) {
                if (self.registration?.showNotification) {
                    await self.registration.showNotification('高效待办清单提醒', {
                        body: task.text,
                        icon: '/images/icons/icon-192x192.png',
                        tag: task.id,
                        data: { url: self.registration.scope + '#future-section', taskId: task.id }
                    });
                }
                
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
                }
            }
            
            allTasks.lastUpdatedLocal = Date.now();
            const mainDbWrite = await createStore('EfficienTodoDB', 'data');
            const tx = mainDbWrite.transaction('data', 'readwrite');
            await promisifyRequest(tx.objectStore('data').put(allTasks, 'allTasks'));
            mainDbWrite.close();
            console.log('[SW] 到期任务处理完毕，主数据已更新。');
        }
    } catch (error) {
        console.error("[SW] 检查或显示通知时出错:", error);
    }
}
// ========================================================================
// 4. 通知点击事件处理
// ========================================================================
self.addEventListener('notificationclick', event => {
    console.log('[SW] Notification click Received.', event.notification);
    event.notification.close(); // 关闭通知

    const notificationData = event.notification.data;
    // 优先使用通知数据中指定的 URL，否则回退到 SW scope (通常是应用首页)
    const urlToOpen = (notificationData && notificationData.url) ? notificationData.url : self.registration.scope;

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
            // 检查是否已有该 URL 的窗口打开
            for (const client of clientList) {
                // 如果一个窗口已经打开到应用的根作用域，则尝试导航到具体URL并聚焦
                if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
                    console.log('[SW] Focusing existing client and navigating to:', urlToOpen);
                    client.navigate(urlToOpen); // 【MODIFIED】确保导航到包含哈希的URL
                    return client.focus();
                }
            }
            // 如果没有，则打开新窗口
            if (clients.openWindow) {
                console.log('[SW] Opening new window for:', urlToOpen);
                return clients.openWindow(urlToOpen);
            }
        }).catch(err => console.error("[SW] Error handling notification click:", err))
    );
});

// ========================================================================
// 5. 推送事件处理 (用于接收来自服务器的推送消息 - 如果将来实现的话)
// ========================================================================
self.addEventListener('push', event => {
    console.log('[SW] Push Received.');
    let title = '高效待办清单';
    let options = {
        body: '你有一条新消息!',
        icon: '/images/icons/icon-192x192.png',
        badge: '/images/icons/icon-192x192.png',
        data: { url: self.registration.scope } // 默认点击打开首页
    };

    if (event.data) {
        try {
            const data = event.data.json(); // 假设服务器发送 JSON 数据
            title = data.title || title;
            options.body = data.body || options.body;
            options.icon = data.icon || options.icon;
            options.badge = data.badge || options.badge;
            if (data.url) options.data.url = data.url; // 服务器可以指定打开的URL
            if (data.tag) options.tag = data.tag;
            console.log('[SW] Push data:', data);
        } catch (e) {
            console.log('[SW] Push event data is not JSON, using text:', event.data.text());
            options.body = event.data.text();
        }
    }

    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});
