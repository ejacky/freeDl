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
        if (message.action === 'detectVideo') {
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


    async function detectVideoUrls() {
        try {
            console.log('开始检测页面中的m3u8 URL...');

            // 获取后台脚本检测到的URL
            console.log('获取后台检测的URL...');
            const backgroundUrls = await getUrlsFromBackground();
            console.log('[context] getUrlsFromBackground: ' + backgroundUrls)
            return {
                success: true,
                videos: backgroundUrls,
                count: backgroundUrls.length
            };

        } catch (error) {
            console.error('检测视频URL时出错:', error);
            return {
                success: false,
                error: error.message
            };
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
            const count = result.success ? result.videos.length : 0;

            if (result.success && count > 0) {
                // 向后台脚本发送消息，通知检测到视频，用于点亮图标
                chrome.runtime.sendMessage({
                    action: 'highlightIcon',
                    count: count
                });

                console.log(`第${retryCount + 1}次检测找到${result.videos.length}个m3u8 URL`);
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
