// content.js - 内容脚本，用于检测页面中的m3u8 URL
(function () {
    'use strict';

    // 监听来自popup和后台脚本的消息
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        const tabId = message.tabId;
        console.log("content.js received:", message, tabId);

        if (message.action === "ping") {
            sendResponse({ ok: true });
            return true; // 表示异步可用
        }
        if (message.action === 'quickDetectVideo' && tabId) {// 获取从缓存中获取之前检测到的m3u8 URL
            quickDetectVideoUrls(tabId).then(result => {
                sendResponse(result);
            }).catch(error => {
                sendResponse({ success: false, error: error.message });
            });
            return true; // 保持消息通道开放以进行异步响应
        } else if (message.action === 'detectVideo') {
            detectVideoUrls().then(result => {
                sendResponse(result);
            }).catch(error => {
                sendResponse({ success: false, error: error.message });
            });
            return true; // 保持消息通道开放以进行异步响应
        }

        if (message.action === 'm3u8Detected') {
            // 初始化全局变量用于存储后台检测到的m3u8 URL
            if (!window.backgroundDetectedM3u8Urls) {
                window.backgroundDetectedM3u8Urls = [];
            }
            // 过滤相同的 URL
            if (!window.backgroundDetectedM3u8Urls.includes(message.url)) {
                window.backgroundDetectedM3u8Urls.push(message.url);
                console.log('后台脚本检测到m3u8:', message.url);
            }
            // 可以在这里添加实时更新UI的逻辑
            return false;
        }
    });

    async function quickDetectVideoUrls(tabId) {
        try {

            const cacheKey = `detectedM3u8Urls_${tabId}`;
            const cachedUrls = localStorage.getItem(cacheKey);

            if (cachedUrls) {
                const parsedUrls = JSON.parse(cachedUrls);
                if (parsedUrls.length > 0) {
                    console.log('从本地缓存中找到m3u8 URL:', parsedUrls);
                    return {
                        success: true,
                        videoUrls: parsedUrls,
                        count: parsedUrls.length
                    };
                }
            } else {
                console.log('从本地缓存中未找到m3u8 URL');
            }
        } catch (e) {
            console.error('从本地缓存获取m3u8 URL时出错:', e);
        }

        return detectVideoUrls().then(result => {
            if (result.success) {
                // 对 tabUrl 做 hash 处理，作为缓存的 key
                const cacheKey = `detectedM3u8Urls_${tabId}`;
                // 将检测到的唯一m3u8 URL以 hash 后的 key 保存到本地缓存
                localStorage.setItem(cacheKey, JSON.stringify(result.videos));
                return {
                    success: true,
                    videoUrls: result.videos,
                    count: result.count
                };
            } else {
                return {
                    success: false,
                    error: result.error
                };
            }
        }).catch(error => {
            console.error('检测m3u8 URL时出错:', error);
            return {
                success: false,
                error: error.message
            };
        });
    }

    function formatDuration(seconds) {
        if (seconds < 1) return null;

        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);

        if (hours > 0) {
            return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        } else if (minutes > 0) {
            return `${minutes}:${secs.toString().padStart(2, '0')}`;
        } else {
            return `${secs}秒`;
        }
    }

    async function validateM3u8UrlAndGetDuration(url) {
        try {
            console.log('验证m3u8 URL并获取时长:', url);

            const response = await fetch(url, {
                method: 'GET',
                mode: 'cors',
                credentials: 'omit',
                redirect: 'follow'
            });

            if (!response.ok) {
                console.warn('m3u8 URL验证失败 - HTTP错误:', url, response.status);
                return { isValid: false, duration: null };
            }

            const content = await response.text();

            // 检查是否包含有效的m3u8内容
            if (!content || content.trim().length === 0) {
                console.warn('m3u8 URL验证失败 - 内容为空:', url);
                return { isValid: false, duration: null };
            }

            // 检查是否包含m3u8格式的关键标识
            const m3u8Markers = [
                '#EXTM3U',
                '#EXTINF:',
                '#EXT-X-STREAM-INF:',
                '#EXT-X-TARGETDURATION:',
                '#EXT-X-MEDIA-SEQUENCE:'
            ];

            const hasValidMarker = m3u8Markers.some(marker => content.includes(marker));
            if (!hasValidMarker) {
                console.warn('m3u8 URL验证失败 - 不包含有效的m3u8标记:', url);
                return { isValid: false, duration: null };
            }

            // 检查是否包含媒体片段链接
            const lines = content.split('\n').map(line => line.trim()).filter(line => line);
            const hasMediaSegments = lines.some(line =>
                !line.startsWith('#') &&
                (line.endsWith('.ts') || line.includes('.ts?') || line.includes('segment'))
            );

            if (!hasMediaSegments) {
                // 可能是主播放列表，检查是否包含子播放列表
                const hasVariantStream = lines.some(line =>
                    line.includes('#EXT-X-STREAM-INF:') ||
                    (line.includes('.m3u8') && !line.startsWith('#'))
                );

                if (!hasVariantStream) {
                    console.warn('m3u8 URL验证失败 - 不包含媒体片段或子播放列表:', url);
                    return { isValid: false, duration: null };
                }
            }

            // 计算时长（仅适用于m3u8格式）
            let duration = null;
            if (url.includes('.m3u8')) {
                let totalDuration = 0;

                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];

                    // 检查 #EXTINF 标签
                    if (line.startsWith('#EXTINF:')) {
                        const durationMatch = line.match(/#EXTINF:([\d.]+)/);
                        if (durationMatch) {
                            const segmentDuration = parseFloat(durationMatch[1]);
                            if (!isNaN(segmentDuration)) {
                                totalDuration += segmentDuration;
                            }
                        }
                    }

                    // 检查 #EXT-X-TARGETDURATION
                    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
                        const targetDurationMatch = line.match(/#EXT-X-TARGETDURATION:([\d.]+)/);
                        if (targetDurationMatch) {
                            const targetDuration = parseFloat(targetDurationMatch[1]);
                            if (!isNaN(targetDuration) && totalDuration === 0) {
                                // 如果没有找到EXTINF，使用targetduration作为估算
                                const segmentCount = lines.filter(l => !l.startsWith('#') && l.length > 0).length;
                                totalDuration = targetDuration * segmentCount;
                            }
                        }
                    }
                }

                if (totalDuration > 0) {
                    duration = formatDuration(totalDuration);
                }
            }

            console.log(`m3u8 URL验证成功: ${url}, 时长: ${duration || '未知'}`);
            return { isValid: true, duration: duration };

        } catch (error) {
            console.warn('m3u8 URL验证出错:', url, error.message);
            return { isValid: false, duration: null };
        }
    }

    async function detectVideoUrls() {
        const videoUrls = [];

        try {
            console.log('开始检测页面中的m3u8 URL...');

            // 0. 首先获取后台脚本检测到的URL
            console.log('0. 获取后台检测的URL...');
            const backgroundUrls = await getUrlsFromBackground();
            if (backgroundUrls.length > 0) {
                console.log('后台检测到m3u8:', backgroundUrls);
                videoUrls.push(...backgroundUrls);
            }

            // 1. 检查页面中的所有链接
            console.log('1. 检查页面链接...');
            const links = document.querySelectorAll('a[href]');
            for (const link of links) {
                const href = link.href;
                if (isM3u8Url(href)) {
                    console.log('找到链接中的m3u8:', href);
                    videoUrls.push(href);
                }
            }

            // 2. 检查页面中的所有script标签中的内容
            console.log('2. 检查script标签...');
            const scripts = document.querySelectorAll('script');
            for (const script of scripts) {
                if (script.textContent) {
                    const urls = extractUrlsFromText(script.textContent);
                    const m3u8Urls = urls.filter(isM3u8Url);
                    if (m3u8Urls.length > 0) {
                        console.log('找到script中的m3u8:', m3u8Urls);
                        videoUrls.push(...m3u8Urls);
                    }
                }
            }

            // 3. 检查页面中的所有文本内容
            console.log('3. 检查页面文本内容...');
            const allText = document.body.innerText || document.body.textContent || '';
            const textUrls = extractUrlsFromText(allText);
            const textM3u8Urls = textUrls.filter(isM3u8Url);
            if (textM3u8Urls.length > 0) {
                console.log('找到文本中的m3u8:', textM3u8Urls);
                videoUrls.push(...textM3u8Urls);
            }

            // 4. 检查所有元素的属性
            console.log('4. 检查元素属性...');
            const elementsWithAttrs = document.querySelectorAll('[src], [href], [data-src], [data-url], [data-stream], [data-video], [data-hls], [data-source]');
            for (const element of elementsWithAttrs) {
                const attrs = ['src', 'href', 'data-src', 'data-url', 'data-stream', 'data-video', 'data-hls', 'data-source'];
                for (const attr of attrs) {
                    const value = element.getAttribute(attr);
                    if (value && isM3u8Url(value)) {
                        console.log(`找到属性 ${attr} 中的m3u8:`, value);
                        videoUrls.push(value);
                    }
                }
            }

            // 5. 检查页面中的video元素
            console.log('5. 检查video元素...');
            const videoElements = document.querySelectorAll('video');
            for (const video of videoElements) {
                if (video.src && isM3u8Url(video.src)) {
                    console.log('找到video元素中的m3u8:', video.src);
                    videoUrls.push(video.src);
                }

                // 检查source元素
                const sources = video.querySelectorAll('source');
                for (const source of sources) {
                    if (source.src && isM3u8Url(source.src)) {
                        console.log('找到source元素中的m3u8:', source.src);
                        videoUrls.push(source.src);
                    }
                }
            }

            // 6. 检查iframe中的内容
            console.log('6. 检查iframe内容...');
            const iframes = document.querySelectorAll('iframe');
            for (const iframe of iframes) {
                try {
                    if (iframe.contentDocument) {
                        const iframeVideoUrls = extractVideoUrlsFromDocument(iframe.contentDocument);
                        if (iframeVideoUrls.length > 0) {
                            console.log('找到iframe中的m3u8:', iframeVideoUrls);
                            videoUrls.push(...iframeVideoUrls);
                        }
                    }
                } catch (e) {
                    // 跨域iframe无法访问
                    console.log('无法访问iframe内容（跨域限制）');
                }
            }

            // 7. 检查网络请求中的m3u8 URL (扩展超时时间)
            console.log('7. 检查网络请求...');
            const networkUrls = await checkNetworkRequests();
            if (networkUrls.length > 0) {
                console.log('找到网络请求中的m3u8:', networkUrls);
                videoUrls.push(...networkUrls);
            }

            // 8. 检查localStorage和sessionStorage
            console.log('8. 忽略检查存储数据...');
            // const storageUrls = checkStorageForUrls();
            // if (storageUrls.length > 0) {
            //     console.log('找到存储中的m3u8:', storageUrls);
            //     videoUrls.push(...storageUrls);
            // }

            // 9. 检查全局变量
            console.log('9. 检查全局变量...');
            const globalUrls = checkGlobalVariables();
            if (globalUrls.length > 0) {
                console.log('找到全局变量中的m3u8:', globalUrls);
                videoUrls.push(...globalUrls);
            }

            // 去重
            const uniqueUrls = [...new Set(videoUrls)];

            console.log('检测到的m3u8 URL:', uniqueUrls);

            // 验证m3u8链接的有效性，过滤掉没有内容的链接，并获取时长信息
            console.log('开始验证m3u8链接内容...');
            const validVideos = [];

            for (const url of uniqueUrls) {
                try {
                    // 使用合并的函数，一次性获取验证结果和时长
                    const validationResult = await validateM3u8UrlAndGetDuration(url);

                    if (validationResult.isValid) {
                        validVideos.push({
                            url: url,
                            duration: validationResult.duration || '未知'
                        });
                        console.log(`视频验证成功 - URL: ${url}, 时长: ${validationResult.duration || '未知'}`);
                    } else {
                        console.log('过滤掉无效的m3u8链接:', url);
                    }
                } catch (error) {
                    console.warn('验证m3u8链接时出错:', url, error.message);
                    // 如果验证出错，保守起见仍然保留该链接，但时长为未知
                    validVideos.push({
                        url: url,
                        duration: '未知'
                    });
                }
            }

            console.log('验证后的有效m3u8视频:', validVideos);

            return {
                success: true,
                videos: validVideos,
                videoUrls: validVideos.map(v => v.url), // 保持向后兼容
                count: validVideos.length
            };

        } catch (error) {
            console.error('检测视频URL时出错:', error);
            return {
                success: false,
                error: error.message
            };
        }
    }

    function isM3u8Url(url) {
        if (!url || typeof url !== 'string') return false;

        // 检查是否包含.m3u8
        if (url.includes('.m3u8')) return true;

        // 检查是否是HLS流URL
        if (url.includes('m3u8') || url.includes('hls')) return true;

        // 检查常见的流媒体URL模式（扩展模式）
        const hlsPatterns = [
            /\.m3u8(\?|$)/i,
            /\/playlist\.m3u8/i,
            /\/index\.m3u8/i,
            /\/master\.m3u8/i,
            /\/stream\.m3u8/i,
            /\/hls\//i,
            /\/stream\//i,
            /\/playlist\//i,
            /\/manifest(\?|$)/i,
            /\/master(\?|$)/i,
            /\/index(\?|$)/i,
            /\/playlist(\?|$)/i,
            /\/stream(\?|$)/i,
            /\/hls-manifest/i,
            /\/manifest-hls/i,
            /\/video\/.*\/manifest/i,
            /\/vod\/.*\.m3u8/i,
            /\/live\/.*\.m3u8/i,
            /\/streaming\/.*\.m3u8/i,
            /\/media\/.*\.m3u8/i,
            /\/content\/.*\.m3u8/i,
            /\/video\/.*\.m3u8/i,
            /\/videos\/.*\.m3u8/i,
            /\/clip\//i,
            /\/segment\//i,
            /\/chunks\//i,
            /\/fragments\//i,
            /\/ts\//i,
            /\.ts\?.*m3u8/i,
            /\/playlist.*\.m3u8/i,
            /\/index.*\.m3u8/i,
            /\/master.*\.m3u8/i,
            /\/stream.*\.m3u8/i,
            /\/hls.*\.m3u8/i
        ];

        return hlsPatterns.some(pattern => pattern.test(url));
    }

    function extractUrlsFromText(text) {
        // 更全面的URL匹配模式（包括m3u8相关的各种格式）
        const urlPatterns = [
            // 标准m3u8 URL
            /https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*\/[^\s"'<>]*\.m3u8[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*\/[^\s"'<>]*\/[^\s"'<>]*\.m3u8[^\s"'<>]*/gi,

            // HLS流URL模式
            /https?:\/\/[^\s"'<>]*\/hls\/[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*\/stream\/[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*\/playlist\/[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*\/manifest[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*\/master[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*\/index[^\s"'<>]*/gi,

            // 更长的路径模式
            /https?:\/\/[^\s"'<>]*\/[^\s"'<>]*\/[^\s"'<>]*\/[^\s"'<>]*\.m3u8[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*\/[^\s"'<>]*\/[^\s"'<>]*\/[^\s"'<>]*\/[^\s"'<>]*\.m3u8[^\s"'<>]*/gi,

            // 包含查询参数的m3u8
            /https?:\/\/[^\s"'<>]*\.m3u8\?[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*\/[^\s"'<>]*\.m3u8\?[^\s"'<>]*/gi,

            // 常见的流媒体路径
            /https?:\/\/[^\s"'<>]*\/vod\/[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*\/live\/[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*\/streaming\/[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*\/media\/[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*\/content\/[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*\/video\/[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*\/videos\/[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*\/clip\/[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*\/segment\/[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*\/chunks\/[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*\/fragments\/[^\s"'<>]*/gi,
            /https?:\/\/[^\s"'<>]*\/ts\/[^\s"'<>]*/gi
        ];

        const urls = [];
        for (const pattern of urlPatterns) {
            const matches = text.match(pattern) || [];
            urls.push(...matches);
        }

        // 过滤出真正的m3u8 URL
        return [...new Set(urls)].filter(url => isM3u8Url(url));
    }

    function checkStorageForUrls() {
        const urls = [];

        try {
            // 检查localStorage
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                const value = localStorage.getItem(key);
                if (value && isM3u8Url(value)) {
                    urls.push(value);
                }
            }

            // 检查sessionStorage
            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                const value = sessionStorage.getItem(key);
                if (value && isM3u8Url(value)) {
                    urls.push(value);
                }
            }
        } catch (e) {
            console.log('检查存储时出错:', e);
        }

        return urls;
    }

    function checkGlobalVariables() {
        const urls = [];

        try {
            // 检查常见的全局变量名
            const globalVarNames = [
                'videoUrl', 'video_url', 'streamUrl', 'stream_url', 'm3u8Url', 'm3u8_url',
                'hlsUrl', 'hls_url', 'playlistUrl', 'playlist_url', 'sourceUrl', 'source_url',
                'mediaUrl', 'media_url', 'streamSource', 'stream_source', 'videoSource', 'video_source',
                'url', 'src', 'source', 'stream', 'video', 'playlist', 'hls', 'm3u8'
            ];

            for (const varName of globalVarNames) {
                try {
                    const value = window[varName];
                    if (value && typeof value === 'string' && isM3u8Url(value)) {
                        urls.push(value);
                    } else if (value && typeof value === 'object') {
                        // 如果是对象，检查其属性
                        const objUrls = findUrlsInObject(value);
                        urls.push(...objUrls);
                    }
                } catch (e) {
                    // 忽略访问错误
                }
            }
        } catch (e) {
            console.log('检查全局变量时出错:', e);
        }

        return urls;
    }

    function findUrlsInObject(obj, depth = 0) {
        const urls = [];

        if (depth > 3) return urls; // 防止深度递归

        try {
            if (obj && typeof obj === 'object') {
                for (const key in obj) {
                    if (obj.hasOwnProperty(key)) {
                        const value = obj[key];
                        if (typeof value === 'string' && isM3u8Url(value)) {
                            urls.push(value);
                        } else if (typeof value === 'object' && value !== null) {
                            urls.push(...findUrlsInObject(value, depth + 1));
                        }
                    }
                }
            }
        } catch (e) {
            // 忽略访问错误
        }

        return urls;
    }

    // 全局存储拦截到的URL
    let interceptedUrls = [];

    // 尽早开始拦截网络请求
    function startNetworkInterception() {
        // 重写fetch
        if (window.fetch && !window.fetch._intercepted) {
            const originalFetch = window.fetch;
            window.fetch = function (...args) {
                const url = args[0];
                if (typeof url === 'string' && isM3u8Url(url)) {
                    console.log('拦截到fetch请求中的m3u8:', url);
                    interceptedUrls.push(url);
                }
                return originalFetch.apply(this, args);
            };
            window.fetch._intercepted = true;
        }

        // 重写XMLHttpRequest
        if (XMLHttpRequest.prototype.open && !XMLHttpRequest.prototype.open._intercepted) {
            const originalXHROpen = XMLHttpRequest.prototype.open;
            XMLHttpRequest.prototype.open = function (method, url, ...args) {
                if (typeof url === 'string' && isM3u8Url(url)) {
                    console.log('拦截到XHR请求中的m3u8:', url);
                    interceptedUrls.push(url);
                }
                return originalXHROpen.apply(this, [method, url, ...args]);
            };
            XMLHttpRequest.prototype.open._intercepted = true;
        }
    }

    // 获取后台脚本检测到的URL
    async function getUrlsFromBackground() {
        try {
            return new Promise((resolve) => {
                chrome.runtime.sendMessage({ action: 'getDetectedUrls' }, (response) => {
                    resolve(response.success ? response.urls : []);
                });
            });
        } catch (error) {
            console.log('获取后台URL失败:', error);
            return [];
        }
    }

    async function checkNetworkRequests() {
        // 延长等待时间到3秒，分阶段收集请求
        const collectedUrls = [];

        // 立即收集当前已拦截的请求
        collectedUrls.push(...interceptedUrls);

        // 等待1秒收集更多请求
        await new Promise(resolve => setTimeout(resolve, 1000));
        collectedUrls.push(...interceptedUrls);

        // 再等待2秒收集更多请求
        await new Promise(resolve => setTimeout(resolve, 2000));
        collectedUrls.push(...interceptedUrls);

        return [...new Set(collectedUrls)];
    }

    function extractVideoUrlsFromDocument(doc) {
        const videoUrls = [];

        // 检查video元素
        const videos = doc.querySelectorAll('video');
        for (const video of videos) {
            if (video.src && isM3u8Url(video.src)) {
                videoUrls.push(video.src);
            }
        }

        // 检查链接
        const links = doc.querySelectorAll('a[href]');
        for (const link of links) {
            if (isM3u8Url(link.href)) {
                videoUrls.push(link.href);
            }
        }

        return videoUrls;
    }

    // 立即开始网络拦截
    startNetworkInterception();

    // 页面加载完成后自动检测（带重试机制）
    function autoDetectWithRetry(retryCount = 0, maxRetries = 3) {
        if (retryCount >= maxRetries) {
            console.log('自动检测完成，重试次数:', retryCount);
            return;
        }

        const delay = retryCount === 0 ? 1000 : (retryCount + 1) * 2000;

        setTimeout(async () => {
            console.log(`第${retryCount + 1}次自动检测...`);
            const result = await detectVideoUrls();
            const count = result.success ? result.videoUrls.length : 0;

            if (result.success && count > 0) {
                // 向后台脚本发送消息，通知检测到视频，用于点亮图标
                chrome.runtime.sendMessage({
                    action: 'highlightIcon',
                    count: count
                });

                console.log(`第${retryCount + 1}次检测找到${result.videoUrls.length}个m3u8 URL`);
            } else {
                console.log(`第${retryCount + 1}次检测未找到m3u8 URL，继续重试...`);
                autoDetectWithRetry(retryCount + 1, maxRetries);
            }
        }, delay);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            autoDetectWithRetry();
        });
    } else {
        autoDetectWithRetry();
    }

    // 监听页面变化（动态加载的内容）
    const observer = new MutationObserver((mutations) => {
        let shouldCheck = false;

        mutations.forEach((mutation) => {
            if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
                // 检查新添加的节点是否包含video元素
                for (const node of mutation.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        if (node.tagName === 'VIDEO' || node.querySelector('video')) {
                            shouldCheck = true;
                            break;
                        }
                    }
                }
            }
        });

        if (shouldCheck) {
            setTimeout(detectVideoUrls, 500);
        }
    });

    observer.observe(document.body, {
        childList: true,
        subtree: true
    });

    console.log('Video Downloader 内容脚本已加载');
})();
