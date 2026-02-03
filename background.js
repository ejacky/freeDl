// background.js - Chrome扩展后台脚本
let progressPort = null;

chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'downloadProgress') {
        progressPort = port;
        port.onDisconnect.addListener(() => {
            progressPort = null;
        });
    }
});

// 存储检测到的m3u8 URL
const detectedUrls = new Map();

// 跟踪当前下载状态
let currentDownload = {
    isActive: false,
    startTime: null,
    tabId: null,
    url: null
};

// 保存当前下载进度信息
let currentProgress = {
    percentage: 0,
    current: 0,
    total: 0,
    message: '',
    lastUpdate: null
};

// 更全面的m3u8检测函数
function isM3u8Url(url) {
    if (!url || typeof url !== 'string') return false;

    // 检查是否包含.m3u8
    if (url.includes('.m3u8')) return true;

    // 检查是否是HLS流URL
    if (url.includes('m3u8') || url.includes('hls')) return true;

    // 检查常见的流媒体URL模式
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
        /\/master(\?|$)/i
    ];

    return hlsPatterns.some(pattern => pattern.test(url));
}

// 使用webRequest API监听网络请求
function setupWebRequestListener() {
    // 监听所有HTTP请求
    chrome.webRequest.onBeforeRequest.addListener(
        (details) => {
            if (isM3u8Url(details.url)) {
                console.log('检测到m3u8请求:', details.url);

                // 存储到对应标签页
                const tabId = details.tabId;
                if (tabId > 0) {
                    if (!detectedUrls.has(tabId)) {
                        detectedUrls.set(tabId, new Set());
                    }
                    detectedUrls.get(tabId).add(details.url);

                    // 发送消息给内容脚本
                    chrome.tabs.sendMessage(tabId, {
                        action: 'm3u8Detected',
                        url: details.url,
                        tabId: tabId,
                    }).catch(() => {
                        // 忽略内容脚本未加载的错误
                    });
                }
            }
        },
        { urls: ["<all_urls>"] },
        []
    );

    // 监听重定向，可能包含m3u8
    chrome.webRequest.onBeforeRedirect.addListener(
        (details) => {
            if (isM3u8Url(details.redirectUrl)) {
                console.log('检测到重定向到m3u8:', details.redirectUrl);

                const tabId = details.tabId;
                if (tabId > 0) {
                    if (!detectedUrls.has(tabId)) {
                        detectedUrls.set(tabId, new Set());
                    }
                    detectedUrls.get(tabId).add(details.redirectUrl);
                }
            }
        },
        { urls: ["<all_urls>"] },
        []
    );

    // 监听响应头，检查Content-Type
    chrome.webRequest.onHeadersReceived.addListener(
        (details) => {
            const contentType = details.responseHeaders?.find(
                header => header.name.toLowerCase() === 'content-type'
            )?.value;

            if (contentType && (
                contentType.includes('application/vnd.apple.mpegurl') ||
                contentType.includes('application/x-mpegURL') ||
                contentType.includes('vnd.apple.mpegurl')
            )) {
                console.log('根据Content-Type检测到m3u8:', details.url);

                const tabId = details.tabId;
                if (tabId > 0) {
                    if (!detectedUrls.has(tabId)) {
                        detectedUrls.set(tabId, new Set());
                    }
                    detectedUrls.get(tabId).add(details.url);
                }
            }
        },
        { urls: ["<all_urls>"] },
        ["responseHeaders"]
    );
}

// 使用debugger API进行更详细的网络监控
async function setupDebuggerListener(tabId) {
    try {
        await chrome.debugger.attach({ tabId }, "1.3");

        chrome.debugger.sendCommand({ tabId }, "Network.enable");

        chrome.debugger.onEvent.addListener((source, method, params) => {
            if (source.tabId === tabId) {
                if (method === "Network.responseReceived") {
                    const url = params.response.url;
                    const mimeType = params.response.mimeType;

                    if (isM3u8Url(url) ||
                        mimeType.includes('application/vnd.apple.mpegurl') ||
                        mimeType.includes('application/x-mpegURL')) {
                        console.log('Debugger检测到m3u8:', url);

                        if (!detectedUrls.has(tabId)) {
                            detectedUrls.set(tabId, new Set());
                        }
                        detectedUrls.get(tabId).add(url);
                    }
                }
            }
        });
    } catch (error) {
        console.log('无法附加debugger:', error);
    }
}

chrome.runtime.onInstalled.addListener(() => {
    console.log('Video Downloader 扩展已安装');
    setupWebRequestListener();
});

// 监听标签页关闭，清理相关数据
chrome.tabs.onRemoved.addListener((tabId) => {
    if (detectedUrls.has(tabId)) {
        detectedUrls.delete(tabId);
        console.log(`标签页 ${tabId} 已关闭，清理检测到的URL数据`);
    }
});


// 监听来自popup和内容脚本的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'downloadVideo') {
        handleDownloadRequest(message.url, message.downloadPath).then(result => {
            sendResponse(result);
        }).catch(error => {
            sendResponse({ success: false, error: error.message });
        });
        return true; // 保持消息通道开放
    }

    if (message.action === 'highlightIcon') {
        // 当检测到视频时点亮扩展图标
        const tabId = sender.tab?.id;
        if (tabId && message.count > 0) {
            // 点亮扩展图标 - 使用彩色图标或添加徽章
            chrome.action.setIcon({
                tabId: tabId,
                // 如果有彩色图标，可以在这里指定路径
                path: {
                    16: 'icons/icon-16-up.png',
                }
            });

            console.log(`标签页 ${tabId} 点亮图标，检测到 ${message.count} 个视频`);
        }
        sendResponse({ success: true });
        return true;
    }

    if (message.action === 'getDetectedUrls') {
        const tabId = sender.tab?.id;
        if (tabId && detectedUrls.has(tabId)) {
            sendResponse({
                success: true,
                urls: Array.from(detectedUrls.get(tabId))
            });
        } else {
            sendResponse({
                success: true,
                urls: []
            });
        }
        return true;
    }

    if (message.action === 'clearDetectedUrls') {
        const tabId = sender.tab?.id || message.tabId;
        if (tabId) {
            detectedUrls.delete(tabId);
            sendResponse({ success: true });
        }
        return true;
    }

    if (message.action === 'downloadM3U8') {
        downloadM3U8Video(message.m3u8Url, message.videoName)
            .then(() => sendResponse({ success: true }))
            .catch(error => sendResponse({ success: false, error: error.message }));
        return true;
    }

    if (message.action === 'checkDownloadStatus') {
        sendResponse({
            isDownloading: currentDownload.isActive,
            downloadId: null,
            currentProgress: currentProgress,
            downloadUrl: currentDownload.url
        });
        return true;
    }
});

async function downloadM3U8Video(m3u8Url, videoName) {
    // 检查是否已有下载在进行
    if (currentDownload.isActive) {
        console.warn('Download already in progress:', currentDownload.url);
        throw new Error('已有下载任务正在执行，请稍候再试');
    }

    // 设置下载状态
    currentDownload = {
        isActive: true,
        startTime: Date.now(),
        url: m3u8Url,
        tabId: null // 可以从 message 中获取
    };

    try {
        console.log('Downloading M3U8:', m3u8Url);

        // 首先检查文件大小
        const headResponse = await fetch(m3u8Url, { method: 'HEAD' });
        const contentLength = headResponse.headers.get('content-length');
        if (contentLength) {
            const sizeMB = parseInt(contentLength) / 1024 / 1024;
            console.log(`M3U8 playlist size: ${sizeMB.toFixed(2)}MB`);
        } else {
            console.log('M3U8 playlist size not available from headers');
        }

        const response = await fetch(m3u8Url);
        const m3u8Content = await response.text();

        console.log('M3U8 content received, length:', m3u8Content.length);

        const segmentUrls = parseM3U8(m3u8Content, m3u8Url);

        if (segmentUrls.length === 0) {
            throw new Error('No video segments found in M3U8 file');
        }

        console.log('Found segments:', segmentUrls.length);

        // 估算文件大小
        const estimatedSize = segmentUrls.length * 5 * 1024 * 1024; // 假设每个片段5MB
        console.log(`Estimated video size: ${(estimatedSize / 1024 / 1024).toFixed(2)}MB`);

        // 如果文件太大，警告用户
        if (estimatedSize > 500 * 1024 * 1024) { // 500MB
            console.warn(`Large file detected: ${(estimatedSize / 1024 / 1024).toFixed(2)}MB`);
            // 这里可以添加用户确认逻辑
        }

        // 设置下载选项 - 是否跳过失败的片段
        const FAIL_ON_ERROR = false; // 设置为true时，任何片段失败都会停止整个下载

        const videoBlob = await downloadSegments(segmentUrls, FAIL_ON_ERROR);

        const filename = `${videoName}.mp4`;

        //const blobUrl = await createBlobUrl(videoBlob);
        console.log('[DOWNLOAD] Video Blob size:', videoBlob.size, 'bytes');

        // 如果blob太大，使用流式下载
        if (videoBlob.size > 200 * 1024 * 1024) { // 200MB
            console.log('[DOWNLOAD] Large file, using stream download...');
            await downloadLargeFile(videoBlob, filename);
        } else {
            // 使用 FileReader 将 Blob 转换为 data URL
            console.log('[DOWNLOAD] Converting blob to data URL...');
            const blobUrl = await createBlobUrl(videoBlob);
            console.log('[DOWNLOAD] Blob URL created');

            await chrome.downloads.download({
                url: blobUrl,
                filename: filename,
                saveAs: false
            });
        }

    } catch (error) {
        console.error('M3U8 download error:', error);
        // Send error message through progress port
        if (progressPort) {
            progressPort.postMessage({
                type: 'error',
                error: error.message
            });
        }
        throw error; // 重新抛出错误
    } finally {
        // 重置下载状态
        currentDownload = {
            isActive: false,
            startTime: null,
            url: null,
            tabId: null
        };
    }
}

// 大文件流式下载
async function downloadLargeFile(blob, filename) {
    console.log('[DOWNLOAD] Processing large file, size:', blob.size, 'bytes');

    // 对于大文件，我们直接使用 FileReader 处理
    const dataUrl = await createBlobUrl(blob);

    await chrome.downloads.download({
        url: dataUrl,
        filename: filename,
        saveAs: false
    });
}

// 分段下载并合并，限制内存使用
async function downloadSegments(segmentUrls, failOnError = false) {
    const CHUNK_SIZE = 50 * 1024 * 1024; // 每次处理50MB
    const MAX_SEGMENTS_IN_MEMORY = 100;  // 内存中最多保持100个片段
    const CONCURRENT_DOWNLOADS = 3;     // 并发下载数
    let currentChunks = [];
    let totalSize = 0;
    let processedCount = 0;
    let failedIndices = new Set(); // 记录下载失败的索引

    // 使用临时数组存储分段
    const tempBlobs = [];

    // 分段并发下载，带错误处理
    for (let i = 0; i < segmentUrls.length; i += CONCURRENT_DOWNLOADS) {
        const batchPromises = [];
        const batchIndices = [];

        // 创建并发下载任务
        for (let j = 0; j < CONCURRENT_DOWNLOADS && i + j < segmentUrls.length; j++) {
            const index = i + j;
            batchIndices.push(index);
            batchPromises.push(downloadSegment(index, segmentUrls[index]));
        }

        // 等待批量下载完成
        const results = await Promise.allSettled(batchPromises);

        for (let k = 0; k < results.length; k++) {
            const result = results[k];
            const index = batchIndices[k];

            if (result.status === 'fulfilled') {
                const chunk = result.value;
                currentChunks.push(chunk);
                totalSize += chunk.byteLength;
                processedCount++;
            } else {
                console.error(`Segment ${index + 1} failed:`, result.reason);
                failedIndices.add(index);

                if (failOnError) {
                    // 如果设置了失败即停止，则抛出错误
                    throw new Error(`Segment ${index + 1} failed: ${result.reason.message}`);
                }

                // 发送错误信息但不停止下载
                if (progressPort) {
                    progressPort.postMessage({
                        type: 'error',
                        error: `Segment ${index + 1} failed: ${result.reason.message}`.slice(0, 100) // 限制长度
                    });
                }
            }
        }

        // 更新进度
        if (progressPort) {
            const percentage = Math.round((processedCount / segmentUrls.length) * 100);
            const message = {
                type: 'progress',
                percentage: percentage,
                current: processedCount,
                total: segmentUrls.length,
                message: `下载中... ${percentage}% (${processedCount}/${segmentUrls.length})`
            };
            progressPort.postMessage(message);

            // 保存当前进度状态
            currentProgress = {
                percentage: percentage,
                current: processedCount,
                total: segmentUrls.length,
                message: `下载中... ${percentage}%`,
                lastUpdate: Date.now()
            };
        }

        // 当达到内存限制时，合并当前chunks并创建临时blob
        if (currentChunks.length >= MAX_SEGMENTS_IN_MEMORY || totalSize >= CHUNK_SIZE || i + CONCURRENT_DOWNLOADS >= segmentUrls.length) {
            console.log(`Merging ${currentChunks.length} segments, size: ${(totalSize / 1024 / 1024).toFixed(2)}MB`);

            const combinedArray = new Uint8Array(totalSize);
            let offset = 0;
            for (const chunk of currentChunks) {
                combinedArray.set(new Uint8Array(chunk), offset);
                offset += chunk.byteLength;
            }

            tempBlobs.push(new Blob([combinedArray]));
            currentChunks = [];
            totalSize = 0;
        }

        // 定期保存进度
        if (processedCount % 10 === 0) {
            await saveDownloadProgress(processedCount);
        }
    }

    // 检查是否有失败的片段
    if (failedIndices.size > 0) {
        console.warn(`Total failed segments: ${failedIndices.size}/${segmentUrls.length}`);

        // 如果失败太多，抛出警告
        if (failedIndices.size > segmentUrls.length * 0.2) { // 超过20%失败
            throw new Error(`Too many segments failed (${failedIndices.size}/${segmentUrls.length})`);
        }

        // 提示用户有部分片段缺失
        if (progressPort) {
            progressPort.postMessage({
                type: 'error',
                error: `Warning: ${failedIndices.size} segments failed to download. Video may have gaps.`
            });
        }
    }

    // 发送最终进度更新
    if (progressPort) {
        progressPort.postMessage({
            type: 'progress',
            percentage: 100,
            current: processedCount,
            total: segmentUrls.length,
            message: failedIndices.size > 0 ?
                `下载完成！有 ${failedIndices.size} 个片段下载失败` :
                '下载完成！'
        });
    }

    // 合并所有临时blobs
    if (tempBlobs.length === 1) {
        return tempBlobs[0];
    } else {
        console.log(`Combining ${tempBlobs.length} blob parts...`);
        return new Blob(tempBlobs, { type: 'video/mp4' });
    }
}

// 下载单个片段，带重试机制
async function downloadSegment(index, url, retries = 3, timeout = 10000) {
    console.log(`Downloading segment ${index + 1}: ${url}`);

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            // 创建超时控制器
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeout);

            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'Range': 'bytes=0-' // 尝试获取完整内容
                }
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                const errorMsg = `HTTP ${response.status} for segment ${index + 1}`;
                console.error(errorMsg);

                if (response.status === 404 || response.status === 403) {
                    // 404和403错误不重试
                    throw new Error(errorMsg);
                }

                // 其他错误重试
                if (attempt < retries) {
                    console.log(`Retrying segment ${index + 1}, attempt ${attempt + 1}/${retries}`);
                    await new Promise(resolve => setTimeout(resolve, 2000 * attempt)); // 指数退避
                    continue;
                }

                throw new Error(errorMsg);
            }

            const data = await response.arrayBuffer();

            console.log(`Segment ${index + 1} downloaded successfully, size: ${data.byteLength} bytes`);

            // 验证下载的数据
            if (data.byteLength === 0) {
                throw new Error(`Segment ${index + 1} is empty`);
            }

            console.log(`Segment ${index + 1} completed, size: ${data.byteLength} bytes`);
            return data;

        } catch (error) {
            console.error(`Failed to download segment ${index + 1} on attempt ${attempt}:`, error);

            if (attempt >= retries) {
                throw new Error(`Failed after ${retries} attempts: ${error.message}`);
            }

            // 等待后重试
            await new Promise(resolve => setTimeout(resolve, 1000 * attempt));
        }
    }
}

function parseM3U8(content, baseUrl) {
    const lines = content.split('\n');
    const segments = [];
    let basePath = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);

    // 尝试从 baseUrl 获取域名
    let baseOrigin = '';
    try {
        const baseUrlObj = new URL(baseUrl);
        baseOrigin = baseUrlObj.origin;
    } catch (e) {
        console.warn('Invalid base URL:', baseUrl);
    }

    let currentSegmentLine = '';

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        // 处理相对路径的 #EXT-X-KEY
        if (line.startsWith('#EXT-X-KEY:')) {
            const uriMatch = line.match(/URI="([^"]+)"/);
            if (uriMatch && uriMatch[1] && !uriMatch[1].startsWith('http')) {
                console.warn('Encryption key might use relative path:', uriMatch[1]);
            }
        }

        if (line.startsWith('#EXTINF:')) {
            // 保存当前行的信息
            currentSegmentLine = line;
        } else if (line && !line.startsWith('#') && currentSegmentLine) {
            // 这是片段URL行
            let segmentUrl = line.trim();

            // 验证URL
            if (!segmentUrl || segmentUrl === '') {
                console.warn(`Empty segment URL at line ${i + 1}`);
                continue;
            }

            // 处理相对路径
            if (!segmentUrl.startsWith('http')) {
                if (segmentUrl.startsWith('/')) {
                    // 绝对路径
                    if (baseOrigin) {
                        segmentUrl = baseOrigin + segmentUrl;
                    } else {
                        // 如果没有 origin，尝试拼接
                        const match = baseUrl.match(/^(https?:\/\/[^\/]+)/);
                        if (match) {
                            segmentUrl = match[1] + segmentUrl;
                        } else {
                            segmentUrl = basePath + segmentUrl;
                        }
                    }
                } else if (segmentUrl.startsWith('../')) {
                    // 处理上级目录
                    const levels = (segmentUrl.match(/\.\.\//g) || []).length;
                    let newBasePath = basePath;
                    for (let l = 0; l < levels; l++) {
                        newBasePath = newBasePath.replace(/[^\/]*\/$/, '');
                    }
                    segmentUrl = newBasePath + segmentUrl.replace(/\.\.\//g, '');
                } else {
                    // 相对路径
                    segmentUrl = basePath + segmentUrl;
                }
            }

            // 验证最终URL
            try {
                new URL(segmentUrl);
                segments.push(segmentUrl);
                console.log(`Added segment ${segments.length}: ${segmentUrl}`);
            } catch (e) {
                console.error(`Invalid segment URL after processing: ${segmentUrl}`);
            }

            currentSegmentLine = '';
        }
    }

    // 如果没有找到片段，尝试其他可能的格式
    if (segments.length === 0) {
        console.warn('No segments found in standard format, trying alternative parsing...');

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();

            // 尝试查找任何不以 # 开头的非空行作为可能的片段URL
            if (line && !line.startsWith('#') && line.includes('.ts')) {
                let segmentUrl = line;

                if (!segmentUrl.startsWith('http')) {
                    segmentUrl = basePath + segmentUrl;
                }

                try {
                    new URL(segmentUrl);
                    segments.push(segmentUrl);
                    console.log(`Found alternative segment: ${segmentUrl}`);
                } catch (e) {
                    console.warn(`Invalid alternative segment URL: ${segmentUrl}`);
                }
            }
        }
    }

    if (segments.length === 0) {
        console.error('No valid segments found in M3U8 content');
        console.log('First 10 lines of M3U8 content:');
        console.log(lines.slice(0, 10).join('\n'));
    }

    return segments;
}

function createBlobUrl(blob) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = function (e) {
            resolve(e.target.result);
        };
        reader.readAsDataURL(blob);
    });
}

async function handleDownloadRequest(url, downloadPath) {
    try {
        // 这里可以添加与本地服务器的通信逻辑
        // 目前先返回成功状态，实际下载由本地服务器处理
        console.log('收到下载请求:', { url, downloadPath });

        chrome.downloads.download({
            url: url,             // 要下载的文件URL
            filename: downloadPath || "downloaded_file.txt", // 自定义文件名（可选）
            saveAs: false                 // 是否弹出"另存为"对话框
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                console.error("Download failed:", chrome.runtime.lastError.message);
            } else {
                console.log("Download started:", downloadId);
            }
        });

        return {
            success: true,
            message: '下载请求已发送到本地服务器'
        };
    } catch (error) {
        console.error('处理下载请求失败:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

// 添加下载状态管理
let downloadStates = new Map();

// 断点续传功能
async function downloadWithResume(segmentUrls, startIndex = 0) {
    const chunks = [];
    let failedSegments = [];

    for (let i = startIndex; i < segmentUrls.length; i++) {
        try {
            console.log(`Downloading segment ${i + 1}/${segmentUrls.length}`);

            // 检查是否已经下载过
            if (downloadStates.has(i)) {
                console.log(`Segment ${i} already downloaded, skipping...`);
                chunks.push(downloadStates.get(i));
                continue;
            }

            const response = await fetch(segmentUrls[i]);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} for segment ${i + 1}`);
            }

            const chunk = await response.arrayBuffer();
            chunks.push(chunk);

            // 保存已下载的片段到状态
            downloadStates.set(i, chunk);

        } catch (error) {
            console.error(`Failed to download segment ${i + 1}:`, error);
            failedSegments.push(i);

            // 跳过失败的片段继续下载
            continue;
        }

        // 定期保存进度
        if (i % 10 === 0) {
            saveDownloadProgress(i);
        }
    }

    return { chunks, failedSegments };
}

// 保存下载进度
async function saveDownloadProgress(lastIndex) {
    try {
        await chrome.storage.local.set({
            m3u8_download_progress: {
                lastIndex: lastIndex,
                timestamp: Date.now()
            }
        });
    } catch (error) {
        console.error('Failed to save download progress:', error);
    }
}

// 恢复下载进度
async function loadDownloadProgress() {
    try {
        const result = await chrome.storage.local.get('m3u8_download_progress');
        return result.m3u8_download_progress || null;
    } catch (error) {
        console.error('Failed to load download progress:', error);
        return null;
    }
}

// 处理扩展图标点击
chrome.action.onClicked.addListener((tab) => {
    console.log('扩展图标被点击，当前标签页:', tab.url);
});
