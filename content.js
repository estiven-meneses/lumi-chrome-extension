(function() {
if (window.__lumiContentInjected) return;
window.__lumiContentInjected = true;

// Ensure DOMMapper is initialized
let mapper = null;

function getMapper() {
  if (!mapper) {
    if (typeof window.DOMMapper !== 'undefined') {
      mapper = new window.DOMMapper();
    } else {
      console.error("DOMMapper not found. Make sure js/dom-mapper.js is loaded first.");
    }
  }
  return mapper;
}

// --- QA Test Mode (Error Tracking) ---
let testModeEnabled = false;
let collectedErrors = [];

// Initialize from storage
chrome.storage.local.get(['qaTestMode'], (res) => {
  if (res.qaTestMode) testModeEnabled = true;
});

window.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'LUMI_TRACKED_ERROR') {
    if (testModeEnabled) {
      collectedErrors.push(event.data.payload);
    }
  }
});

// --- Visual Overlay System ---
let overlayElement = null;

function showControlOverlay() {
  if (!overlayElement) {
    overlayElement = document.createElement('div');
    overlayElement.id = 'deepseek-agent-overlay';
    
    // Shadow DOM to isolate styles
    const shadow = overlayElement.attachShadow({ mode: 'open' });
    
    const style = document.createElement('style');
    style.textContent = `
      .page-dimmer {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.4);
        pointer-events: auto;
        cursor: not-allowed;
        z-index: 2147483645;
        transition: opacity 0.3s ease;
      }
      .overlay-container {
        position: fixed;
        bottom: 30px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(20, 20, 20, 0.45);
        backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px);
        border: 1px solid rgba(0, 168, 255, 0.4);
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
        color: #ffffff;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
        display: flex;
        align-items: center;
        gap: 16px;
        padding: 10px 20px;
        border-radius: 100px;
        z-index: 2147483647;
        font-size: 14px;
        font-weight: 500;
        pointer-events: auto;
      }
      .pulse-dot {
        width: 10px;
        height: 10px;
        background-color: #00a8ff;
        border-radius: 50%;
        box-shadow: 0 0 8px #00a8ff;
      }
      .stop-btn {
        background: rgba(220, 38, 38, 0.2);
        color: #fca5a5;
        border: 1px solid rgba(220, 38, 38, 0.4);
        padding: 6px 14px;
        border-radius: 100px;
        cursor: pointer;
        font-weight: 600;
        font-size: 13px;
        transition: background 0.2s;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .stop-btn:hover {
        background: rgba(220, 38, 38, 0.4);
      }
    `;
    
    const container = document.createElement('div');
    container.className = 'overlay-container';
    
    const textContainer = document.createElement('div');
    textContainer.style.display = 'flex';
    textContainer.style.alignItems = 'center';
    textContainer.style.gap = '8px';
    
    textContainer.innerHTML = `
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="display: inline-block; width: 12px; height: 12px; border-radius: 50%; background: #22c55e; animation: pulse-green 1.5s infinite;"></span>
        <span>Lumi está controlando el navegador...</span>
      </div>`;
    
    const stopBtn = document.createElement('button');
    stopBtn.className = 'stop-btn';
    stopBtn.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect></svg>
      Retomar Control
    `;
    
    stopBtn.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'PAUSE_AGENT' });
      hideControlOverlay();
    });
    const dimmer = document.createElement('div');
    dimmer.className = 'page-dimmer';
    
    container.appendChild(textContainer);
    container.appendChild(stopBtn);
    
    shadow.appendChild(style);
    shadow.appendChild(dimmer);
    shadow.appendChild(container);
    
    document.documentElement.appendChild(overlayElement);
  }
  overlayElement.style.display = 'block';
  
  // Block user keyboard and scroll interaction
  if (!window.__lumiBlockersInstalled) {
    window.__lumiBlockersInstalled = true;
    window.__lumiBlockKey = (e) => { e.preventDefault(); e.stopPropagation(); };
    window.__lumiBlockScroll = (e) => { e.preventDefault(); e.stopPropagation(); };
    window.__lumiBlockWheel = (e) => { e.preventDefault(); e.stopPropagation(); };
    window.__lumiBlockContext = (e) => { e.preventDefault(); e.stopPropagation(); };
  }
  document.addEventListener('keydown', window.__lumiBlockKey, { capture: true, passive: false });
  document.addEventListener('keyup', window.__lumiBlockKey, { capture: true, passive: false });
  document.addEventListener('keypress', window.__lumiBlockKey, { capture: true, passive: false });
  document.addEventListener('wheel', window.__lumiBlockWheel, { capture: true, passive: false });
  document.addEventListener('scroll', window.__lumiBlockScroll, { capture: true, passive: false });
  document.addEventListener('contextmenu', window.__lumiBlockContext, { capture: true });
}

function hideControlOverlay() {
  if (overlayElement) {
    overlayElement.style.display = 'none';
  }
  // Remove simulated cursor if it exists
  const cursor = document.getElementById('deepseek-simulated-cursor');
  if (cursor) {
    cursor.remove();
  }
  // Restore user interaction
  if (window.__lumiBlockKey) {
    document.removeEventListener('keydown', window.__lumiBlockKey, { capture: true });
    document.removeEventListener('keyup', window.__lumiBlockKey, { capture: true });
    document.removeEventListener('keypress', window.__lumiBlockKey, { capture: true });
    document.removeEventListener('wheel', window.__lumiBlockWheel, { capture: true });
    document.removeEventListener('scroll', window.__lumiBlockScroll, { capture: true });
    document.removeEventListener('contextmenu', window.__lumiBlockContext, { capture: true });
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'SHOW_OVERLAY') {
    showControlOverlay();
    sendResponse({ result: 'Overlay shown' });
    return true;
  }
  
  if (message.type === 'HIDE_OVERLAY') {
    hideControlOverlay();
    sendResponse({ result: 'Overlay hidden' });
    return true;
  }

  if (message.type === 'SET_TEST_MODE') {
    testModeEnabled = message.enabled;
    if (!testModeEnabled) collectedErrors = []; // Clear buffer if turned off
    sendResponse({ result: `Test mode ${testModeEnabled ? 'ON' : 'OFF'}` });
    return true;
  }

  if (message.type === 'EXTRACT_PAGE') {
    try {
      const m = getMapper();
      if (m) {
        let wasVisible = overlayElement && overlayElement.style.display !== 'none';
        if (wasVisible) overlayElement.style.display = 'none';
        
        let content = m.extractPage();
        
        if (wasVisible) overlayElement.style.display = 'block';
        
        if (testModeEnabled && collectedErrors.length > 0) {
          const errorLog = collectedErrors.map(e => JSON.stringify(e)).join('\n');
          content = `\n\n[WARNING: TEST MODE CATCHED ERRORS DURING NAVIGATION]\n${errorLog}\n[END OF ERRORS]\n\n` + content;
          collectedErrors = []; // Clear after reporting
        }
        
        sendResponse({ content: content });
      } else {
        sendResponse({ content: "Error: DOMMapper not initialized." });
      }
    } catch (e) {
      console.error("Extraction error:", e);
      sendResponse({ content: "Error extracting page: " + e.message });
    }
    return true;
  }
  
  if (message.type === 'EXECUTE_ACTION') {
    try {
      const { action, target_id, value, direction, key } = message.payload;
      const m = getMapper();
      if (m) {
        Promise.resolve(m.executeAction({action, targetId: target_id, value, direction, key}))
          .then(result => sendResponse({ result: result }))
          .catch(e => {
            console.error("Execution async error:", e);
            sendResponse({ result: "Error executing action: " + e.message });
          });
      } else {
        sendResponse({ result: "Error: DOMMapper not initialized." });
      }
    } catch (e) {
      console.error("Execution error:", e);
      sendResponse({ result: "Error executing action: " + e.message });
    }
    return true;
  }

  // Programmatic fallback for when debugger API is unavailable
  if (message.type === 'EXECUTE_ACTION_PROGRAMMATIC') {
    try {
      const { action, target_id, value, key, forceType, forceKey } = message.payload;
      const m = getMapper();
      if (m) {
        Promise.resolve(m.executeProgrammatic({action, targetId: target_id, value, key, forceType, forceKey}))
          .then(result => sendResponse({ result: result }))
          .catch(e => {
            console.error("Programmatic execution error:", e);
            sendResponse({ result: "Error in programmatic execution: " + e.message });
          });
      } else {
        sendResponse({ result: "Error: DOMMapper not initialized." });
      }
    } catch (e) {
      console.error("Programmatic execution error:", e);
      sendResponse({ result: "Error in programmatic execution: " + e.message });
    }
    return true;
  }

  // Toggle marks on/off
  if (message.type === 'TOGGLE_MARKS') {
    const m = getMapper();
    if (m) {
      m.showMarks = message.enabled;
      if (!message.enabled) {
        m.clearMarks();
      }
      sendResponse({ result: `Marks ${message.enabled ? 'ON' : 'OFF'}` });
    }
    return true;
  }

  // Clear marks explicitly
  if (message.type === 'CLEAR_MARKS') {
    const m = getMapper();
    if (m) m.clearMarks();
    sendResponse({ result: 'Marks cleared.' });
    return true;
  }
});

})();
