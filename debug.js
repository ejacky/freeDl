// debug.js - 调试工具，帮助用户查看检测过程
(function() {
    'use strict';
    return;
    // 创建调试面板
    function createDebugPanel() {
        const debugPanel = document.createElement('div');
        debugPanel.id = 'video-downloader-debug';
        debugPanel.style.cssText = `
            position: fixed;
            top: 10px;
            right: 10px;
            width: 400px;
            max-height: 600px;
            background: #1e1e1e;
            color: #fff;
            font-family: 'Courier New', monospace;
            font-size: 12px;
            border: 1px solid #333;
            border-radius: 8px;
            z-index: 10000;
            box-shadow: 0 4px 20px rgba(0,0,0,0.5);
            overflow: hidden;
        `;

        debugPanel.innerHTML = `
            <div style="background: #333; padding: 10px; display: flex; justify-content: space-between; align-items: center;">
                <h3 style="margin: 0; color: #fff;">🎬 Video Downloader Debug</h3>
                <button id="debug-toggle" style="background: #666; color: #fff; border: none; padding: 5px 10px; border-radius: 4px; cursor: pointer;">收起</button>
            </div>
            <div id="debug-content" style="padding: 10px; max-height: 500px; overflow-y: auto;">
                <div id="debug-log"></div>
            </div>
        `;

        document.body.appendChild(debugPanel);

        // 绑定收起/展开功能
        const toggleBtn = debugPanel.querySelector('#debug-toggle');
        const content = debugPanel.querySelector('#debug-content');
        toggleBtn.addEventListener('click', () => {
            if (content.style.display === 'none') {
                content.style.display = 'block';
                toggleBtn.textContent = '收起';
            } else {
                content.style.display = 'none';
                toggleBtn.textContent = '展开';
            }
        });
    }

    // 添加日志
    function addLog(message, type = 'info') {
        const logContainer = document.querySelector('#debug-log');
        if (!logContainer) return;

        const timestamp = new Date().toLocaleTimeString();
        const logEntry = document.createElement('div');
        logEntry.style.cssText = `
            margin: 5px 0;
            padding: 5px;
            border-radius: 4px;
            border-left: 3px solid ${getTypeColor(type)};
            background: rgba(255,255,255,0.05);
        `;

        logEntry.innerHTML = `
            <span style="color: #888; font-size: 10px;">[${timestamp}]</span>
            <span style="color: ${getTypeColor(type)}; font-weight: bold;">[${type.toUpperCase()}]</span>
            <span>${message}</span>
        `;

        logContainer.appendChild(logEntry);
        logContainer.scrollTop = logContainer.scrollHeight;
    }

    function getTypeColor(type) {
        switch (type) {
            case 'success': return '#28a745';
            case 'error': return '#dc3545';
            case 'warning': return '#ffc107';
            case 'info': return '#17a2b8';
            default: return '#6c757d';
        }
    }

    // 检测页面中的所有m3u8相关URL
    function detectAllUrls() {
        addLog('开始全面检测页面中的m3u8 URL...', 'info');
        
        const urls = [];
        
        // 1. 检查所有链接
        const links = document.querySelectorAll('a[href]');
        addLog(`检查 ${links.length} 个链接`, 'info');
        links.forEach(link => {
            if (link.href.includes('.m3u8')) {
                urls.push(link.href);
                addLog(`找到链接: ${link.href}`, 'success');
            }
        });

        // 2. 检查所有script标签
        const scripts = document.querySelectorAll('script');
        addLog(`检查 ${scripts.length} 个script标签`, 'info');
        scripts.forEach((script, index) => {
            if (script.textContent && script.textContent.includes('.m3u8')) {
                const matches = script.textContent.match(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/gi);
                if (matches) {
                    matches.forEach(url => {
                        urls.push(url);
                        addLog(`找到script[${index}]中的URL: ${url}`, 'success');
                    });
                }
            }
        });

        // 3. 检查所有元素属性
        const elements = document.querySelectorAll('[src], [href], [data-src], [data-url], [data-stream], [data-video]');
        addLog(`检查 ${elements.length} 个元素属性`, 'info');
        elements.forEach(element => {
            const attrs = ['src', 'href', 'data-src', 'data-url', 'data-stream', 'data-video'];
            attrs.forEach(attr => {
                const value = element.getAttribute(attr);
                if (value && value.includes('.m3u8')) {
                    urls.push(value);
                    addLog(`找到属性 ${attr}: ${value}`, 'success');
                }
            });
        });

        // 4. 检查全局变量
        const globalVars = ['videoUrl', 'streamUrl', 'm3u8Url', 'hlsUrl', 'playlistUrl', 'sourceUrl'];
        addLog('检查全局变量', 'info');
        globalVars.forEach(varName => {
            try {
                const value = window[varName];
                if (value && typeof value === 'string' && value.includes('.m3u8')) {
                    urls.push(value);
                    addLog(`找到全局变量 ${varName}: ${value}`, 'success');
                }
            } catch (e) {
                // 忽略
            }
        });

        // 5. 检查存储
        addLog('检查localStorage和sessionStorage', 'info');
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                const value = localStorage.getItem(key);
                if (value && value.includes('.m3u8')) {
                    urls.push(value);
                    addLog(`找到localStorage[${key}]: ${value}`, 'success');
                }
            }
            
            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                const value = sessionStorage.getItem(key);
                if (value && value.includes('.m3u8')) {
                    urls.push(value);
                    addLog(`找到sessionStorage[${key}]: ${value}`, 'success');
                }
            }
        } catch (e) {
            addLog('无法访问存储: ' + e.message, 'error');
        }

        const uniqueUrls = [...new Set(urls)];
        addLog(`检测完成，共找到 ${uniqueUrls.length} 个唯一的m3u8 URL`, 'success');
        
        // 显示所有找到的URL
        uniqueUrls.forEach((url, index) => {
            addLog(`URL ${index + 1}: ${url}`, 'info');
        });

        return uniqueUrls;
    }

    // 添加手动检测按钮
    function addManualDetectButton() {
        const debugContent = document.querySelector('#debug-content');
        if (!debugContent) return;

        const button = document.createElement('button');
        button.textContent = '🔍 手动检测';
        button.style.cssText = `
            background: #28a745;
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 4px;
            cursor: pointer;
            margin: 10px 0;
            width: 100%;
        `;

        button.addEventListener('click', () => {
            detectAllUrls();
        });

        debugContent.insertBefore(button, debugContent.firstChild);
    }

    // 初始化调试面板
    function initDebugPanel() {
        if (document.querySelector('#video-downloader-debug')) {
            return; // 已存在
        }

        createDebugPanel();
        addManualDetectButton();
        addLog('调试面板已启动', 'success');
        addLog('页面URL: ' + window.location.href, 'info');
        
        // 自动检测一次
        setTimeout(() => {
            detectAllUrls();
        }, 1000);
    }

    // 页面加载完成后初始化
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initDebugPanel);
    } else {
        initDebugPanel();
    }

    // 暴露到全局，方便手动调用
    window.videoDownloaderDebug = {
        addLog,
        detectAllUrls,
        initDebugPanel
    };

    console.log('Video Downloader Debug 工具已加载');
    console.log('使用 window.videoDownloaderDebug.detectAllUrls() 手动检测');
})();
