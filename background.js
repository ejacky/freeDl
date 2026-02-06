// background.js - Chrome扩展后台脚本
let progressPort = null;
let offscreenDocument = null;

// Offscreen document management functions
async function getOrCreateOffscreenDocument() {
    if (offscreenDocument) {
        return offscreenDocument;
    }

    try {
        const existingContexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
            documentUrls: [chrome.runtime.getURL('offscreen.html')]
        });

        if (existingContexts.length > 0) {
            offscreenDocument = existingContexts[0];
            return offscreenDocument;
        }

        const created = await chrome.offscreen.createDocument({
            url: 'offscreen.html',
            reasons: ['BLOBS'],
            justification: 'Download large files with stream processing to avoid memory limitations'
        });

        offscreenDocument = created;
        return offscreenDocument;
    } catch (error) {
        console.error('[BACKGROUND] Failed to create offscreen document:', error);
        throw error;
    }
}

async function closeOffscreenDocument() {
    if (offscreenDocument) {
        try {
            await chrome.offscreen.closeDocument();
            offscreenDocument = null;
            console.log('[BACKGROUND] Offscreen document closed');
        } catch (error) {
            console.warn('[BACKGROUND] Error closing offscreen document:', error);
        }
    }
}

// 存储检测到的m3u8 URL
const detectedUrls = new Map();

// Connection for progress updates
progressPort = null;

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

    if (message.action === 'initializeDownload') {
        initializeDownloadContext(message.m3u8Url, message.tabId).then(result => {
            sendResponse(result);
        }).catch(error => {
            sendResponse({ success: false, error: error.message });
        });
        return true;
    }

    if (message.action === 'downloadM3U8') {
        downloadM3U8Video(message.m3u8Url, message.videoName, message.tabId)
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

    if (message.action === 'testStreamDownload') {
        console.log('[BACKGROUND] Received test stream download request');
        runStreamDownloadTest().then(result => {
            sendResponse(result);
        }).catch(error => {
            sendResponse({ success: false, error: error.message });
        });
        return true;
    }

    if (message.action === 'getOfflineCache') {
        getOfflineCacheData(message.url, message.tabId).then(result => {
            sendResponse(result);
        }).catch(error => {
            sendResponse({ success: false, error: error.message });
        });
        return true;
    }
});

async function downloadM3U8Video(m3u8Url, videoName, tabId) {
    // 检查是否已有下载在进行
    if (currentDownload.isActive) {
        console.warn('Download already in progress:', currentDownload.url);
        throw new Error('已有下载任务正在执行，请稍候再试');
    }

    // 设置下载状态 - include tabId for better error handling
    currentDownload = {
        isActive: true,
        startTime: Date.now(),
        url: m3u8Url,
        tabId: tabId
    };

    try {
        console.log('Downloading M3U8:', m3u8Url);

        // Enhanced offline mode handling
        let m3u8Content = null;
        let offlineModeAvailable = false;

        // First try to get offline cache if available
        //if (tabId) {
        if (false) {
            try {
                const offlineData = await getOfflineCacheData(m3u8Url, tabId);
                if (offlineData.success && offlineData.data) {
                    console.log('[DOWNLOAD] Using offline cached content');
                    m3u8Content = offlineData.data.content;
                    offlineModeAvailable = true;
                }
            } catch (offlineError) {
                console.warn('[DOWNLOAD] Failed to retrieve offline cache:', offlineError);
            }
        }

        // If no offline content, fetch normally
        if (!m3u8Content) {
            // 增强的连接检查 - 多个方法尝试获取内容
            let fetchError = null;

            // 方法1: 正常获取
            try {
                const response = await fetch(m3u8Url, {
                    method: 'GET',
                    signal: AbortSignal.timeout(30000),
                    credentials: 'omit',
                    cache: 'no-cache'
                });

                if (response.ok) {
                    m3u8Content = await response.text();
                } else if (response.status === 404 || response.status === 403) {
                    throw new Error(`M3U8文件访问受限 (HTTP ${response.status})`);
                } else {
                    fetchError = `HTTP ${response.status}`;
                }
            } catch (error) {
                console.log('[DOWNLOAD] Standard fetch failed:', error.message);
                fetchError = error;
            }

            // 如果标准获取失败，尝试作为离线内容处理
            if (!m3u8Content) {
                console.log('[DOWNLOAD] Trying offline fallback mode...');

                // 检查是否是本地文件或离线内容
                if (m3u8Url.includes('blob:') || m3u8Url.includes('data:')) {
                    // 尝试解析已存在的blob/data URL
                    try {
                        if (m3u8Url.startsWith('blob:')) {
                            const response = await fetch(m3u8Url);
                            m3u8Content = await response.text();
                        }
                    } catch (error) {
                        console.error('[DOWNLOAD] Failed to read blob/data URL:', error);
                    }
                }
            }

            // 如果仍然失败，抛出详细错误
            if (!m3u8Content) {
                throw new Error(`无法获取M3U8内容: ${fetchError?.message || fetchError || '网络连接失败'}`);
            }
        }

        console.log('M3U8 content received, length:', m3u8Content.length);

        const segmentUrls = parseM3U8(m3u8Content, m3u8Url);

        if (segmentUrls.length === 0) {
            throw new Error('No video segments found in M3U8 file. The file might be encrypted or use an unsupported format.');
        }

        console.log('Found segments:', segmentUrls.length);

        // 估算文件大小
        const estimatedSize = segmentUrls.length * 5 * 1024 * 1024; // 假设每个片段5MB
        console.log(`Estimated video size: ${(estimatedSize / 1024 / 1024).toFixed(2)}MB`);

        const filename = `${videoName}.mp4`;

        // 对于大文件或离线模式，使用增强的流式下载
        if (segmentUrls.length > 50 || offlineModeAvailable || estimatedSize > 300 * 1024 * 1024) {
            console.log(`[DOWNLOAD] Using enhanced download (large: ${segmentUrls.length > 50}, offline: ${offlineModeAvailable}, estimated size: ${estimatedSize})`);

            try {
                await downloadM3U8WithStream(segmentUrls, filename, estimatedSize);
                return; // Exit after successful stream download
            } catch (streamError) {
                console.error('[DOWNLOAD] Stream download failed, falling back to traditional download:', streamError);
                // Continue with traditional download as fallback
            }
        }

        // 对于小文件使用传统方法，但增强错误处理
        console.log('[DOWNLOAD] Using traditional blob-based download...');

        // 设置下载选项 - 更宽容的错误处理
        const FAIL_ON_ERROR = false; // 设置为false，允许跳过失败的片段

        let videoBlob = null;
        try {
            videoBlob = await downloadSegments(segmentUrls, FAIL_ON_ERROR);
        } catch (segmentError) {
            console.error('[DOWNLOAD] Failed to download segments:', segmentError);
            throw new Error(`无法下载视频片段: ${segmentError.message}`);
        }

        if (!videoBlob || videoBlob.size === 0) {
            throw new Error('下载结果为空，可能是因为所有片段都下载失败了');
        }

        console.log('[DOWNLOAD] Video Blob size:', videoBlob.size, 'bytes');

        // 使用 FileReader 将 Blob 转换为 data URL
        console.log('[DOWNLOAD] Converting blob to data URL...');
        let blobUrl = null;
        try {
            blobUrl = await createBlobUrl(videoBlob);
            console.log('[DOWNLOAD] Blob URL created successfully');
        } catch (blobUrlError) {
            console.error('[DOWNLOAD] Failed to create blob URL:', blobUrlError);
            throw new Error('无法创建下载链接');
        }

        // 开始下载
        try {
            const downloadId = await chrome.downloads.download({
                url: blobUrl,
                filename: filename,
                saveAs: false,
                conflictAction: 'uniquify'
            });

            if (downloadId) {
                console.log('[DOWNLOAD] Download started with ID:', downloadId);
            }
        } catch (downloadError) {
            console.error('[DOWNLOAD] Chrome download failed:', downloadError);
            // 如果Chrome下载失败，尝试使用备用方法
            handleDownloadErrorFallback(blobUrl, filename, downloadError);
        }

    } catch (error) {
        console.error('M3U8 download error:', error);
        sendErrorToUser(error.message);
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

// Stream-based M3U8 download using offscreen document
async function downloadM3U8WithStream(segmentUrls, filename, estimatedSize) {
    console.log('[BACKGROUND] Starting stream-based M3U8 download...');

    try {
        // Get or create offscreen document
        await getOrCreateOffscreenDocument();
        console.log('[BACKGROUND] Offscreen document ready');

        // Wait a moment to ensure offscreen is fully loaded
        await new Promise(resolve => setTimeout(resolve, 100));
        console.log('[BACKGROUND] Offscreen document initialized, sending download request');

        // Send download request to offscreen document and wait for result
        console.log('[BACKGROUND] Setting up message listener and sending request');

        try {
            const result = await new Promise((resolve, reject) => {
                // Set up one-time message listener for the result
                const messageListener = (message, sender) => {
                    if (message.action === 'streamDownloadProgress' && sender.id === chrome.runtime.id) {
                        if (message.data.type === 'downloadComplete') {
                            chrome.runtime.onMessage.removeListener(messageListener);
                            // Filter out blobs as they cannot be transferred via chrome messages
                            resolve({ finalBlobUrl: message.data.finalBlobUrl, blobUrls: message.data.blobUrls, totalSize: message.data.totalSize });
                        } else if (message.data.type === 'progress') {
                            // Forward progress to popup
                            if (progressPort) {
                                progressPort.postMessage(message.data);
                            }
                        } else if (message.data.type === 'error') {
                            chrome.runtime.onMessage.removeListener(messageListener);
                            reject(new Error(message.data.error));
                        } else if (message.data.type === 'cancelled') {
                            chrome.runtime.onMessage.removeListener(messageListener);
                            resolve({ cancelled: true });
                        }
                        // Return true to indicate we handled this message
                        return true;
                    } else {
                        // Not our message type
                        console.log('[BACKGROUND] Ignoring message:', message);
                        return false;
                    }
                };

                chrome.runtime.onMessage.addListener(messageListener);

                // Send download request to offscreen document
                console.log('[BACKGROUND] Sending message to offscreen document...');

                chrome.runtime.sendMessage({
                    action: 'startStreamDownload',
                    segments: segmentUrls,
                    filename: filename,
                    estimatedSize: estimatedSize
                });

                // Errors will bubble up via the promise reject

                // Timeout after 30 minutes for very large files
                setTimeout(() => {
                    chrome.runtime.onMessage.removeListener(messageListener);
                    reject(new Error('Download timeout - operation took too long'));
                }, 30 * 60 * 1000);
            });

            if (result.cancelled) {
                throw new Error('Download was cancelled');
            }

            console.log('[BACKGROUND] Stream download completed successfully, received', result.blobs?.length || '0', 'blobs');


            // Cache the segments for offline mode if this is the first successful download
            if (result.blobUrls && result.blobUrls.length > 0) {
                try {
                    // Only cache if this wasn't from offline cache already
                    if (currentDownload && currentDownload.url && !currentDownload.url.includes('offline')) {
                        await createOfflineCache(currentDownload.url, currentDownload.tabId, 'streamed_content', segmentUrls);
                    }
                } catch (cacheError) {
                    console.warn('[BACKGROUND] Failed to cache for offline mode:', cacheError);
                }
            }

            // Download each blob as a part or merge them
            await downloadBlobUrlsAsParts(result.finalBlobUrl, result.blobUrls, filename);

            console.log('[BACKGROUND] All blobs downloaded successfully');
            return result;

        } catch (error) {
            console.error('[BACKGROUND] Stream download error:', error);
            console.error('[BACKGROUND] Error details:', {
                message: error.message,
                stack: error.stack
            });
            throw error;
        }
    } catch (error) {
        console.error('[BACKGROUND] Stream download error:', error);
        throw error;
    }
}

// 下载多个blob URLs作为部分文件
async function downloadBlobUrlsAsParts(finalBlobUrl, blobUrls, filename) {
    console.log('[BACKGROUND] Downloading', blobUrls.length, 'blob URL parts for file:', filename);

    if (!finalBlobUrl && (!blobUrls || blobUrls.length === 0)) {
        throw new Error('No final blob URL or blob URLs to download');
    }

    let cleanupBoblUrls = [...(blobUrls || [])];
    if (finalBlobUrl) cleanupBoblUrls.unshift(finalBlobUrl);

    // 多个blobs，需要下载后合并或使用多部分下载
    try {
        // 下载最终blob URL
        console.log('[BACKGROUND] Downloading final blob URL...');

        await chrome.downloads.download({
            url: finalBlobUrl,
            filename: filename,
            saveAs: false
        });


        // Request cleanup of blob URLs after successful download
        requestBlobUrlCleanup(cleanupBoblUrls);

        console.log('[BACKGROUND] Successfully downloaded merged file:', filename);
    } catch (error) {
        console.error('[BACKGROUND] Failed to merge and download blobs:', error);

        // 如果合并失败，尝试分别下载每个部分
        console.log('[BACKGROUND] Falling back to individual part downloads...');
        for (let i = 0; i < blobUrls.length; i++) {
            const partFilename = filename.replace(/\.mp4$/, `.part${i + 1}.mp4`);

            try {
                await chrome.downloads.download({
                    url: blobUrls[i],
                    filename: partFilename,
                    saveAs: false
                });
                console.log(`[BACKGROUND] Downloaded part ${i + 1}/${blobUrls.length}: ${partFilename}`);
            } catch (downloadError) {
                console.error(`[BACKGROUND] Failed to download part ${i + 1}:`, downloadError);
                // Still cleanup on error, but re-throw
                requestBlobUrlCleanup(cleanupBoblUrls);
                throw downloadError;
            }
        }

        // Cleanup after successful separate downloads
        requestBlobUrlCleanup(cleanupBoblUrls);
    }
}

// Request cleanup of blob URLs from offscreen document
async function requestBlobUrlCleanup(cleanupBoblUrls) {
    try {
        // Send message to offscreen to cleanup blob URLs
        chrome.runtime.sendMessage({
            action: 'cleanupBlobUrls',
            blobUrls: cleanupBoblUrls
        }).catch(error => {
            console.warn('[BACKGROUND] Failed to request blob URL cleanup:', error);
        });
    } catch (error) {
        console.warn('[BACKGROUND] Error requesting blob URL cleanup:', error);
    }
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
    // Use FileReader to convert blob to data URL
    return new Promise((resolve, reject) => {
        try {
            const reader = new FileReader();

            reader.onload = function (e) {
                try {
                    resolve(e.target.result);
                } catch (error) {
                    console.error('[BACKGROUND] Error in FileReader onload:', error);
                    reject(error);
                }
            };

            reader.onerror = function (error) {
                console.error('[BACKGROUND] FileReader error:', error);
                reject(new Error('Failed to read blob data'));
            };

            reader.readAsDataURL(blob);
        } catch (error) {
            console.error('[BACKGROUND] Failed to create FileReader:', error);
            reject(error);
        }
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
// Add function to initialize download context and prepare for offline downloads
async function initializeDownloadContext(m3u8Url, tabId) {
    try {
        console.log('[BACKGROUND] Initializing download context for:', m3u8Url);

        // 1. Validate the URL
        if (!m3u8Url || typeof m3u8Url !== 'string' || !m3u8Url.startsWith('http')) {
            throw new Error('Invalid M3U8 URL');
        }

        // 2. Try to pre-fetch playlist to ensure accessibility
        try {
            const response = await fetch(m3u8Url, {
                method: 'HEAD',
                signal: AbortSignal.timeout(10000) // 10 second timeout
            });
            if (!response.ok) {
                console.warn('[BACKGROUND] M3U8 URL check failed:', response.status);
            }
        } catch (fetchError) {
            console.warn('[BACKGROUND] Cannot verify M3U8 URL accessibility:', fetchError.message);
            // Don't fail - continue anyway as it might work
        }

        // 3. Ensure we have URL data cached for this tab
        if (tabId && !detectedUrls.has(tabId)) {
            // Add the URL to our cache
            detectedUrls.set(tabId, new Set([m3u8Url]));
            console.log('[BACKGROUND] Cached M3U8 URL for tab', tabId);
        }

        // 4. Prepare offscreen document if needed (for large files)
        try {
            await getOrCreateOffscreenDocument();
            console.log('[BACKGROUND] Offscreen document ready');
        } catch (offscreenError) {
            console.warn('[BACKGROUND] Failed to prepare offscreen document:', offscreenError.message);
            // Don't fail - traditional download might still work
        }

        // 5. Ensure blob URL support is initialized
        initializeBlobSupport();

        return {
            success: true,
            message: 'Download context initialized successfully'
        };

    } catch (error) {
        console.error('[BACKGROUND] Failed to initialize download context:', error);
        return {
            success: false,
            error: error.message,
            message: 'Download context initialized with warnings' // Don't fail completely
        };
    }
}

// Helper to initialize blob URL support
function initializeBlobSupport() {
    // This ensures createBlobUrl function is ready
    console.log('[BACKGROUND] Blob support initialized');
}

// Add function to get offline cache data if available
async function getOfflineCacheData(url, tabId) {
    try {
        console.log('[BACKGROUND] Checking offline cache for:', url);

        // Check if we have cached segments for this URL
        const offlineCache = await chrome.storage.local.get(`offline_${tabId}_${btoa(url)}`);
        const cacheKey = `offline_${tabId}_${btoa(url)}`;

        if (offlineCache[cacheKey]) {
            console.log('[BACKGROUND] Found offline cache with', offlineCache[cacheKey].segments.length, 'segments');
            return {
                success: true,
                data: offlineCache[cacheKey]
            };
        }

        return {
            success: false,
            message: 'No offline cache found'
        };

    } catch (error) {
        console.error('[BACKGROUND] Failed to check offline cache:', error);
        return {
            success: false,
            error: error.message
        };
    }
}

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

// Fallback download handler when Chrome downloads API fails
async function handleDownloadErrorFallback(blobUrl, filename, originalError) {
    console.log('[BACKGROUND] Attempting fallback download method...');

    try {
        // Send message to popup to initiate a fallback download
        chrome.runtime.sendMessage({
            action: 'fallbackDownload',
            blobUrl: blobUrl,
            filename: filename,
            error: originalError.message
        }).catch(error => {
            console.error('[BACKGROUND] Failed to send fallback download message:', error);
        });

        // Also try to open the blob URL in a new tab
        if (confirm('视频下载遇到问题。要在新标签页中打开视频吗？\n\n注意：这可能无法保证完整保存。')) {
            chrome.tabs.create({ url: blobUrl, active: false }).catch(() => {
                console.error('[BACKGROUND] Failed to open blob in new tab');
            });
        }

    } catch (fallbackError) {
        console.error('[BACKGROUND] Fallback download failed:', fallbackError);
        throw new Error(`下载失败: ${originalError.message} | 备用方法也未成功`);
    }
}

// Send detailed error information to the user
function sendErrorToUser(errorMessage) {
    // Send error through progress port if available
    if (progressPort) {
        progressPort.postMessage({
            type: 'error',
            error: errorMessage,
            help: '请检查网络连接，或尝试刷新页面后重试。'
        });
    }

    // Also send to popup as a message
    chrome.runtime.sendMessage({
        action: 'downloadError',
        error: errorMessage,
        help: '检查网络或重试'
    }).catch(() => {
        // Ignore if popup is not open
    });
}

// 处理扩展图标点击
chrome.action.onClicked.addListener((tab) => {
    console.log('扩展图标被点击，当前标签页:', tab.url);
});

// Create an offline cache for downloaded content
async function createOfflineCache(m3u8Url, tabId, content, segments) {
    try {
        const cacheKey = `offline_${tabId}_${btoa(m3u8Url)}`;
        const timestamp = Date.now();

        const cacheData = {
            url: m3u8Url,
            content: content,
            segments: segments,
            timestamp: timestamp,
            segmentCount: segments.length
        };

        // Store the cache
        const cacheObject = {};
        cacheObject[cacheKey] = cacheData;

        await chrome.storage.local.set(cacheObject);

        console.log('[BACKGROUND] Created offline cache with', segments.length, 'segments');

        // Also cache the original content for reference
        const contentKey = `content_${tabId}_${btoa(m3u8Url)}`;
        const contentCache = {};
        contentCache[contentKey] = {
            content: content,
            timestamp: timestamp
        };

        await chrome.storage.local.set(contentCache);

        // Limit cache size - only keep last 5
        await cleanupOldestCacheEntries(5);

        return true;

    } catch (error) {
        console.error('[BACKGROUND] Failed to create offline cache:', error);
        return false;
    }
}

// Cleanup old cache entries
async function cleanupOldestCacheEntries(maxEntries = 5) {
    try {
        const allData = await chrome.storage.local.get(null);
        const cacheEntries = [];

        // Find all offline cache entries
        for (const key in allData) {
            if (key.startsWith('offline_') && allData[key].timestamp) {
                cacheEntries.push({
                    key: key,
                    timestamp: allData[key].timestamp,
                    url: allData[key].url
                });
            }
        }

        // Sort by timestamp (oldest first)
        cacheEntries.sort((a, b) => a.timestamp - b.timestamp);

        // Remove entries beyond max
        if (cacheEntries.length > maxEntries) {
            const toRemove = cacheEntries.slice(0, cacheEntries.length - maxEntries);
            const removeKeys = toRemove.map(entry => entry.key);

            // Also remove corresponding content entries
            const contentKeys = toRemove.map(entry => entry.key.replace('offline_', 'content_'));
            removeKeys.push(...contentKeys);

            await chrome.storage.local.remove(removeKeys);

            console.log('[BACKGROUND] Cleaned up', toRemove.length, 'old cache entries');
        }

    } catch (error) {
        console.error('[BACKGROUND] Failed to cleanup cache entries:', error);
    }
}

// Clean up on extension suspend
chrome.runtime.onSuspend.addListener(() => {
    console.log('[BACKGROUND] Extension suspending, cleaning up...');
    closeOffscreenDocument();
});

// Handle extension shutdown
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'update') {
        console.log('[BACKGROUND] Extension updated, cleaning up old resources...');
        closeOffscreenDocument();
    }
});

// Handle connections for progress updates
chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'downloadProgress') {
        progressPort = port;

        port.onMessage.addListener((message) => {
            // Handle any specific messages from popup
            console.log('[BACKGROUND] Received from popup:', message);
        });

        port.onDisconnect.addListener(() => {
            progressPort = null;
            console.log('[BACKGROUND] Progress port disconnected');
        });

        console.log('[BACKGROUND] Progress port connected');
    }
});

// Helper to safely send progress updates
function sendProgressUpdate(type, data) {
    if (progressPort) {
        try {
            progressPort.postMessage({
                type: type,
                ...data
            });
        } catch (error) {
            console.warn('[BACKGROUND] Failed to send progress update:', error);
            progressPort = null;
        }
    }

    // Also try sending as direct message for compatibility
    chrome.runtime.sendMessage({
        action: 'downloadProgress',
        progress: {
            type: type,
            ...data
        }
    }).catch(() => {
        // Ignore if popup is not open
    });
}

async function runStreamDownloadTest() {
    // Simple test without complex messaging - we'll use the actual stream download flow
    console.log('[BACKGROUND] Running stream download test');

    // Create test data
    const testSegments = [
        'https://example.com/segment1.ts',
        'https://example.com/segment2.ts',
        'https://example.com/segment3.ts'
    ];

    try {
        await getOrCreateOffscreenDocument();
        console.log('[BACKGROUND] Offscreen document ready for test');

        // Let's try the actual stream download with test data
        await downloadM3U8WithStream(testSegments, 'test_video.mp4', 15000000);

        return { success: true, message: 'Stream download test completed' };
    } catch (error) {
        console.error('[BACKGROUND] Stream test error:', error);
        return { success: false, error: error.message };
    }
}
