// ========================================================================
// 0. IndexedDB 帮助库 (简化 - PWA 中我们只操作一个 key-value store)
// ========================================================================
function promisifyRequest(request) {
    return new Promise((resolve, reject) => {
        // 对于 IDBRequest，onsuccess 和 onerror 是主要事件
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        // oncomplete 和 onabort 是 IDBTransaction 的事件，不直接用于 IDBRequest promise 封装
    });
}

function createStore(dbName, storeName) {
    const request = indexedDB.open(dbName, 3); // 版本号与 app.js 中保持一致
    request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(storeName)) {
            db.createObjectStore(storeName);
        }
    };
    const dbp = promisifyRequest(request);
    return (txMode, callback) => dbp.then((db) => {
        const transaction = db.transaction(storeName, txMode);
        const store = transaction.objectStore(storeName);
        return callback(store, transaction); // 将事务也传递给回调，以便在回调中完成事务
    }).catch(err => {
        console.error("IndexedDB store operation failed:", err);
        throw err; // 重新抛出错误，以便调用者可以捕获
    });
}

const dbStore = createStore('EfficienTodoDB', 'data'); 

const db = {
    get(key) {
        return dbStore('readonly', (store) => promisifyRequest(store.get(key)));
    },
    set(key, value) {
        // 确保事务在 put 完成后才结束
        return dbStore('readwrite', (store, transaction) => {
            const req = store.put(value, key);
            return new Promise((resolve, reject) => {
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
                transaction.oncomplete = () => resolve(req.result); // 确保事务完成后再 resolve
                transaction.onerror = () => reject(transaction.error);
                transaction.onabort = () => reject(transaction.error);
            });
        });
    },
};

// ========================================================================
// 1. Service Worker 生命周期事件
// ========================================================================
const CACHE_NAME = 'todo-list-cache-v8'; // 【MODIFIED】缓存版本号更新
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
    const cacheWhitelist = [CACHE_NAME]; // 只保留当前版本的缓存
    event.waitUntil(
        caches.keys().then(cacheNames => Promise.all(
            cacheNames.map(cacheName => {
                if (!cacheWhitelist.includes(cacheName)) {
                    console.log('[SW] Deleting old cache:', cacheName);
                    return caches.delete(cacheName);
                }
            })
        )).then(() => {
            console.log('[SW] Old caches deleted, claiming clients.');
            checkAndShowNotifications(); 
            return self.clients.claim(); 
 .then(() => {
            console.log('[SW] Activate: Claiming clients and running initial backup check.');
            // 在激活时立即检查一次是否需要备份
            handleAutoBackup();
            return self.clients.claim();
        })
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
self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'daily-todo-backup') {
        console.log('[SW] Periodic Sync triggered for daily-todo-backup.');
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
    if (event.data && event.data.type === 'SCHEDULE_REMINDER') {
        const { task } = event.data.payload;
        if (!task || !task.reminderTime || !task.id) {
            console.error('[SW] Invalid task data for reminder:', task);
            return;
        }
        console.log('[SW] Received SCHEDULE_REMINDER for task:', task.id, new Date(task.reminderTime));
        const delay = new Date(task.reminderTime).getTime() - Date.now();
        if (delay > 0) {
            console.log(`[SW] Scheduling notification check in ${delay}ms for task ${task.id}`);
            // 注意: setTimeout 在 Service Worker 中可能因 SW 休眠而不可靠。
            // 真实生产环境应结合 Push API 或 Periodic Background Sync API。
            // 此处为简化，依赖于 SW 在需要时被激活（例如通过 fetch, push, sync 事件）。
            // 或者客户端在应用启动时触发检查。
            setTimeout(() => {
                console.log(`[SW] Timeout reached for task ${task.id}. Checking notifications.`);
                checkAndShowNotifications();
            }, delay);
        } else if (task.reminderTime && task.reminderTime <= Date.now()) {
            // 如果任务已经是过去的，立即检查（可能是在应用启动时补发）
            console.log('[SW] Task reminder time is in the past, checking notifications now for task:', task.id);
            checkAndShowNotifications();
        }
    } else if (event.data && event.data.action === 'skipWaiting') {
        self.skipWaiting();
    } else if (event.data && event.data.type === 'UPDATE_REMINDER') { // 【NEW】处理提醒更新
        // 简单处理：当 SW 下次检查通知时，会使用更新后的任务信息。
        // 更复杂的实现会取消旧的 setTimeout (如果用 task.id 作为 key 存储 timeoutId) 并设置新的。
        console.log('[SW] Received UPDATE_REMINDER for task ID:', event.data.payload.task.id, '. Reminder will be based on updated data during next check.');
    } else if (event.data && event.data.type === 'CANCEL_REMINDER') { // 【NEW】处理提醒取消
        // 简单处理：如果任务从 allTasks.future 中被删除或其 reminderTime 被清除，
        // checkAndShowNotifications 自然不会为它发送通知。
        // 更复杂的实现会清除特定的 setTimeout。
        console.log('[SW] Received CANCEL_REMINDER for task ID:', event.data.payload.taskId, '. Notification (if pending via setTimeout) may still fire unless task data is updated/removed.');
    }
     if (event.data && event.data.action === 'getBackupVersions') {
        (async () => {
            try {
                const dbHandle = await openBackupDB();
                const tx = dbHandle.transaction(VERSION_STORE_NAME, 'readonly');
                const store = tx.objectStore(VERSION_STORE_NAME);
                const keys = await promisifyRequest(store.getAllKeys());
                dbHandle.close();
                event.source.postMessage({ type: 'backupVersionsResponse', success: true, versions: keys.sort((a, b) => b - a) });
            } catch (error) {
                event.source.postMessage({ type: 'backupVersionsResponse', success: false, message: error.message });
            }
        })();
    }

    if (event.data && event.data.action === 'restoreFromBackup') {
        (async () => {
            try {
                const dbHandle = await openBackupDB();
                const tx = dbHandle.transaction(VERSION_STORE_NAME, 'readonly');
                const store = tx.objectStore(VERSION_STORE_NAME);
                const restoredData = await promisifyRequest(store.get(event.data.timestamp));
                dbHandle.close();
                
                if (restoredData) {
                    // **关键**: 在这里，我们不直接修改本地存储。
                    // 我们把数据发回给 app.js，由它来完成最后的写入和UI刷新。
                    event.source.postMessage({ type: 'restoreDataResponse', success: true, data: restoredData });
                } else {
                    throw new Error('找不到指定的备份版本。');
                }
            } catch (error) {
                event.source.postMessage({ type: 'restoreDataResponse', success: false, message: error.message });
            }
        })();
    }
});

const BACKUP_DB_NAME = 'EfficienTodo_Backups';
const VERSION_STORE_NAME = 'versions';
const MAX_BACKUPS = 14;

async function handleAutoBackup() {
    console.log('[BG-Backup] 开始执行每日自动备份...');
    try {
        const { tasks } = await chrome.storage.local.get('tasks');
        if (!tasks || (!tasks.daily?.length && !tasks.monthly?.length)) {
            console.log('[BG-Backup] 数据为空，跳过本次备份。');
            return;
        }

        const db = await openBackupDB();
        const transaction = db.transaction(VERSION_STORE_NAME, 'readwrite');
        const store = transaction.objectStore(VERSION_STORE_NAME);

        // 存储当前快照，使用时间戳作为key
        const timestamp = Date.now();
        store.put(tasks, timestamp);

        // 清理旧的备份（保留策略）
        const allKeysRequest = store.getAllKeys();
        allKeysRequest.onsuccess = () => {
            const keys = allKeysRequest.result;
            if (keys.length > MAX_BACKUPS) {
                keys.sort((a, b) => a - b); // 排序，最旧的在前
                const keysToDelete = keys.slice(0, keys.length - MAX_BACKUPS);
                keysToDelete.forEach(key => {
                    store.delete(key);
                    console.log(`[BG-Backup] 已删除旧的备份快照: ${new Date(key).toLocaleString()}`);
                });
            }
        };

        transaction.oncomplete = () => {
            console.log(`[BG-Backup] 成功创建新的备份快照: ${new Date(timestamp).toLocaleString()}`);
            db.close();
        };
        transaction.onerror = () => {
            console.error('[BG-Backup] 备份事务执行失败。');
            db.close();
        };

    } catch (error) {
        console.error('[BG-Backup] 自动备份过程中发生错误:', error);
    }
}



// ========================================================================
// 3. 核心：本地通知检查与显示逻辑 (重构)
// ========================================================================
async function checkAndShowNotifications() {
    console.log('[SW] checkAndShowNotifications called.');
    try {
        const allTasksData = await db.get('allTasks'); 
        
        if (!allTasksData || !allTasksData.future || !Array.isArray(allTasksData.future)) {
            console.log('[SW] No valid future tasks data found in DB for notifications.');
            return;
        }
        
        // 创建一个副本进行操作，以防直接修改从DB获取的对象可能引发的问题
        const allTasks = JSON.parse(JSON.stringify(allTasksData)); 

        if (allTasks.future.length === 0) {
            // console.log('[SW] No future tasks to check for notifications.');
            return;
        }
        
        const now = Date.now();
        const dueTasks = [];
        const remainingFutureTasks = [];
        let dbChangedByNotifications = false;

        allTasks.future.forEach(task => {
            // 只有当任务有 reminderTime 且已到期时才处理
            if (task.reminderTime && task.reminderTime <= now) {
                dueTasks.push(task);
                dbChangedByNotifications = true; // 标记有任务将被处理和移动
            } else {
                remainingFutureTasks.push(task);
            }
        });
        
        if (dueTasks.length > 0) {
            console.log(`[SW] Found ${dueTasks.length} due tasks for notification.`);
            allTasks.future = remainingFutureTasks; // 更新 future 列表，移除已到期的

            // 1. 显示通知
            for (const task of dueTasks) {
                console.log(`[SW] Showing notification for: ${task.text}`);
                // 确保有权限显示通知 (SW 通常在安装时请求或已获得)
                if (self.registration && typeof self.registration.showNotification === 'function') {
                    await self.registration.showNotification('高效待办清单提醒', { // 标题可以更具体
                        body: task.text,
                        icon: '/images/icons/icon-192x192.png', // PWA 图标
                        badge: '/images/icons/icon-192x192.png', // Android 状态栏小图标
                        tag: task.id, // 使用任务 ID作为标签，防止重复或用于更新
                        renotify: true, // 如果已有相同 tag 的通知，是否重新通知用户
                        data: { 
                            url: self.registration.scope + '#future-section', // 【MODIFIED】点击通知后打开到未来计划区域
                            taskId: task.id 
                        }
                    });
                } else {
                    console.warn('[SW] Cannot show notification: self.registration.showNotification is not available.');
                }

                // 2. 将到期任务移动到每日清单
                if (!Array.isArray(allTasks.daily)) {
                    allTasks.daily = [];
                }
                // 检查是否已存在 (以防重复移动)
                if (!allTasks.daily.some(d => d.originalFutureId === task.id)) {
                    allTasks.daily.unshift({
                        id: `daily_${Date.now()}_${Math.random().toString(36).substr(2,5)}`, // 新每日任务ID
                        text: `[计划] ${task.text}`, // 标记来源
                        completed: false,
                        note: task.progressText || task.note || '', // 继承备注
                        links: task.links || [],
                        originalFutureId: task.id // 记录原始未来任务ID
                    });
                }
            }
            
            // 3. 保存整个更新后的 allTasks 对象回 IndexedDB
            allTasks.lastUpdatedLocal = Date.now(); // 更新时间戳
            await db.set('allTasks', allTasks);
            console.log('[SW] Due tasks processed, moved to daily list, and DB updated.');

        } else {
             // console.log('[SW] No due notifications found at this time.');
        }
    } catch (error) {
        console.error("[SW] Error checking/showing notifications:", error);
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
