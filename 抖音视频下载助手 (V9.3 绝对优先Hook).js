// ==UserScript==
// @name 抖音视频下载助手 (V9.3 性能优化)
// @namespace http://tampermonkey.net/
// @version 9.3
// @description 核心升级：优化了面板拖动时的性能，将位置更新从 left/top 切换到 CSS transform，启用硬件加速，减少卡顿。
// @author Gemini, thehappymouse@gmail.com
// @match https://www.douyin.com/*
// @grant GM_download
// @grant GM_setClipboard
// @grant GM_addStyle
// @grant GM_xmlhttpRequest
// @run-at document-start
// ==/UserScript==

(function() {
    'use strict';

    // 真正的视频 CDN 关键词
    const CDN_KEYWORDS = ['video/tos/cn', 'douyinvod.com', 'mime_type=video_mp4'];

    // 全局状态管理
    const state = {
        urls: new Set(),
        items: [],
        currentPlayingId: null,
        isPanelVisible: true,
        isPanelCollapsed: false
    };

    // --- 工具函数：URL 清理与去重核心 ---
    function cleanAndNormalizeUrl(url) {
        if (url.startsWith('blob:')) return null;
        try {
            const urlObj = new URL(url);
            urlObj.search = '';
            let cleanUrl = urlObj.toString();
            if (cleanUrl.endsWith('/')) cleanUrl = cleanUrl.slice(0, -1);
            return decodeURIComponent(cleanUrl);
        } catch(e) {
            return url;
        }
    }

    // --- 1. 核心引擎 A/B: API & 网络流嗅探 (保持不变) ---

    function scanObjectForVideo(obj) {
        if (!obj || typeof obj !== 'object') return;
        if (Array.isArray(obj)) { obj.forEach(item => scanObjectForVideo(item)); return; }

        const aweme_detail = obj.aweme_detail || obj;

        if (aweme_detail.aweme_id && aweme_detail.video && aweme_detail.video.play_addr && aweme_detail.video.play_addr.url_list) {
            addVideoToUI({
                url: aweme_detail.video.play_addr.url_list[0],
                title: aweme_detail.desc || "未命名视频",
                id: aweme_detail.aweme_id,
                cover: (aweme_detail.video.cover && aweme_detail.video.cover.url_list) ? aweme_detail.video.cover.url_list[0] : null,
                source: 'API'
            });
            return;
        }

        if (obj.data) scanObjectForVideo(obj.data);
        if (obj.aweme_list) scanObjectForVideo(obj.aweme_list);
    }

    // 绝对优先 Hook JSON.parse
    const originalParse = JSON.parse;
    JSON.parse = function(text, reviver) {
        let result;
        try {
            result = originalParse(text, reviver);
        } catch (e) {
            return originalParse(text, reviver);
        }
        try { scanObjectForVideo(result); } catch (e) {}
        return result;
    };

    // 绝对优先 Hook XMLHttpRequest.open
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        if (CDN_KEYWORDS.some(k => url.includes(k))) {
            if (url.startsWith('//')) url = 'https:' + url;
            addVideoToUI({ url: url, title: `网络流_${Date.now().toString().slice(-4)}`, source: 'NET' });
        }
        return originalOpen.apply(this, arguments);
    };

    // --- 样式 (V9.3 更新：添加 transform 优化) ---
    const css = `
        #dy-sniffer-panel {
            /* V9.3 核心：改为固定位置，使用 transform 移动 */
            position: fixed;
            right: 20px;
            top: 80px;
            width: 340px;
            max-height: 85vh;
            /* 确保初始位置是固定的 */
            transform: translate(0, 0);
            will-change: transform; /* 浏览器提示：将要修改 transform 属性，提前进行优化 */

            background: rgba(22, 24, 35, 0.95);
            border: 1px solid rgba(255,255,255,0.1);
            border-radius: 10px;
            z-index: 2147483647;
            color: #fff;
            display: flex;
            flex-direction: column;
            font-family: sans-serif;
            box-shadow: 0 8px 20px rgba(0,0,0,0.6);
            backdrop-filter: blur(10px);
            cursor: grab;
            transition: all 0.3s ease-in-out;
        }
        #dy-sniffer-panel.dragging { cursor: grabbing; }
        #dy-sniffer-header {
            padding: 15px; border-bottom: 1px solid rgba(255,255,255,0.1); font-weight: bold;
            display: flex; justify-content: space-between; align-items: center; background: rgba(255,255,255,0.05);
            cursor: move;
        }
        .dy-clear-btn { font-size:12px; color:#bbb; cursor:pointer; text-decoration:underline; margin-right:10px;}
        .dy-close-btn { cursor:pointer; font-size:18px; line-height: 1; user-select: none; margin-left: 5px; }
        #dy-sniffer-content { overflow-y: auto; flex: 1; padding: 10px; scroll-behavior: smooth; cursor: default;}

        /* 折叠后的悬浮按钮样式 */
        #dy-restore-btn {
            position: fixed; right: 20px; top: 80px; width: 80px; height: 35px;
            background: #9b59b6;
            color: white; border: none; border-radius: 5px;
            z-index: 2147483647; cursor: pointer;
            font-size: 14px; font-weight: bold;
            display: none;
            align-items: center; justify-content: center;
            box-shadow: 0 4px 10px rgba(0,0,0,0.4);
            transition: all 0.3s ease-in-out;
        }
        #dy-restore-btn:hover { background: #8e44ad; }

        .dy-item {
            background: rgba(255,255,255,0.08); margin-bottom: 10px; padding: 10px;
            border-radius: 8px; display: flex; gap: 10px; transition: all 0.3s; border: 2px solid transparent;
            cursor: default;
        }
        .dy-item.playing {
            background: rgba(37, 192, 170, 0.15); border-color: #25c0aa; order: -1;
        }
        .dy-cover-img { width: 60px; height: 80px; object-fit: cover; border-radius: 4px; background: #000; flex-shrink: 0; }
        .dy-info { flex: 1; display: flex; flex-direction: column; justify-content: space-between; overflow: hidden; }
        .dy-item-title {
            font-size: 12px; line-height: 1.4; max-height: 2.8em; overflow: hidden;
            text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
            color: #eee; margin-bottom: 3px;
        }
        .dy-item-id {
            font-size: 10px; color: #999; margin-bottom: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .dy-btn-group { display: flex; gap: 5px; }
        .dy-action-btn {
            flex: 1; padding: 5px 0; border: none; border-radius: 4px; cursor: pointer;
            color: white; font-size: 11px; transition: opacity 0.2s;
        }
        .dy-btn-jump { background: #3a3f50; }
        .dy-btn-down { background: #fe2c55; }
        .dy-action-btn:hover { opacity: 0.8; }
        .dy-btn-disabled { opacity: 0.5; cursor: not-allowed; background: #555; }
        .dy-tag { font-size: 9px; padding: 2px 4px; border-radius: 3px; background: #333; color: #aaa; width: fit-content; margin-right: 5px; }
        .dy-tag.tag-dom { background: #e68e20; color: #fff; }
        .dy-tag.tag-playing { background: #25c0aa; color: #fff; display: none; }
        .dy-item.playing .dy-tag.tag-playing { display: inline-block; }
    `;

    // --- 2. 核心引擎 C: ID 匹配、高亮、滚动 (保持不变) ---
    // ... (代码保持 V9.2 不变) ...
    function startDOMVideoURLSniffer() {
        // ... (保持 V9.2 逻辑不变) ...
        setInterval(() => {
            const currentId = extractCurrentVideoId();
            const currentTitle = extractCurrentVideoTitle();

            document.querySelectorAll('video').forEach(videoEl => {
                const url = videoEl.src;
                if (!url) return;

                const cleanUrl = cleanAndNormalizeUrl(url);
                if (!cleanUrl) return;

                if (CDN_KEYWORDS.some(k => url.includes(k))) {
                    if (!state.urls.has(cleanUrl)) {
                        console.log(`[抖音助手] DOM 嗅探到可下载 URL: ${cleanUrl}`);

                        addVideoToUI({
                            url: url,
                            title: currentTitle,
                            id: currentId,
                            cover: null,
                            source: 'DOM'
                        });

                        state.urls.add(cleanUrl);
                    }
                }
            });
        }, 500);
    }

    function startTitleAndIDExtractor() {
        // ... (保持 V9.2 逻辑不变) ...
        setInterval(() => {
            const currentId = extractCurrentVideoId();
            let matchedElement = null;

            if (currentId) {
                state.items.forEach(item => {
                    const isPlaying = (item.id === currentId);

                    if (isPlaying) {
                        matchedElement = item.el;

                        if (!item.el.classList.contains('playing')) {
                            document.querySelectorAll('.dy-item.playing').forEach(el => el.classList.remove('playing'));
                            item.el.classList.add('playing');
                        }

                        item.el.querySelector('.dy-item-id').innerText = `ID: ${currentId}`;

                    } else {
                        item.el.classList.remove('playing');
                    }
                });

                if (matchedElement && state.currentPlayingId !== currentId) {
                    matchedElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    state.currentPlayingId = currentId;
                } else if (currentId && state.currentPlayingId !== currentId) {
                    document.querySelectorAll('.dy-item.playing').forEach(el => el.classList.remove('playing'));
                    state.currentPlayingId = currentId;
                }

            } else {
                document.querySelectorAll('.dy-item.playing').forEach(el => el.classList.remove('playing'));
                state.currentPlayingId = null;
            }
        }, 300);
    }

    function extractCurrentVideoId() {
        const urlParams = new URLSearchParams(window.location.search);
        const modalId = urlParams.get('modal_id');
        if (modalId) return modalId;

        const pathMatch = window.location.pathname.match(/\/video\/(\d+)/);
        if (pathMatch) return pathMatch[1];

        return null;
    }

    function extractCurrentVideoTitle() {
        const titleEl = document.querySelector('[data-e2e="feed-video-desc"]') ||
                             document.querySelector('[data-e2e="video-desc"]') ||
                             document.querySelector('h1') ||
                             document.querySelector('div[class*="desc"]');

        if (titleEl && titleEl.innerText) {
            return titleEl.innerText.substring(0, 60).replace(/\s+/g, ' ').trim();
        }

        const id = extractCurrentVideoId();
        return id ? `视频 #${id}` : '未命名视频';
    }


    // --- 3. UI, 下载与初始化 ---

    // ... forceDownload, handleError (保持不变)

    function forceDownload(url, filename, btn) {
        // ... (保持 V9.2 逻辑不变)
        if (btn.classList.contains('dy-btn-disabled')) return;
        btn.innerText = "0%"; btn.classList.add('dy-btn-disabled');
        GM_xmlhttpRequest({
            method: "GET", url: url, responseType: "blob",
            headers: { "Referer": "https://www.douyin.com/", "User-Agent": navigator.userAgent },
            onprogress: (p) => { if(p.total>0) btn.innerText = Math.round((p.loaded/p.total)*100) + "%"; },
            onload: (r) => {
                if (r.status === 200) {
                    const u = window.URL.createObjectURL(r.response);
                    const a = document.createElement('a'); a.href = u; a.download = filename;
                    document.body.appendChild(a); a.click(); document.body.removeChild(a);
                    window.URL.revokeObjectURL(u);
                    btn.innerText = "完成";
                    setTimeout(() => { btn.innerText = "下载"; btn.classList.remove('dy-btn-disabled'); }, 2000);
                } else { handleError(btn); }
            },
            onerror: () => handleError(btn)
        });
    }

    function handleError(btn) {
        // ... (保持 V9.2 逻辑不变)
        btn.innerText = "失败"; btn.style.background = "#555";
        alert("下载失败！请复制链接到浏览器新窗口打开，或尝试刷新页面。");
        setTimeout(() => { btn.innerText = "下载"; btn.classList.remove('dy-btn-disabled'); btn.style.background = "#fe2c55"; }, 3000);
    }

    // V9.3 核心优化：使用 transform 实现拖动
    function makeDraggable(element, handle) {
        let isDragging = false;
        let startX = 0;
        let startY = 0;
        let translateX = 0; // 记录当前的 X 偏移量
        let translateY = 0; // 记录当前的 Y 偏移量
        let initialRight = 20; // 初始 CSS right 值
        let initialTop = 80;   // 初始 CSS top 值

        // 获取当前 transform 值的辅助函数
        function getTransformValues() {
            const style = window.getComputedStyle(element);
            const matrix = style.transform;
            if (matrix === 'none') {
                return { x: 0, y: 0 };
            }
            // 提取 translate(x, y) 中的 x 和 y
            const match = matrix.match(/matrix.*\((.+)\)/);
            if (match) {
                const values = match[1].split(', ').map(v => parseFloat(v));
                if (values.length === 6) {
                    return { x: values[4], y: values[5] };
                }
            }
            return { x: 0, y: 0 };
        }

        handle.addEventListener('mousedown', (e) => {
            isDragging = true;
            element.classList.add('dragging');

            // 1. 获取当前偏移量
            const currentTransform = getTransformValues();
            translateX = currentTransform.x;
            translateY = currentTransform.y;

            // 2. 记录鼠标点击的起始位置
            startX = e.clientX;
            startY = e.clientY;

            e.preventDefault();
        });

        document.addEventListener('mousemove', (e) => {
            if (!isDragging) return;

            // 3. 计算鼠标位移
            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;

            // 4. 计算新的 transform 偏移量
            const newTranslateX = translateX + deltaX;
            const newTranslateY = translateY + deltaY;

            // 5. 应用 transform (启用硬件加速，性能更高)
            element.style.transform = `translate(${newTranslateX}px, ${newTranslateY}px)`;

            // 6. 实时更新起始点，以实现平滑拖动
            startX = e.clientX;
            startY = e.clientY;
            translateX = newTranslateX;
            translateY = newTranslateY;
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                element.classList.remove('dragging');
                // 可选：在这里可以存储最终位置，以便下次加载时恢复
            }
        });
    }

    // V9.2: 折叠/还原 逻辑
    function toggleCollapse() {
        const panel = document.getElementById('dy-sniffer-panel');
        const restoreBtn = document.getElementById('dy-restore-btn');
        state.isPanelCollapsed = !state.isPanelCollapsed;

        if (state.isPanelCollapsed) {
            panel.style.display = 'none';
            restoreBtn.style.display = 'flex';
        } else {
            panel.style.display = 'flex';
            restoreBtn.style.display = 'none';
        }
    }

    function createUI() {
        GM_addStyle(css);

        // 1. 主面板
        const panel = document.createElement('div');
        panel.id = 'dy-sniffer-panel';
        panel.innerHTML = `
            <div id="dy-sniffer-header">
                <span>🔍 视频捕获 (<span id="dy-count">0</span>)</span>
                <div>
                    <span class="dy-clear-btn" id="dy-clear">清空</span>
                    <span class="dy-close-btn" id="dy-toggle-collapse">×</span>
                </div>
            </div>
            <div id="dy-sniffer-content"><div style="text-align:center;color:#888;padding:20px;font-size:12px;">正在监听外部视频流...</div></div>
        `;
        document.body.appendChild(panel);

        // 2. 还原按钮 (折叠后显示的悬浮按钮)
        const restoreBtn = document.createElement('button');
        restoreBtn.id = 'dy-restore-btn';
        restoreBtn.innerHTML = '&#8644; 还原';
        document.body.appendChild(restoreBtn);


        // --- 绑定事件 ---

        document.getElementById('dy-clear').onclick = () => {
            document.getElementById('dy-sniffer-content').innerHTML = '';
            state.items = []; state.urls.clear(); document.getElementById('dy-count').innerText = '0';
        };

        // V9.2: X 按钮现在是折叠
        document.getElementById('dy-toggle-collapse').onclick = toggleCollapse;

        // V9.2: 还原按钮点击
        restoreBtn.onclick = toggleCollapse;

        makeDraggable(panel, document.getElementById('dy-sniffer-header'));
    }

    function addVideoToUI(meta) {
        // ... (保持 V9.2 逻辑不变) ...
        const cleanUrl = cleanAndNormalizeUrl(meta.url);
        if (!cleanUrl) return;

        let existingItem = state.items.find(item => item.cleanUrl === cleanUrl);
        const idDisplay = meta.id ? `ID: ${meta.id}` : 'ID: 未捕获';
        const videoId = meta.id || extractCurrentVideoId();

        if (existingItem) {
            // ... (省略去重和更新逻辑，与V9.2相同)
            let isUpdated = false;

            const isBetterSource = (meta.source === 'API' && existingItem.source !== 'API') ||
                                   (meta.source === 'DOM' && existingItem.source === 'NET');

            if (isBetterSource || existingItem.id === null) {

                if (meta.id && existingItem.id === null) {
                    existingItem.id = meta.id;
                    existingItem.el.querySelector('.dy-item-id').innerText = idDisplay;
                    isUpdated = true;
                }

                if (meta.cover && existingItem.cover === null) {
                    existingItem.cover = meta.cover;
                    existingItem.el.querySelector('.dy-cover-img').src = meta.cover;
                    isUpdated = true;
                }

                if (isBetterSource) {
                     existingItem.source = meta.source;
                     const sourceColor = meta.source === 'API' ? '#587edb' : (meta.source === 'DOM' ? '#e68e20' : '#333');
                     existingItem.el.querySelector('.tag-api').innerText = meta.source;
                     existingItem.el.querySelector('.tag-api').style.background = sourceColor;
                     isUpdated = true;
                }

                if (meta.title && meta.title.length > existingItem.el.dataset.title.length) {
                    existingItem.el.dataset.title = meta.title;
                    const sourceColor = existingItem.source === 'API' ? '#587edb' : (existingItem.source === 'DOM' ? '#e68e20' : '#333');
                    existingItem.el.querySelector('.dy-item-title').innerHTML =
                            `<span class="dy-tag tag-playing">播放中</span><span class="dy-tag tag-api" style="background:${sourceColor};">${existingItem.source}</span> ${meta.title}`;
                    isUpdated = true;
                }
            }
            return;
        }

        // --- 创建新列表项 ---

        const container = document.getElementById('dy-sniffer-content');
        if (container && container.innerText.includes("正在监听")) container.innerHTML = '';
        if (!container) return;

        document.getElementById('dy-count').innerText = parseInt(document.getElementById('dy-count').innerText) + 1;

        const itemEl = document.createElement('div');
        itemEl.className = 'dy-item';
        itemEl.dataset.title = meta.title;

        const safeTitle = meta.title.replace(/[\\/:*?"<>|]/g, '_').trim() || `douyin_${Date.now()}`;

        const sourceColor = meta.source === 'API' ? '#587edb' : (meta.source === 'DOM' ? '#e68e20' : '#333');
        let coverHtml = meta.cover ? `<img src="${meta.cover}" class="dy-cover-img">` : `<div class="dy-cover-img" style="display:flex;align-items:center;justify-content:center;color:#666;border:1px solid #444;">${meta.source}</div>`;

        itemEl.innerHTML = `
            ${coverHtml}
            <div class="dy-info">
                <div class="dy-item-title" title="${meta.title}">
                    <span class="dy-tag tag-playing">播放中</span>
                    <span class="dy-tag tag-api" style="background:${sourceColor};">${meta.source}</span>
                    ${meta.title}
                </div>
                <div class="dy-item-id">${idDisplay}</div>
                <div class="dy-btn-group">
                    <button class="dy-action-btn dy-btn-jump dy-btn-disabled">跳转</button>
                    <button class="dy-action-btn dy-btn-down">下载</button>
                </div>
            </div>
        `;

        const jumpBtn = itemEl.querySelector('.dy-btn-jump');
        if (videoId) {
            jumpBtn.classList.remove('dy-btn-disabled');
            jumpBtn.innerText = "跳转";
            jumpBtn.onclick = () => { window.open(`https://www.douyin.com/video/${videoId}`, '_blank'); };
        } else {
             jumpBtn.innerText = "ID缺失";
        }

        const downBtn = itemEl.querySelector('.dy-btn-down');
        downBtn.onclick = () => forceDownload(meta.url, safeTitle + '.mp4', downBtn);

        container.appendChild(itemEl);

        state.urls.add(cleanUrl);
        state.items.push({
            id: videoId || null,
            el: itemEl,
            url: meta.url,
            cleanUrl: cleanUrl,
            source: meta.source,
            cover: meta.cover || null
        });
    }

    // 统一的核心服务启动函数
    function startCoreServices() {
        createUI();
        startTitleAndIDExtractor();
        startDOMVideoURLSniffer();
    }

    // 真正的初始化函数
    function init() {
        // Hook 逻辑已在顶层

        // 使用 MutationObserver 确保在 body 元素出现时立即启动 UI 和核心逻辑
        if (document.body) {
            startCoreServices();
        } else {
            const observer = new MutationObserver((mutationsList, observer) => {
                if (document.body) {
                    observer.disconnect();
                    startCoreServices();
                }
            });
            observer.observe(document.documentElement, { childList: true });
        }
    }

    init();
})();
