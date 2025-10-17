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
    const manualDetectBtn = document.getElementById('manualDetectBtn');

    let currentVideoUrl = null;
    let downloadProgress = null;
    let progressPort = null;

    // 连接进度端口
    connectProgressPort();

    // 检测当前页面的视频
    await detectVideo();

    // 绑定事件（改为绑定页脚链接）
    downloadBtn.addEventListener('click', startDownload);
    manualDetectLink.addEventListener('click', manualDetect);
    // 移除与设置相关的事件绑定（serverUrlInput/downloadPathInput）
    serverUrlInput.addEventListener('change', saveSettings);
    downloadPathInput.addEventListener('change', saveSettings);

    // 取消设置功能：将相关函数置空（如仍有引用可安全无效化）
    async function loadSettings() {}
    async function saveSettings() {}

    function connectProgressPort() {
        try {
            progressPort = chrome.runtime.connect({ name: 'downloadProgress' });
            progressPort.onMessage.addListener((message) => {
                if (message.type === 'progress') {
                    const percentage = message.percentage || 0;
                    const text = message.message || `下载中... ${percentage}% (${message.current || 0}/${message.total || 0})`;
                    updateProgress(percentage, text);
                } else if (message.type === 'error') {
                    showStatus('下载失败: ' + message.error, 'error');
                    downloadBtn.disabled = false;
                    progressContainer.classList.add('hidden');
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

        const videoUrls = Array.isArray(response.videoUrls) ? response.videoUrls : [];
        if (videoUrls.length === 0) {
            showStatus('未检测到视频链接', 'error');
            return;
        }

        // 展示所有候选 URL
        showAllVideoUrls(videoUrls);

        // 优先选择 m3u8，否则退回第一个链接
        const preferred = videoUrls.find(item => {
            const url = typeof item === 'object' ? item.url : item;
            return url && url.includes('.m3u8');
        }) ?? videoUrls[0];

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

        try {
            downloadBtn.disabled = true;
            progressContainer.classList.remove('hidden');
            showStatus('正在启动下载...', 'info');

            const response = await chrome.runtime.sendMessage({
                action: 'downloadM3U8',
                m3u8Url: currentVideoUrl,
                videoName: `video_${Date.now()}`
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
        }
    }

    function updateProgress(percentage, text) {
        progressFill.style.width = `${percentage}%`;
        progressText.textContent = text;

        const percentageEl = document.getElementById('progressPercentage');
        if (percentageEl) {
            percentageEl.textContent = `${Math.round(percentage)}%`;
        }

        if (percentage === 100) {
            showStatus('下载完成！', 'success');
            downloadBtn.disabled = false;
        }
    }

    // 监听来自后台脚本的消息
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        if (message.action === 'downloadProgress') {
            const progress = message.progress;
            updateProgress(progress.percentage, progress.text);
        } else if (message.action === 'downloadComplete') {
            showStatus('下载完成！', 'success');
            downloadBtn.disabled = false;
        } else if (message.action === 'downloadError') {
            showStatus('下载失败: ' + message.error, 'error');
            downloadBtn.disabled = false;
        }
    });

    // 添加一个新函数来显示所有视频URL
    function showAllVideoUrls(videoUrls) {
        const videoUrlContainer = videoUrlDiv;
        videoUrlContainer.innerHTML = '';

        // 计数显示
        const countEl = document.getElementById('videoCountText');
        if (countEl) countEl.textContent = `共 ${videoUrls.length} 条`;

        if (videoUrls.length === 0) {
            videoUrlContainer.textContent = '未检测到视频链接';
            return;
        }

        // 默认选中第一个 m3u8，否则选第一个
        let defaultIndex = videoUrls.findIndex(v => {
            const u = typeof v === 'object' ? v.url : v;
            return u && u.includes('.m3u8');
        });
        if (defaultIndex < 0) defaultIndex = 0;

        const urlList = document.createElement('div');
        urlList.className = 'url-list';

        videoUrls.forEach((video, index) => {
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
        const defaultVideo = videoUrls[defaultIndex];
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
