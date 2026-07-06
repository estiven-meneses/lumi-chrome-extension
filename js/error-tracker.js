// js/error-tracker.js
// Runs in the MAIN world to intercept all page errors and network requests.

(function() {
  if (window.__LUMI_ERROR_TRACKER_INITIALIZED) return;
  window.__LUMI_ERROR_TRACKER_INITIALIZED = true;

  function sendToLumi(errorData) {
    // We send to the isolated content script via postMessage
    try {
      window.postMessage({
        type: 'LUMI_TRACKED_ERROR',
        payload: errorData
      }, '*');
    } catch (e) {
      // Ignore serialization errors
    }
  }

  // 1. Intercept console.error
  const originalConsoleError = console.error;
  console.error = function(...args) {
    try {
      const msg = args.map(a => {
        try { return typeof a === 'object' ? JSON.stringify(a) : String(a); } catch(e) { return "Unserializable Object"; }
      }).join(' ');
      sendToLumi({ type: 'CONSOLE_ERROR', message: msg, time: new Date().toISOString() });
    } catch(e) {}
    if (originalConsoleError) originalConsoleError.apply(console, args);
  };

  // 2. Intercept window.onerror
  window.addEventListener('error', function(event) {
    sendToLumi({ 
      type: 'WINDOW_ERROR', 
      message: event.message || "Unknown error",
      filename: event.filename,
      lineno: event.lineno,
      time: new Date().toISOString()
    });
  });

  // 3. Intercept Unhandled Promises
  window.addEventListener('unhandledrejection', function(event) {
    let reasonStr = "Unknown reason";
    if (event.reason) {
      reasonStr = event.reason instanceof Error ? (event.reason.stack || event.reason.message) : String(event.reason);
    }
    sendToLumi({
      type: 'UNHANDLED_PROMISE',
      message: reasonStr,
      time: new Date().toISOString()
    });
  });

  // 4. Intercept Fetch API
  const originalFetch = window.fetch;
  window.fetch = async function(...args) {
    try {
      const response = await originalFetch.apply(this, args);
      if (!response.ok) {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || 'Unknown URL';
        sendToLumi({
          type: 'NETWORK_ERROR_FETCH',
          url: url,
          status: response.status,
          statusText: response.statusText,
          time: new Date().toISOString()
        });
      }
      return response;
    } catch (error) {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || 'Unknown URL';
      sendToLumi({
        type: 'NETWORK_ERROR_FETCH_FAIL',
        url: url,
        message: error.message,
        time: new Date().toISOString()
      });
      throw error;
    }
  };

  // 5. Intercept XMLHttpRequest
  const originalXHR = window.XMLHttpRequest;
  if (originalXHR) {
    function interceptXHR() {
      const xhr = new originalXHR();
      const originalOpen = xhr.open;
      const originalSend = xhr.send;
      let requestUrl = '';

      xhr.open = function(method, url, ...rest) {
        requestUrl = url;
        return originalOpen.apply(xhr, [method, url, ...rest]);
      };

      xhr.send = function(...args) {
        xhr.addEventListener('load', function() {
          if (xhr.status >= 400) {
            sendToLumi({
              type: 'NETWORK_ERROR_XHR',
              url: requestUrl,
              status: xhr.status,
              statusText: xhr.statusText,
              time: new Date().toISOString()
            });
          }
        });
        xhr.addEventListener('error', function() {
          sendToLumi({
            type: 'NETWORK_ERROR_XHR_FAIL',
            url: requestUrl,
            message: 'XHR Network Error',
            time: new Date().toISOString()
          });
        });
        return originalSend.apply(xhr, args);
      };
      return xhr;
    }
    window.XMLHttpRequest = interceptXHR;
    Object.setPrototypeOf(window.XMLHttpRequest, originalXHR);
    window.XMLHttpRequest.prototype = originalXHR.prototype;
  }

  console.log("[Lumi AI] QA Error Tracker Injected in Main World");
})();
