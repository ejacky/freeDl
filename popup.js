// popup.js - Chrome扩展弹窗脚本
document.addEventListener('DOMContentLoaded', async function () {
    const statusDiv = document.getElementById('status');
    const videoInfoDiv = document.getElementById('videoInfo');
    const videoUrlDiv = document.getElementById('videoUrl');
    const downloadBtn = document.getElementById('downloadBtn');
    const progressContainer = document.getElementById('progressContainer');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    const manualDetectLink = document.getElementById('manualDetectLink');
    const serverUrlInput = document.getElementById('serverUrl');
    const downloadPathInput = document.getElementById('downloadPath');
    // const manualDetectBtn = document.getElementById('manualDetectBtn'); // Commented out - not used

    let currentVideoUrl = null;
    // let downloadProgress = null; // Commented out - not used
    let progressPort = null;

    // 下载状态控制
    let isDownloading = false; // 跟踪下载状态
    let currentDownloadId = null; // 当前下载任务ID
    let downloadStartTime = null; // 下载开始时间
    let initialProgress = null; // 初始进度信息

    // 数据列表
    let allVideoUrls = []; // 存储所有检测到的视频列表
    let filteredVideoUrls = []; // 存储过滤后的列表

    // 初始化过滤复选框
    const filterCheckbox = document.getElementById('filterNoDuration');

    // 连接进度端口
    connectProgressPort();

    // 检测当前页面的视频
    await detectVideo();

    // 绑定事件（改为绑定页脚链接）
    downloadBtn.addEventListener('click', startDownload);
    manualDetectLink.addEventListener('click', manualDetect);

    function connectProgressPort() {
        try {
            progressPort = chrome.runtime.connect({ name: 'downloadProgress' });
            progressPort.onMessage.addListener((message) => {
                if (message.type === 'progress') {
                    const percentage = message.percentage || 0;
                    const text = message.message || `下载中... ${percentage}% (${message.current || 0}/${message.total || 0})`;
                    updateProgress(percentage, text);
                    isDownloading = percentage < 100;

                    // 如果下载完成，重置状态
                    if (percentage >= 100) {
                        setTimeout(() => {
                            isDownloading = false;
                            currentDownloadId = null;
                        }, 3000);
                    }
                } else if (message.type === 'error') {
                    showStatus('下载失败: ' + message.error, 'error');
                    downloadBtn.disabled = false;
                    progressContainer.classList.add('hidden');

                    // 下载失败时重置状态
                    isDownloading = false;
                    currentDownloadId = null;
                }
            });

            progressPort.onDisconnect.addListener(() => {
                progressPort = null;
                // Try to reconnect after a delay
                setTimeout(() => {
                    if (!progressPort) {
                        connectProgressPort();
                    }
                }, 1000);
            });
        } catch (error) {
            console.error('Failed to connect progress port:', error);
        }

        // 弹出窗口时检查是否有正在进行的下载
        chrome.runtime.sendMessage({ action: 'checkDownloadStatus' }, (response) => {
            if (response && response.isDownloading) {
                showStatus('检测到正在进行的下载，请稍候或等待下载完成', 'info');
                isDownloading = true;

                // 如果有当前进度，立即显示
                if (response.currentProgress && response.currentProgress.percentage > 0) {
                    currentDownloadId = null; // 为了简化，不保存 ID
                    const progress = response.currentProgress;
                    progressContainer.classList.remove('hidden');
                    updateProgress(progress.percentage, progress.message);
                }
            }
        });
    }

    // 优化后的视频检测主流程
    async function detectVideo(action = 'quickDetectVideo') {
        showStatus('正在检测页面中的视频...', 'info');

        try {
            const tab = await getActiveTab();
            await ensureContentScriptInjected(tab.id);

            const response = await chrome.tabs.sendMessage(tab.id, { action, tabId: tab.id });
            processDetectionResponse(response);
        } catch (error) {
            console.error('检测视频失败:', error);
            showStatus('检测视频失败: ' + error.message, 'error');
        }
    }

    // 获取当前活动标签页
    async function getActiveTab() {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        console.log("all active tabs:" + tabs)
        const tab = tabs && tabs[0];
        if (!tab || !tab.id) {
            throw new Error('未找到活动标签页');
        }
        return tab;
    }

    // 保证 content.js 已注入（含轻量级缓存）
    async function ensureContentScriptInjected(tabId) {
        const injectionKey = `content_script_injected_${tabId}`;
        const alreadyInjected = sessionStorage.getItem(injectionKey);

        if (alreadyInjected) {
            console.log('content.js already injected');
            return;
        }

        try {
            await chrome.tabs.sendMessage(tabId, { action: 'ping' });
            console.log('content.js exists, marking as injected...');
            sessionStorage.setItem(injectionKey, 'true');
        } catch (err) {
            console.warn('content.js not found, injecting now...');
            await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
            sessionStorage.setItem(injectionKey, 'true');
        }
    }

    // 统一处理检测结果并更新 UI
    function processDetectionResponse(response) {
        if (!response || !response.success) {
            showStatus('检测视频时出错: ' + (response?.error || '未知错误'), 'error');
            return;
        }

        const videoUrlsOrgin = Array.isArray(response.videoUrls) ? response.videoUrls : [];
        if (videoUrlsOrgin.length === 0) {
            showStatus('未检测到视频链接', 'error');
            return;
        }

        // 展示所有候选 URL

        const validVideoUrls = videoUrlsOrgin.filter(v => {
            if (typeof v === 'object') {
                const d = v.duration;
                return d && d !== '未知';
            }
            return false;
        });
        console.log('validVideoUrls:', validVideoUrls);
        showAllVideoUrls(validVideoUrls);

        // 优先选择 m3u8，否则退回第一个链接
        const preferred = validVideoUrls.find(item => {
            const url = typeof item === 'object' ? item.url : item;
            return url && url.includes('.m3u8');
        }) ?? videoUrlsOrgin[0];

        currentVideoUrl = typeof preferred === 'object' ? preferred.url : preferred;

        if (currentVideoUrl && currentVideoUrl.includes('.m3u8')) {
            showStatus('找到m3u8视频链接！', 'success');
        } else {
            showStatus('找到视频链接，但不是m3u8格式', 'warning');
        }
        downloadBtn.disabled = false;
    }

    async function manualDetect(e) {
        e?.preventDefault();

        const originalText = manualDetectLink.textContent;
        manualDetectLink.textContent = '检测中...';
        manualDetectLink.style.pointerEvents = 'none';

        showStatus('正在重新检测页面中的视频...', 'info');
        videoInfoDiv.classList.add('hidden');
        downloadBtn.disabled = true;
        currentVideoUrl = null;

        // 稍作延迟，有利于收集网络拦截数据
        await new Promise(resolve => setTimeout(resolve, 1000));
        await detectVideo('detectVideo');

        manualDetectLink.textContent = originalText;
        manualDetectLink.style.pointerEvents = 'auto';
    }

    function showStatus(message, type) {
        statusDiv.textContent = message;
        statusDiv.className = `status ${type}`;
        statusDiv.classList.remove('hidden');
    }

    async function startDownload() {
        if (!currentVideoUrl) {
            showStatus('没有可下载的视频链接', 'error');
            return;
        }

        // 检查是否已有下载在进行
        if (isDownloading) {
            showStatus('当前已有下载任务在进行中，请稍候...', 'warning');
            return;
        }

        try {
            isDownloading = true;
            currentDownloadId = Date.now();
            downloadStartTime = Date.now();

            downloadBtn.disabled = true;
            progressContainer.classList.remove('hidden');
            showStatus('正在准备下载...', 'info');

            // 检查当前标签页状态
            const tab = await getActiveTab();

            // 初始化下载参数
            const videoName = await getDefaultVideoName() || `video_${Date.now()}`;

            // 尝试初始化离线存储（如果需要）
            try {
                const initResponse = await chrome.runtime.sendMessage({
                    action: 'initializeDownload',
                    m3u8Url: currentVideoUrl,
                    tabId: tab.id
                });

                if (initResponse && !initResponse.success && initResponse.error) {
                    console.warn('Download initialization warning:', initResponse.error);
                }
            } catch (initError) {
                console.warn('Failed to initialize download context:', initError);
                // Continue anyway - downloads might work without initialization
            }

            // 添加额外的检查 - 验证URL是否有效
            if (!currentVideoUrl.startsWith('http')) {
                throw new Error('无效的视频链接格式');
            }

            const response = await chrome.runtime.sendMessage({
                action: 'downloadM3U8',
                m3u8Url: currentVideoUrl,
                videoName: videoName,
                tabId: tab.id
            });

            if (!response.success) {
                throw new Error(response.error || 'Download failed');
            }

            showStatus('下载已开始！', 'success');
            // Progress will be handled by the port connection
        } catch (error) {
            console.error('启动下载失败:', error);
            showStatus('启动下载失败: ' + error.message, 'error');
            downloadBtn.disabled = false;

            // 重置下载状态
            isDownloading = false;
            currentDownloadId = null;
            downloadStartTime = null;
            progressContainer.classList.add('hidden');

        }
    }

    async function getDefaultVideoName() {
        try {
            const tab = await getActiveTab();
            const tabTitle = (tab.title || '').trim();
            if (tabTitle) return sanitizeFileName(tabTitle);

            const [{ result }] = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                    const metas = Array.from(document.querySelectorAll('meta'));
                    const getContent = el => (el?.getAttribute('content') || '').trim();
                    const byName = name => metas.find(m => (m.getAttribute('name') || '').toLowerCase() === name);
                    const byProp = prop => metas.find(m => (m.getAttribute('property') || '').toLowerCase() === prop);
                    const byItem = item => metas.find(m => (m.getAttribute('itemprop') || '').toLowerCase() === item);

                    const titleCandidates = [
                        (document.title || '').trim(),
                        getContent(byProp('og:title')),
                        getContent(byName('twitter:title')),
                        getContent(byName('title')),
                        getContent(byProp('twitter:title')),
                        getContent(byItem('name')),
                        getContent(byProp('og:video:title')),
                        getContent(byName('video:title'))
                    ].filter(Boolean);

                    return titleCandidates[0] || '';
                }
            });

            if (result && result.trim()) {
                return sanitizeFileName(result.trim());
            }
        } catch (e) { }

        return `video_${Date.now()}`;
    }

    function updateProgress(percentage, text) {
        // 确保是当前有效的下载进度
        if (!isDownloading || percentage < 0 || percentage > 100) {
            return;
        }

        progressFill.style.width = `${percentage}%`;
        progressText.textContent = text;

        const percentageEl = document.getElementById('progressPercentage');
        if (percentageEl) {
            percentageEl.textContent = `${Math.round(percentage)}%`;
        }

        if (percentage === 100) {
            showStatus('下载完成！', 'success');
            downloadBtn.disabled = false;

            // 清空下载状态
            isDownloading = false;
            currentDownloadId = null;
            downloadStartTime = null;

            // 3秒后隐藏进度条
            setTimeout(() => {
                progressContainer.classList.add('hidden');
            }, 3000);
        }
    }

    // 监听来自后台脚本的消息
    chrome.runtime.onMessage.addListener((message) => {
        if (message.action === 'downloadProgress') {
            const progress = message.progress;
            updateProgress(progress.percentage, progress.text);
        } else if (message.action === 'downloadComplete') {
            showStatus('下载完成！', 'success');
            downloadBtn.disabled = false;
        } else if (message.action === 'downloadError') {
            let errorText = '下载失败: ' + message.error;
            if (message.help) {
                errorText += ' ' + message.help;
            }
            showStatus(errorText, 'error');
            downloadBtn.disabled = false;
        } else if (message.action === 'fallbackDownload') {
            // Handle fallback download message
            console.log('Received fallback download request');
            showStatus('下载遇到问题，使用备用方法...', 'warning');
            // Progress fill will show 100% for fallback
            updateProgress(100, '下载可能需要手动处理');

            // Auto-reset after showing fallback status
            setTimeout(() => {
                isDownloading = false;
                currentDownloadId = null;
                downloadBtn.disabled = false;
                progressContainer.classList.add('hidden');
            }, 3000);
        }
    });

    // 添加一个新函数来显示所有视频URL
    function showAllVideoUrls(validVideoUrls) {
        const videoUrlContainer = videoUrlDiv;
        videoUrlContainer.innerHTML = '';

        const countEl = document.getElementById('videoCountText');
        if (countEl) countEl.textContent = `共 ${validVideoUrls.length} 条`;

        if (validVideoUrls.length === 0) {
            videoUrlContainer.textContent = '未检测到视频链接';
            return;
        }

        // 默认选中第一个 m3u8，否则选第一个
        let defaultIndex = validVideoUrls.findIndex(v => {
            const u = typeof v === 'object' ? v.url : v;
            return u && u.includes('.m3u8');
        });
        if (defaultIndex < 0) defaultIndex = 0;

        const urlList = document.createElement('div');
        urlList.className = 'url-list';

        validVideoUrls.forEach((video, index) => {
            const url = typeof video === 'object' ? video.url : video;
            const duration = typeof video === 'object' ? video.duration : null;

            const urlItem = document.createElement('div');
            urlItem.className = 'url-item';
            urlItem.dataset.url = url;

            const urlNumber = document.createElement('span');
            urlNumber.className = 'url-number';
            urlNumber.textContent = `${index + 1}.`;
            urlItem.appendChild(urlNumber);

            const urlTextContainer = document.createElement('div');
            urlTextContainer.className = 'url-text-container';
            urlTextContainer.style.flex = '1';

            const urlText = document.createElement('div');
            urlText.className = 'url-text';
            urlText.textContent = truncateUrl(url, 60);
            urlText.style.marginBottom = '2px';
            urlTextContainer.appendChild(urlText);

            if (duration && duration !== '未知') {
                const durationText = document.createElement('div');
                durationText.className = 'video-duration';
                durationText.textContent = `时长: ${duration}`;
                durationText.style.fontSize = '11px';
                durationText.style.color = '#666';
                durationText.style.fontWeight = '500';
                urlTextContainer.appendChild(durationText);
            }

            urlItem.appendChild(urlTextContainer);

            const urlType = document.createElement('span');
            urlType.className = 'url-type';
            urlType.textContent = url && url.includes('.m3u8') ? 'm3u8' : '其他';
            urlItem.appendChild(urlType);

            // 点击选择事件：更新选中样式、预览卡、下载按钮
            urlItem.addEventListener('click', () => {
                currentVideoUrl = url;
                document.querySelectorAll('.url-item').forEach(item => item.classList.remove('selected'));
                urlItem.classList.add('selected');
                showStatus(`已选择视频链接 #${index + 1}${duration ? ` (${duration})` : ''}`, 'success');

                updateSelectedPreview(url, duration);
                downloadBtn.disabled = false;
            });

            // 默认选中项（优先 m3u8）
            if (index === defaultIndex) {
                urlItem.classList.add('selected');
            }

            urlList.appendChild(urlItem);
        });

        videoInfoDiv.classList.remove('hidden');
        videoUrlContainer.classList.add('hidden');
        videoInfoDiv.appendChild(urlList);

        // 初始化预览卡和当前选择
        const defaultVideo = validVideoUrls[defaultIndex];
        const defaultUrl = typeof defaultVideo === 'object' ? defaultVideo.url : defaultVideo;
        const defaultDuration = typeof defaultVideo === 'object' ? defaultVideo.duration : null;
        currentVideoUrl = defaultUrl;
        updateSelectedPreview(defaultUrl, defaultDuration);
        downloadBtn.disabled = false;
    }

    // 已选择视频预览卡更新
    function updateSelectedPreview(url, duration) {
        const preview = document.getElementById('selectedPreview');
        const urlEl = document.getElementById('selectedUrl');
        const typeEl = document.getElementById('selectedTypeBadge');
        const durationEl = document.getElementById('selectedDuration');
        const copyBtn = document.getElementById('copySelectedBtn');
        const openBtn = document.getElementById('openSelectedBtn');

        if (!preview || !urlEl || !typeEl || !copyBtn || !openBtn) return;

        preview.classList.remove('hidden');
        urlEl.textContent = truncateUrl(url, 100);
        typeEl.textContent = url.includes('.m3u8') ? 'm3u8' : '其他';
        durationEl.textContent = duration ? `时长: ${duration}` : '';

        copyBtn.onclick = async () => {
            try {
                await navigator.clipboard.writeText(url);
                showStatus('链接已复制', 'success');
            } catch (e) {
                showStatus('复制失败，请手动复制', 'error');
            }
        };
        openBtn.onclick = () => {
            try {
                chrome.tabs.create({ url, active: false });
            } catch (e) {
                showStatus('无法打开新标签', 'error');
            }
        };
    }
});

// 辅助函数：截断URL
function truncateUrl(url, maxLength) {
    if (url.length <= maxLength) return url;
    return url.substring(0, maxLength - 3) + '...';
}

function sanitizeFileName(name) {
    return name.replace(/[\\:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// Test stream download button
const testStreamBtn = document.getElementById('testStreamBtn');
const debugInfo = document.getElementById('debugInfo');

if (testStreamBtn) {
    testStreamBtn.addEventListener('click', async () => {
        try {
            console.log('[POPUP] Testing stream download...');
            debugInfo.textContent = 'Testing stream download...';

            // Send test message to background
            chrome.runtime.sendMessage({ action: 'testStreamDownload' }, response => {
                console.log('[POPUP] Test response:', response);
                debugInfo.textContent = response ? JSON.stringify(response, null, 2) : 'No response';
            });
        } catch (error) {
            console.error('[POPUP] Test failed:', error);
            debugInfo.textContent = 'Error: ' + error.message;
        }
    });
}