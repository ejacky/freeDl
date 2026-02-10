// offscreen.js - Offscreen document for stream-based file processing

// Download progress tracking
let downloadProgress = {
    processedSize: 0,
    totalSize: 0,
    lastReportedPercentage: 0
};

// Test handler
function handleTestConnection(message, sendResponse) {
    console.log('[OFFSCREEN] Received test connection request');
    try {
        chrome.runtime.sendMessage({
            action: 'testResponse',
            data: {
                timestamp: Date.now(),
                message: 'Offscreen document is alive and running'
            }
        });
        sendResponse({ success: true, message: 'Test acknowledged' });
    } catch (error) {
        console.error('[OFFSCREEN] Test response failed:', error);
        sendResponse({ success: false, error: error.message });
    }
}

// Initialize message listener
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    console.log('[OFFSCREEN] Received message:', message.action);

    switch (message.action) {
        case 'startStreamDownload':
            console.log('[OFFSCREEN] Starting stream download...');
            handleStreamDownload(message).then(result => {
                console.log('[OFFSCREEN] Stream download completed');
                sendResponse({ success: true, result });
            }).catch(error => {
                console.error('[OFFSCREEN] Stream download failed:', error);
                sendResponse({ success: false, error: error.message });
            });
            return true; // Keep message channel open for async response

        case 'cancelStreamDownload':
            handleCancelDownload().then(() => {
                sendResponse({ success: true });
            }).catch(error => {
                sendResponse({ success: false, error: error.message });
            });
            return true;

        case 'cleanupBlobUrls':
            handleCleanupBlobUrls(message.blobUrls);
            sendResponse({ success: true });
            return true;

        default:
            console.warn('[OFFSCREEN] Unknown action:', message.action);

            // Send response to prevent hanging
            sendResponse({ success: false, error: 'Unknown action' });
            return false;
    }

    // Prevent hanging if no case matched
    sendResponse({ success: false, error: 'No handler for message' });
});

// Test handler
function handleTestConnection(message, sendResponse) {
    console.log('[OFFSCREEN] Received test connection request');
    try {
        chrome.runtime.sendMessage({
            action: 'testResponse',
            data: {
                timestamp: Date.now(),
                message: 'Offscreen document is alive and running'
            }
        });
        sendResponse({ success: true, message: 'Test acknowledged' });
    } catch (error) {
        console.error('[OFFSCREEN] Test response failed:', error);
        sendResponse({ success: false, error: error.message });
    }
}

// Main stream download handler
async function handleStreamDownload(options) {
    const { segments, filename, estimatedSize } = options;

    // Validate inputs
    if (!segments || !Array.isArray(segments) || segments.length === 0) {
        throw new Error('No video segments provided');
    }

    if (!filename || typeof filename !== 'string') {
        throw new Error('Invalid filename provided');
    }

    console.log('[OFFSCREEN] Starting stream download:', {
        segmentCount: segments.length,
        filename,
        estimatedSize: estimatedSize || 'unknown'
    });

    try {
        // IMPORTANT: File picker must be triggered from popup context, not here
        // The filename should be provided from background script
        console.log('[OFFSCREEN] Starting stream download with pre-selected filename:', filename);

        // Note: We cannot use showSaveFilePicker here due to lack of user gesture
        // Alternative approach: Use blob streaming without file system

        // Initialize progress tracking before starting download
        downloadProgress = {
            processedSize: 0,
            totalSize: estimatedSize || segments.length * 5 * 1024 * 1024, // Assume 5MB per segment if unknown
            lastReportedPercentage: 0
        };

        return await handleStreamDownloadToBlob(segments, estimatedSize);

    } catch (error) {
        console.error('[OFFSCREEN] Stream download failed:', error);
        await cleanup();
        throw error;
    }
}

// Download single segment with retry logic
async function downloadSegmentWithRetry(url, index, retries) {
    console.log(`[OFFSCREEN] Downloading segment ${index + 1}: ${url}`);

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout

            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'Range': 'bytes=0-' // Try to get full content
                }
            });

            clearTimeout(timeoutId);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status} for segment ${index + 1}`);
            }

            const data = await response.blob();

            if (data.size === 0) {
                throw new Error(`Empty segment ${index + 1}`);
            }

            console.log(`[OFFSCREEN] Segment ${index + 1} downloaded: ${(data.size / 1024).toFixed(2)}KB`);
            return data;

        } catch (error) {
            console.error(`[OFFSCREEN] Segment ${index + 1} download attempt ${attempt} failed:`, error);

            if (attempt === retries) {
                throw new Error(`Failed to download segment ${index + 1} after ${retries} attempts: ${error.message}`);
            }

            // Exponential backoff
            await new Promise(resolve => setTimeout(resolve, 2000 * attempt));
        }
    }
}

// Report download progress
async function reportProgress(currentSegment, totalSegments, _bytesProcessed) {
    const percentage = Math.round((currentSegment + 1) / totalSegments * 100);

    // Throttle progress updates
    if (percentage !== downloadProgress.lastReportedPercentage && percentage % 5 === 0) {
        downloadProgress.lastReportedPercentage = percentage;

        console.log(`[OFFSCREEN] Progress: ${percentage}% (${currentSegment + 1}/${totalSegments})`);

        sendProgressUpdate({
            type: 'progress',
            percentage: percentage,
            current: currentSegment + 1,
            total: totalSegments,
            message: `下载中... ${percentage}% (${currentSegment + 1}/${totalSegments})`,
            estimatedSize: downloadProgress.totalSize,
            processedSize: downloadProgress.processedSize
        });
    }
}

// Send progress update to background script
function sendProgressUpdate(data) {
    try {
        // Use a port connection if available, otherwise sendMessage
        chrome.runtime.sendMessage({
            action: 'streamDownloadProgress',
            data: data
        }).catch(error => {
            console.warn('[OFFSCREEN] Failed to send progress update:', error);
        });
    } catch (error) {
        console.error('[OFFSCREEN] Error sending progress update:', error);
    }
}

// Cancel current download
async function handleCancelDownload() {
    console.log('[OFFSCREEN] Cancelling download...');
    // Just send cancellation message since we're not using file handles
    sendProgressUpdate({
        type: 'cancelled',
        message: '下载已取消'
    });
}

// Cleanup blob URLs
async function handleCleanupBlobUrls(blobUrls) {
    if (!blobUrls || !Array.isArray(blobUrls)) {
        return;
    }

    console.log('[OFFSCREEN] Cleaning up', blobUrls.length, 'blob URLs');

    for (const blobUrl of blobUrls) {
        try {
            URL.revokeObjectURL(blobUrl);
            console.log('[OFFSCREEN] Revoked blob URL:', blobUrl);
        } catch (error) {
            console.warn('[OFFSCREEN] Failed to revoke blob URL:', blobUrl, error);
        }
    }
}

// Error handler
window.addEventListener('error', (event) => {
    console.error('[OFFSCREEN] Global error:', event.error);

    // Try to notify background script
    try {
        chrome.runtime.sendMessage({
            action: 'streamDownloadProgress',
            data: {
                type: 'error',
                error: 'Download failed: ' + event.error.message
            }
        });
    } catch (error) {
        // Ignore if we can't send the message
    }
});

console.log('[OFFSCREEN] Offscreen document initialized');

// Stream download implementation that doesn't require user gesture
async function handleStreamDownloadToBlob(segments, estimatedSize) {
    console.log('[OFFSCREEN] Starting blob-based stream download without file picker');

    try {
        // Using a temp file approach with blob streaming
        let totalBytesProcessed = 0;
        const tempBlobs = [];
        let currentBlobSize = 0;
        let currentBlobData = [];
        const MAX_BLOB_SIZE = 100 * 1024 * 1024; // 100MB chunks

        // Download segments in batches
        const BATCH_SIZE = 5;

        for (let i = 0; i < segments.length; i += BATCH_SIZE) {
            const batchSegments = segments.slice(i, i + BATCH_SIZE);

            console.log(`[OFFSCREEN] Processing segments ${i + 1}-${Math.min(i + BATCH_SIZE, segments.length)}/${segments.length}`);

            const batchPromises = batchSegments.map((seg, idx) =>
                downloadSegmentWithRetry(seg, i + idx, 3)
            );

            const results = await Promise.allSettled(batchPromises);

            for (let j = 0; j < results.length; j++) {
                const result = results[j];
                if (result.status === 'fulfilled' && result.value) {
                    const data = result.value;

                    // Add to current blob if within size limit
                    if (currentBlobSize + data.size < MAX_BLOB_SIZE) {
                        currentBlobData.push(data);
                        currentBlobSize += data.size;
                    } else {
                        // Create a blob with existing data
                        tempBlobs.push(new Blob(currentBlobData, { type: 'video/mp4' }));

                        // Start new blob
                        currentBlobData = [data];
                        currentBlobSize = data.size;
                    }

                    totalBytesProcessed += data.size;

                    // Report progress
                    await reportBlobProgress(i + j, segments.length, totalBytesProcessed, estimatedSize);
                }
            }
        }

        // Add remaining data to final blob
        if (currentBlobData.length > 0) {
            tempBlobs.push(new Blob(currentBlobData, { type: 'video/mp4' }));
        }


        console.log("[OFFSCREEN] Downloaded into", tempBlobs.length, "blobs");
        const blobUrls = [];
        for (const blob of tempBlobs) {
            const blobUrl = URL.createObjectURL(blob);
            blobUrls.push(blobUrl);
        }

        console.log("[OFFSCREEN] Created blob URLs:", blobUrls.length);
        const finalBlob = new Blob(tempBlobs, { type: 'video/mp4' });
        const finalBlobUrl = URL.createObjectURL(finalBlob);
        console.log("[OFFSCREEN] Created final blob URL:", finalBlobUrl);


        // Report final status
        sendProgressUpdate({
            type: 'downloadComplete',
            totalSegments: segments.length,
            filename: 'temp_stream_' + Date.now(),
            totalSize: totalBytesProcessed,
            blobsCount: tempBlobs.length,
            blobUrls: blobUrls,
            finalBlobUrl: finalBlobUrl
        });

        return {
            success: true,
            totalSize: totalBytesProcessed,
            blobUrls: blobUrls,  // Return blob URLs instead of blobs
            finalBlobUrl: finalBlobUrl,
            filename: 'streamed_video.mp4'
        };

    } catch (error) {
        console.error("[OFFSCREEN] Stream download failed:", error);
        throw error;
    }
}

// Report progress for blob-based download
async function reportBlobProgress(currentSegment, totalSegments, totalBytesProcessed, estimatedSize) {
    const percentage = Math.min(100, Math.round(totalBytesProcessed / estimatedSize * 100));

    // Throttle progress updates
    if (percentage !== downloadProgress.lastReportedPercentage && percentage % 10 === 0) {
        downloadProgress.lastReportedPercentage = percentage;

        console.log(`[OFFSCREEN] Blob progress: ${percentage}% (${currentSegment + 1}/${totalSegments})`);

        sendProgressUpdate({
            type: 'progress',
            percentage: percentage,
            current: currentSegment + 1,
            total: totalSegments,
            message: `下载中... ${percentage}% (${currentSegment + 1}/${totalSegments})`,
            processedSize: totalBytesProcessed,
            totalSize: estimatedSize
        });
    }
}