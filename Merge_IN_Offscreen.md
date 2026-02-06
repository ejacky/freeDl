offscreen.js 不要把下载和合并操作交还给 background.js 

 请分析核心逻辑 offscreen.js 的第 239 行改为  const data = await response.Blob(); 然后在 405行添加 const finalBlob = new        
  Blob(tmpBlobs, { type: 'video/mp4' });                                                                                           
  const url = URL.createObjectURL(finalBlob);   
  chrome.downloads.download({
      url: downloadUrl,
      filename: message.filename
    }, () => {
      // 下载交给系统后，清理内存
      setTimeout(() => {
        URL.revokeObjectURL(downloadUrl);
        chrome.runtime.sendMessage({ type: 'DOWNLOAD_STARTED' });
      }, 10000);
    });