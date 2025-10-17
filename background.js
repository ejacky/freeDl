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

        // 清除标签页的徽章和图标状态
        // chrome.action.setBadgeText({
        //     tabId: tabId,
        //     text: ''
        // });

        // 恢复默认图标（如果有必要）
        // chrome.action.setIcon({
        //     tabId: tabId,
        //     path: {
        //         16: 'icons/icon16.png',
        //         48: 'icons/icon48.png',
        //         128: 'icons/icon128.png'
        //     }
        // });
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
});

async function downloadM3U8Video(m3u8Url, videoName) {
    try {
        console.log('Downloading M3U8:', m3u8Url);

        const response = await fetch(m3u8Url);
        const m3u8Content = await response.text();

        console.log('M3U8 content received, length:', m3u8Content.length);

        const segmentUrls = parseM3U8(m3u8Content, m3u8Url);

        if (segmentUrls.length === 0) {
            throw new Error('No video segments found in M3U8 file');
        }

        console.log('Found segments:', segmentUrls.length);

        const videoBlob = await downloadSegments(segmentUrls);

        const filename = `${videoName}.mp4`;

        const blobUrl = await createBlobUrl(videoBlob);

        await chrome.downloads.download({
            url: blobUrl,
            filename: filename,
            saveAs: false
        });

        // Send completion message
        // if (progressPort) {
        //     progressPort.postMessage({
        //         type: 'progress',
        //         percentage: 100,
        //         current: segmentUrls.length,
        //         total: segmentUrls.length,
        //         message: '下载完成！'
        //     });
        // }

        // Data URLs don't need revocation

    } catch (error) {
        console.error('M3U8 download error:', error);
        // Send error message through progress port
        if (progressPort) {
            progressPort.postMessage({
                type: 'error',
                error: error.message
            });
        }
        throw new Error('Failed to download M3U8 video: ' + error.message);
    }
}

async function downloadSegments(segmentUrls) {
    const chunks = [];

    for (let i = 0; i < segmentUrls.length; i++) {
        try {
            console.log(`Downloading segment ${i + 1}/${segmentUrls.length}`);

            // Send progress update
            if (progressPort) {
                const percentage = Math.round((i / segmentUrls.length) * 100);
                progressPort.postMessage({
                    type: 'progress',
                    percentage: percentage,
                    current: i,
                    total: segmentUrls.length
                });
            }

            const response = await fetch(segmentUrls[i]);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} for segment ${i + 1}`);
            }

            const chunk = await response.arrayBuffer();
            chunks.push(chunk);

        } catch (error) {
            console.error(`Failed to download segment ${i + 1}:`, error);
            throw new Error(`Segment download failed at ${i + 1}/${segmentUrls.length}`);
        }
    }

    // Send final progress update
    if (progressPort) {
        progressPort.postMessage({
            type: 'progress',
            percentage: 100,
            current: segmentUrls.length,
            total: segmentUrls.length
        });
    }

    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
    const combinedArray = new Uint8Array(totalLength);

    let offset = 0;
    for (const chunk of chunks) {
        combinedArray.set(new Uint8Array(chunk), offset);
        offset += chunk.byteLength;
    }

    return new Blob([combinedArray], { type: 'video/mp4' });
}

function parseM3U8(content, baseUrl) {
    const lines = content.split('\n');
    const segments = [];
    let basePath = baseUrl.substring(0, baseUrl.lastIndexOf('/') + 1);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (line.startsWith('#EXTINF:')) {
            const nextLine = lines[i + 1];
            if (nextLine && !nextLine.startsWith('#')) {
                let segmentUrl = nextLine.trim();

                if (!segmentUrl.startsWith('http')) {
                    if (segmentUrl.startsWith('/')) {
                        const baseUrlObj = new URL(baseUrl);
                        segmentUrl = baseUrlObj.origin + segmentUrl;
                    } else {
                        segmentUrl = basePath + segmentUrl;
                    }
                }

                segments.push(segmentUrl);
            }
        }
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
            url: message.url,             // 要下载的文件URL
            filename: message.filename || "downloaded_file.txt", // 自定义文件名（可选）
            saveAs: false                 // 是否弹出“另存为”对话框
        }, (downloadId) => {
            if (chrome.runtime.lastError) {
                console.error("Download failed:", chrome.runtime.lastError.message);
                sendResponse({ ok: false, error: chrome.runtime.lastError.message });
            } else {
                console.log("Download started:", downloadId);
                sendResponse({ ok: true, id: downloadId });
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

// 监听标签页更新，用于检测页面变化
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete' && tab.url) {
        // 页面加载完成，可以通知内容脚本进行检测
        console.log('页面加载完成:', tab.url);
    }
});

// 处理扩展图标点击
chrome.action.onClicked.addListener((tab) => {
    console.log('扩展图标被点击，当前标签页:', tab.url);
});
