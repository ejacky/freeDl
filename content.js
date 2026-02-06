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

            // 获取后台脚本检测到的URL
            console.log('获取后台检测的URL...');
            const backgroundUrls = await getUrlsFromBackground();
            if (backgroundUrls.length > 0) {
                console.log('后台检测到m3u8:', backgroundUrls);
                videoUrls.push(...backgroundUrls);
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
