// sw.js

// ========================================================================
// 0. IndexedDB 帮助库
// ========================================================================
function promisifyRequest(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = (event) => reject(event.target.error || 'IndexedDB a_request_error');
    });
}

function createStore(dbName, storeName) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onerror = (event) => reject('无法打开数据库: ' + dbName);
        request.onsuccess = (event) => resolve(event.target.result);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains(storeName)) {
                db.createObjectStore(storeName);
            }
        };
    });
}

// 主数据存储
const mainDb = {
    get: async (key) => {
        const db = await createStore('EfficienTodoDB', 'data');
        const tx = db.transaction('data', 'readonly');
        const store = tx.objectStore('data');
        const result = await promisifyRequest(store.get(key));
        db.close();
        return result;
    }
};

// 备份数据存储
const backupDb = {
    get: async (key) => {
        const db = await createStore('EfficienTodo_Backups', 'versions');
        const tx = db.transaction('versions', 'readonly');
        const store = tx.objectStore('versions');
        const result = await promisifyRequest(store.get(key));
        db.close();
        return result;
    },
    set: async (key, value) => {
        const db = await createStore('EfficienTodo_Backups', 'versions');
        const tx = db.transaction('versions', 'readwrite');
        const store = tx.objectStore('versions');
        await promisifyRequest(store.put(value, key));
        db.close();
    },
    delete: async (key) => {
        const db = await createStore('EfficienTodo_Backups', 'versions');
        const tx = db.transaction('versions', 'readwrite');
        const store = tx.objectStore('versions');
        await promisifyRequest(store.delete(key));
        db.close();
    },
    getAllKeys: async () => {
        const db = await createStore('EfficienTodo_Backups', 'versions');
        const tx = db.transaction('versions', 'readonly');
        const store = tx.objectStore('versions');
        const keys = await promisifyRequest(store.getAllKeys());
        db.close();
        return keys;
    }
};

// ========================================================================
// 1. Service Worker 生命周期事件
// ========================================================================
const CACHE_NAME = 'todo-list-cache-v10'; // 【MODIFIED】缓存版本号更新
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
  self.skipWaiting(); // 强制新的 Service Worker 立即激活
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('[SW] Cache opened. Caching app shell and vendor files...');
      
      const urlsToCache = [...APP_SHELL_URLS, ...VENDOR_URLS].filter(
        url => !url.startsWith('chrome-extension://') && (url.startsWith('http') || url.startsWith('/'))
      );
      
      console.log('[SW] URLs to cache:', urlsToCache);
      if (urlsToCache.length > 0) {
        return cache.addAll(urlsToCache) // addAll 是原子操作，要么全部成功，要么全部失败
          .then(() => console.log('[SW] All specified HTTP/HTTPS files cached successfully.'))
          .catch(err => {
            console.error("[SW] Failed to cache one or more files during install:", err);
            // 即使部分文件缓存失败，也可能希望 SW 安装成功，以便核心功能可用
            // 但如果关键文件失败，这可能导致问题。addAll 的原子性有助于此。
          });
      } else {
        console.log('[SW] No HTTP/HTTPS URLs to cache in install event.');
        return Promise.resolve();
      }
    }).catch(err => console.error("[SW] Failed to open cache during install:", err))
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

  // 对于 chrome-extension:// 协议的请求，直接通过网络获取 (实际上是本地加载)
  if (requestUrl.protocol === 'chrome-extension:') {
    event.respondWith(fetch(event.request));
    return;
  }
  
  // 缓存策略:
  // 1. 应用核心资源 (APP_SHELL_URLS) 和明确指定的第三方库 (VENDOR_URLS): Stale-While-Revalidate
  // 2. Google API 调用 (googleapis.com, accounts.google.com GSI): Network first, then cache (如果成功)
  //    因为这些API的响应可能经常变化或包含敏感信息，不适合长时间缓存。
  //    但为了离线时应用能基本加载（即使同步失败），可以缓存加载器本身。
  // 3. 其他所有请求: Network first

  const isAppOrVendorAsset = [...APP_SHELL_URLS, ...VENDOR_URLS].some(
      assetUrl => requestUrl.pathname === assetUrl || requestUrl.href === assetUrl
  );

  // Stale-While-Revalidate for app assets and explicitly listed vendor assets
  if (isAppOrVendorAsset || (requestUrl.origin === self.location.origin && !requestUrl.pathname.includes('/drive/v3/'))) { // 应用自身资源
    event.respondWith(
      caches.open(CACHE_NAME).then(cache => {
        return cache.match(event.request).then(cachedResponse => {
          const fetchPromise = fetch(event.request).then(networkResponse => {
            // 检查响应是否有效以及是否是我们要缓存的类型
            // 对于 basic 类型（同源）或明确在 VENDOR_URLS 中的 CDN 资源
            if (networkResponse && networkResponse.status === 200 && 
                (networkResponse.type === 'basic' || VENDOR_URLS.includes(event.request.url))) {
              cache.put(event.request, networkResponse.clone());
            } else if (networkResponse && networkResponse.status !== 200) {
              // console.warn('[SW] Network response not OK, not caching:', event.request.url, networkResponse.status);
            }
            return networkResponse;
          }).catch(fetchError => {
            // console.error('[SW] Fetch failed for (SWR):', event.request.url, fetchError);
            // 如果网络请求失败且有缓存，则已返回缓存
            throw fetchError; 
          });
          return cachedResponse || fetchPromise; // 优先返回缓存，后台更新
        }).catch(matchError => {
          // console.warn('[SW] Cache match failed or network fetch failed for (SWR):', event.request.url, matchError);
          // 对于导航请求，如果缓存和网络都失败，尝试返回 index.html
          if (event.request.mode === 'navigate') {
            console.log('[SW] Navigate request failed, trying offline page (index.html).');
            return caches.match('/index.html'); // 确保 index.html 已被可靠缓存
          }
          // 对于其他类型的请求，让错误传播
        });
      })
    );
  } else if (requestUrl.hostname.includes('googleapis.com') || requestUrl.hostname.includes('accounts.google.com')) {
    // Network first, then cache for Google API calls (but not Drive data uploads/downloads necessarily)
    // This is mainly for the discovery docs or auth tokens that might be fetched.
    // Drive file content itself is handled by app logic and not directly via SW fetch interception for caching.
    event.respondWith(
        fetch(event.request)
            .then(networkResponse => {
                if (networkResponse && networkResponse.status === 200 && event.request.method === 'GET') { // 只缓存GET请求
                    // 谨慎缓存 Google API 响应，它们可能包含敏感数据或快速过期
                    // 这里可以决定是否缓存特定的 Google API 路径
                    // 例如，只缓存 discovery docs: if (requestUrl.pathname.includes('/discovery/v1/apis/'))
                    // caches.open(CACHE_NAME).then(cache => {
                    //    cache.put(event.request, networkResponse.clone());
                    // });
                }
                return networkResponse;
            })
            .catch(error => {
                // console.warn('[SW] Network request failed for Google API:', event.request.url, error);
                // 尝试从缓存中获取 (如果之前有缓存过，例如 discovery docs)
                // return caches.match(event.request);
                // 或者直接让它失败，因为API调用失败通常意味着功能不可用
            })
    );
  } else {
    // For all other requests (e.g., external APIs not in VENDOR_URLS), go network first
    event.respondWith(
        fetch(event.request).catch(() => {
            // console.warn('[SW] Network request failed for non-cached asset:', event.request.url);
            // 可以返回一个通用的离线响应或让它失败
        })
    );
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

const BACKUP_DB_NAME = 'EfficienTodo_Backups';
const VERSION_STORE_NAME = 'versions';
const MAX_BACKUPS = 14;

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
