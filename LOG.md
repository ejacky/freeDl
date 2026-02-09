# Development Log

## [2026-02-06] Fixed offline download functionality

### Issues Fixed:

1. **Offline Download Initialization**
   - Added `initializeDownloadContext()` function to properly prepare downloads
   - Pre-fetches playlist headers to verify accessibility
   - Ensures URL data is cached for the tab
   - Prepares offscreen document for large files

2. **Blob Preparation Improvements**
   - Enhanced error handling in `createBlobUrl()` function
   - Added proper error catching for FileReader operations
   - Improved fallback mechanisms when blob creation fails

3. **Error Handling for Offline Mode**
   - Added `handleDownloadErrorFallback()` for when Chrome downloads API fails
   - Implements a fallback method that can open blob URLs in new tabs
   - Enhanced error messages with helpful guidance for users
   - Added `sendErrorToUser()` function for detailed error reporting

4. **Offline Cache System**
   - Added `createOfflineCache()` to cache downloaded segments
   - Implemented cache cleanup to prevent storage bloat
   - Cache is checked before attempting fresh downloads
   - Stops double-caching of already offline content

5. **Enhanced Download Flow**
   - Updated `downloadM3U8Video()` to handle offline content
   - Added multiple fetch strategies for different scenarios
   - Better handling of blob/data URLs
   - Improved progress reporting and error propagation

6. **Progress Communication**
   - Fixed progress port connection handling
   - Added safe progress update functions
   - Enhanced error reporting between background and popup
   - Added fallback download message handling

### Key Changes:

- **background.js**: Added offline cache system, initialization functions, enhanced error handling
- **popup.js**: Added download initialization calls, fallback handling, improved error display
- **offscreen.js**: No changes needed (stream download logic was already working)

### Testing Recommendations:

1. Test downloads with stable internet connection
2. Test downloads with slow/poor connection
3. Test downloads after disconnecting from internet (using cached content)
4. Verify error messages are helpful
5. Check that progress updates flow correctly
6. Confirm large file downloads use stream method

### Technical Notes:

- The extension now caches successful downloads for offline use
- Downloads have multiple fallback strategies for reliability
- Error messages are more descriptive and user-friendly
- The offline mode works transparently without user intervention
- Cache is automatically managed to prevent storage issues

[2026-02-09] 改造: 在 background 脚本加载时调用 setupWebRequestListener，使浏览器重启后也能注册 webRequest 监听 (background.js)

[2026-02-09] 修复: 用 chrome.storage.session 持久化 detectedUrls，解决 SW 休眠后打开 popup 有时无数据的问题；getDetectedUrls 无内存时从 session 恢复 (background.js)