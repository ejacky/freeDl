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
        return await handleStreamDownloadToBlob(segments, estimatedSize);
        downloadProgress = {
            processedSize: 0,
            totalSize: estimatedSize || segments.length * 5 * 1024 * 1024, // Assume 5MB per segment if unknown
            lastReportedPercentage: 0
        };

        console.log('[OFFSCREEN] File handle acquired, starting download...');

        // Download segments in batches to control memory usage

        let batchStart = 0;
        let failedSegments = [];
        let totalProcessedSegments = 0;

        while (batchStart < segments.length) {
            // Process segments in batches
            const batchEnd = Math.min(batchStart + 10, segments.length);
            const batchSegments = segments.slice(batchStart, batchEnd);

            console.log(`[OFFSCREEN] Processing batch ${batchStart + 1}-${batchEnd}/${segments.length}`);

            // Download batch segments concurrently
            const batchPromises = [];
            for (let i = 0; i < batchSegments.length; i++) {
                const segmentIndex = batchStart + i;
                batchPromises.push(downloadSegmentWithRetry(batchSegments[i], segmentIndex, 3));
            }

            const results = await Promise.allSettled(batchPromises);

            // Process results and write to file
            let batchProcessedSegments = 0;
            for (let i = 0; i < results.length; i++) {
                const result = results[i];
                const segmentIndex = batchStart + i;

                if (result.status === 'fulfilled' && result.value) {
                    // Write segment data to file
                    await fileWriter.write(result.value);

                    const dataSize = result.value.byteLength;
                    downloadProgress.processedSize += dataSize;
                    batchProcessedSegments++;
                    totalProcessedSegments++;

                    // Report progress
                    await reportProgress(segmentIndex, segments.length, dataSize);
                } else {
                    console.error(`[OFFSCREEN] Failed to process segment ${segmentIndex + 1}:`, result.reason);
                    failedSegments.push({
                        index: segmentIndex,
                        url: segments[segmentIndex],
                        error: result.reason
                    });
                }
            }

            console.log(`[OFFSCREEN] Batch completed: ${batchProcessedSegments}/${batchSegments.length} segments`);

            // Check if we need to clean up memory
            if (totalProcessedSegments % 100 === 0) {
                console.log('[OFFSCREEN] Cleaning up memory...');
                // Force garbage collection if available
                if (window.gc) {
                    window.gc();
                }
            }

            batchStart = batchEnd;
        }

        // Finish the file
        await fileWriter.close();
        fileWriter = null;

        console.log('[OFFSCREEN] Download completed successfully');

        // Report final status
        sendProgressUpdate({
            type: 'downloadComplete',
            totalSegments: segments.length,
            failedSegmentCount: failedSegments.length,
            filename: fileHandle.name,
            totalSize: downloadProgress.processedSize
        });

        return {
            success: true,
            filename: fileHandle.name,
            totalSize: downloadProgress.processedSize,
            failedSegments: failedSegments.length
        };

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

            const data = await response.arrayBuffer();

            if (data.byteLength === 0) {
                throw new Error(`Empty segment ${index + 1}`);
            }

            console.log(`[OFFSCREEN] Segment ${index + 1} downloaded: ${(data.byteLength / 1024).toFixed(2)}KB`);

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
                    if (currentBlobSize + data.byteLength < MAX_BLOB_SIZE) {
                        currentBlobData.push(data);
                        currentBlobSize += data.byteLength;
                    } else {
                        // Create a blob with existing data
                        tempBlobs.push(new Blob(currentBlobData, { type: 'video/mp4' }));

                        // Start new blob
                        currentBlobData = [data];
                        currentBlobSize = data.byteLength;
                    }

                    totalBytesProcessed += data.byteLength;

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

        // Report final status
        sendProgressUpdate({
            type: 'downloadComplete',
            totalSegments: segments.length,
            filename: 'temp_stream_' + Date.now(),
            totalSize: totalBytesProcessed,
            blobsCount: tempBlobs.length,
            blobs: tempBlobs
        });

        return {
            success: true,
            totalSize: totalBytesProcessed,
            blobs: tempBlobs,
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