// ========================================================================
// 0. IndexedDB 帮助库 (简化 - PWA 中我们只操作一个 key-value store)
// ========================================================================
function promisifyRequest(request) {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
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
        return callback(store, transaction); 
    }).catch(err => {
        console.error("IndexedDB store operation failed:", err);
        throw err;
    });
}

const dbStore = createStore('EfficienTodoDB', 'data'); 

const db = {
    get(key) {
        return dbStore('readonly', (store) => promisifyRequest(store.get(key)));
    },
    set(key, value) {
        return dbStore('readwrite', (store, transaction) => {
            const req = store.put(value, key);
            return new Promise((resolve, reject) => {
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
                transaction.oncomplete = () => resolve(req.result);
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
            // 立即检查一次，以处理离线时到期的任务
            checkAndShowNotifications();
            
            // 模拟定期检查（这仍然不是最完美的，但比单个 setTimeout 好）
            setInterval(checkAndShowNotifications, 60 * 1000); // 例如每分钟检查一次
            return self.clients.claim(); // 确保新的 SW 立即控制所有打开的客户端
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
// 2. 【核心修改】监听来自主应用的消息
// ========================================================================
self.addEventListener('message', event => {
    if (event.data && event.data.action === 'skipWaiting') {
        self.skipWaiting();
    }
    // 【NEW】监听所有与提醒相关的消息
    else if (event.data && (
        event.data.type === 'SCHEDULE_REMINDER' || 
        event.data.type === 'UPDATE_REMINDER' || 
        event.data.type === 'CANCEL_REMINDER'
    )) {
        console.log(`[SW] Received ${event.data.type}. The future tasks list has changed.`);
        console.log('[SW] Triggering an immediate check for any due notifications.');
        
        // 无论是什么操作（新增、更新、删除），最可靠的应对方式就是立即完整地检查一遍。
        checkAndShowNotifications();
    }
});

// ========================================================================
// 3. 【核心新增】本地通知检查与显示逻辑
// ========================================================================
async function checkAndShowNotifications() {
    console.log('[SW] checkAndShowNotifications called.');
    try {
        const allTasksData = await db.get('allTasks'); 
        
        if (!allTasksData || !allTasksData.future || !Array.isArray(allTasksData.future)) {
            console.log('[SW] No valid future tasks data found in DB for notifications.');
            return;
        }
        
        // 创建一个副本进行操作，防止直接修改DB对象引发问题
        const allTasks = JSON.parse(JSON.stringify(allTasksData)); 

        const now = Date.now();
        const dueTasks = [];
        const remainingFutureTasks = [];
        let dbChanged = false;

        allTasks.future.forEach(task => {
            // 只有当任务有 reminderTime 且已到期时才处理
            if (task.reminderTime && task.reminderTime <= now) {
                dueTasks.push(task);
                dbChanged = true; // 标记有任务将被处理和移动
            } else {
                remainingFutureTasks.push(task);
            }
        });
        
        if (dueTasks.length > 0) {
            console.log(`[SW] Found ${dueTasks.length} due tasks.`);
            allTasks.future = remainingFutureTasks; // 更新 future 列表，移除已到期的

            // 1. 显示通知
            for (const task of dueTasks) {
                console.log(`[SW] Showing notification for: ${task.text}`);
                await self.registration.showNotification('高效待办清单提醒', {
                    body: task.text,
                    icon: '/images/icons/icon-192x192.png',
                    badge: '/images/icons/icon-192x192.png',
                    tag: task.id, // 使用任务ID作为标签，防止重复
                    renotify: true, // 如果已有相同tag的通知，重新通知
                    data: { 
                        url: self.registration.scope + '#future-section', // 点击通知后打开到未来计划区域
                        taskId: task.id 
                    }
                });

                // 2. 将到期任务移动到每日清单
                if (!allTasks.daily.some(d => d.originalFutureId === task.id)) {
                    allTasks.daily.unshift({
                        id: `daily_${Date.now()}_${Math.random().toString(36).substr(2,5)}`,
                        text: `[计划] ${task.text}`,
                        completed: false,
                        note: task.progressText || task.note || '',
                        links: task.links || [],
                        originalFutureId: task.id
                    });
                }
            }
            
            // 3. 将整个更新后的 allTasks 对象保存回 IndexedDB
            allTasks.lastUpdatedLocal = Date.now();
            await db.set('allTasks', allTasks);
            console.log('[SW] Due tasks processed, moved to daily list, and DB updated.');
        }
    } catch (error) {
        console.error("[SW] Error in checkAndShowNotifications:", error);
    }
}


// ========================================================================
// 4. 【核心改进】通知点击事件处理
// ========================================================================
self.addEventListener('notificationclick', event => {
    console.log('[SW] Notification click Received.', event.notification);
    event.notification.close();

    const urlToOpen = event.notification.data.url || self.registration.scope;

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
            // 检查是否已有该应用的窗口打开
            for (const client of clientList) {
                if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
                    // 如果有，则导航到指定URL并聚焦
                    client.navigate(urlToOpen);
                    return client.focus();
                }
            }
            // 如果没有，则打开新窗口
            if (clients.openWindow) {
                return clients.openWindow(urlToOpen);
            }
        })
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
