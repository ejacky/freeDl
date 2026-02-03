# Stream Download Verification Guide

## Implementation Summary

This Chrome extension now supports downloading large M3U8 video files (2.7GB+) using an offscreen document with stream processing to avoid memory limitations.

### Key Components

1. **Offscreen Document** (`offscreen.html`, `offscreen.js`)
   - Handles large file downloads using File System Access API
   - Processes videos in 10MB chunks to control memory usage
   - Provides real-time progress updates

2. **Background Script Updates** (`background.js`)
   - Detects large files (100+ segments or >500MB estimated size)
   - Delegates to offscreen document for efficient processing
   - Maintains backward compatibility for smaller files

3. **Manifest Updates** (`manifest.json`)
   - Added `offscreen` permission
   - Added `offscreen.html` to web_accessible_resources

## Verification Tests

### Test 1: Small File Download (Traditional)
1. Download a video with < 100 segments (e.g., short clip)
2. Ensure it uses the traditional blob-based method
3. Verify download completes successfully

### Test 2: Medium File Download (Stream)
1. Download a video with 100-500 segments
2. Watch for log message: "Large file detected, using offscreen stream download..."
3. Verify:
   - File save dialog appears
   - Progress updates work correctly
   - Download completes without memory spikes

### Test 3: Large File Download (Stream)
1. Download a video with > 500 segments or > 2GB
2. Verify:
   - File save dialog appears
   - Memory usage stays under 200MB (check Chrome task manager)
   - Download completes successfully
   - No crashes or timeouts

### Test 4: Error Handling
1. Test cancelled downloads (close save dialog)
2. Test network interruptions
3. Verify graceful error messages and cleanup

### Test 5: Fallback Mechanism
1. Temporarily disable offscreen document creation
2. Verify large files still download (with warning about fallback)

## Performance Monitoring

Use Chrome Task Manager (Shift+Esc) to monitor:
- Memory usage during downloads
- CPU usage stays reasonable
- No memory spikes or leaks

## File Integrity Verification

After downloading:
1. Play the video to verify it's complete
2. Compare file size with expected
3. Check for any artifacts or missing segments

## Browser Compatibility

Tested on:
- Chrome 88+ (File System Access API required)
- Chromium-based browsers with experimental features enabled

Note: The implementation includes automatic fallback for browsers that don't support offscreen documents.

## Logging

Enable verbose logging by checking console for:
- `[BACKGROUND]` - Background script operations
- `[OFFSCREEN]` - Offscreen document operations
- `[DOWNLOAD]` - Download process messages

## Known Limitations

1. Requires user interaction to select save location
2. File System Access API only available in secure contexts
3. Maximum file size limited by available disk space
4. Cannot resume interrupted downloads (future enhancement)

## Troubleshooting

### Download fails with "Failed to create offscreen document"
- Ensure extension has all permissions
- Check Chrome version (88+ required)
- Restart Chrome and try again

### "Cannot write to selected file" error
- Check available disk space
- Verify write permissions to selected directory
- Try a different location

### High memory usage despite stream processing
- Check if another extension is interfering
- Restart Chrome
- Verify stream mode is actually being used (check logs)