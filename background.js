// Side panel available on all tabs (like Claude)
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id, windowId: tab.windowId }).catch(() => {
    chrome.sidePanel.setOptions({ tabId: tab.id, path: 'sidepanel.html', enabled: true }).catch(()=>{});
  });
});

async function updateSidePanelState(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:'))) {
      chrome.sidePanel.setOptions({ tabId: tabId, enabled: false }).catch(()=>{});
      return;
    }
    chrome.sidePanel.setOptions({ tabId: tabId, path: 'sidepanel.html', enabled: true }).catch(()=>{});
  } catch(e) {}
}

let isAgentPaused = false;
let currentTabIdForAgent = null;
let currentApiKey = null;
let currentGroupId = null;
let agentGroupId = null; // The Tab Group we auto-created

// Initialize System Prompt
const SYSTEM_PROMPT = {
  role: "system",
  content: `You are an AUTONOMOUS browser agent (like Claude Computer Use). You exist in a side panel next to the user's webpage.
You can read the webpage and interact with it using the provided tools.

CRITICAL INSTRUCTIONS FOR AUTONOMY & VISION:
1. If the user asks you to perform a multi-step task, YOU MUST DO IT AUTONOMOUSLY. Chain your actions until the goal is achieved.
2. After using 'interact_with_page', the system executes it and returns the NEW UPDATED PAGE STRUCTURE. Read it and use the tool again immediately if needed.
3. MULTI-TAB AWARENESS: If the user's tab is in a Tab Group, you will see the structures of ALL tabs in that group, labeled with [TAB ID: X].
4. To interact with an element in a specific tab, you MUST provide the correct 'tab_id' in your tool call. The system will automatically switch to that tab for you.
5. URL NAVIGATION: Use 'navigate_to' to go to ANY website (google.com, gmail.com, amazon.com, etc.). You CAN navigate from ANY page — even chrome://newtab or about:blank. The system will open a new tab automatically if needed. You are NOT restricted by the starting page.
6. SPATIAL AWARENESS: Elements have IDs and Spatial Positions like [ID:12] button [Pos:Top-Left].
7. VISUAL MARKS: The user can see blue floating numbers for IDs. If confused, ask the user for the number.
8. OCR VISION FALLBACK: If you cannot find what you need in the DOM structure (e.g. Canvas elements, complex dropdowns, or verification of visual state), use the 'take_screenshot_and_read' tool.
9. DOCUMENT AUTOFILL: If the user provides a document/image and asks you to fill a form, FIRST use the OCR tool to extract the text, analyze it, and THEN use 'interact_with_page' (type action) to fill out the form fields autonomously.
10. LONG-TERM MEMORY: You have access to user preferences. Use 'save_user_preference' to memorize important details about the user.
11. POPUPS & MODALS: If an element says [⚠️ BLOCKED BY OVERLAY], YOU CANNOT CLICK IT. You must first find the overlay/popup that is blocking the page (look for close buttons, "X", "Aceptar", etc.) and close it!
12. JAVASCRIPT EXECUTION: If standard interaction fails (e.g. Rich Text Editors, complex custom widgets, or Google pages with dynamic elements), use 'execute_javascript' to inject code directly into the page. Example: document.querySelector('textarea[name="q"]').value = 'search term';
13. Only output a regular text message when the entire task is fully completed, or if you encounter a fatal error.`
};

let chatHistories = {}; // { 'group_123': [...], 'tab_456': [...] }

function getContextIdForTab(tab) {
  if (tab.groupId && tab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
    return 'group_' + tab.groupId;
  }
  return 'tab_' + tab.id;
}

function getChatHistory(contextId) {
  if (!chatHistories[contextId] || chatHistories[contextId].length === 0) {
    chatHistories[contextId] = [SYSTEM_PROMPT];
  }
  
  // Sanitize history to prevent "insufficient tool messages" API errors
  const history = chatHistories[contextId];
  const sanitizedHistory = [];
  
  let expectedToolCalls = []; // Array of tool_call_id strings
  
  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    
    if (msg.role !== 'tool') {
      expectedToolCalls = [];
    }
    
    if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Check if the next messages contain the responses for these tool calls
        const requiredToolCallIds = msg.tool_calls.map(tc => tc.id);
        const foundToolResponses = [];
        let nextIdx = i + 1;
        
        while (nextIdx < history.length && history[nextIdx].role === 'tool') {
          foundToolResponses.push(history[nextIdx].tool_call_id);
          nextIdx++;
        }
        
        // If we don't have a tool response for EVERY tool call, strip the tool_calls to prevent API crash
        const allFound = requiredToolCallIds.every(id => foundToolResponses.includes(id));
        if (!allFound) {
          delete msg.tool_calls;
          // Optionally, remove content if it's empty to prevent blank assistant messages
          if (!msg.content) msg.content = "I attempted an action but it was interrupted.";
        } else {
          expectedToolCalls = [...requiredToolCallIds];
        }
      }
      sanitizedHistory.push(msg);
    } else if (msg.role === 'tool') {
      const idx = expectedToolCalls.indexOf(msg.tool_call_id);
      if (idx !== -1) {
        sanitizedHistory.push(msg);
        expectedToolCalls.splice(idx, 1);
      }
      // Else: drop the orphaned or duplicate tool message
    } else {
      sanitizedHistory.push(msg);
    }
  }
  
  chatHistories[contextId] = sanitizedHistory;
  return sanitizedHistory;
}

// Direct sanitization of a messages array (for API pre-send validation).
// Strips orphaned tool messages and tool_calls with missing responses,
// including when system/user messages break the assistant→tool chain.
function sanitizeMessagesForApi(messages) {
  const clean = [];
  let pendingToolCallIds = []; // tool_call_ids we expect responses for
  
  for (let i = 0; i < messages.length; i++) {
    const msg = { ...messages[i] }; // shallow copy
    
    if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Check if responses exist for ALL tool calls (look ahead, skipping system/user)
        const required = msg.tool_calls.map(tc => tc.id);
        const found = [];
        for (let j = i + 1; j < messages.length; j++) {
          if (messages[j].role === 'tool') {
            found.push(messages[j].tool_call_id);
          } else if (messages[j].role === 'assistant') {
            break; // next assistant starts a new chain
          }
        }
        const allFound = required.every(id => found.includes(id));
        if (allFound) {
          pendingToolCallIds.push(...required);
          clean.push(msg);
        } else {
          // Strip tool_calls — no complete response set
          const stripped = { ...msg };
          delete stripped.tool_calls;
          if (!stripped.content) stripped.content = "(Action was interrupted)";
          clean.push(stripped);
        }
      } else {
        clean.push(msg);
      }
    } else if (msg.role === 'tool') {
      // Only include tool messages that are responses to a pending tool_call
      const idx = pendingToolCallIds.indexOf(msg.tool_call_id);
      if (idx !== -1) {
        clean.push(msg);
        pendingToolCallIds.splice(idx, 1);
      }
      // Otherwise: drop the orphaned tool message
    } else {
      clean.push(msg);
    }
  }
  
  return clean;
}

// Load history from storage on startup
chrome.storage.local.get('chatHistories', (data) => {
  if (data.chatHistories) {
    chatHistories = data.chatHistories;
  }
});

function saveHistory() {
  chrome.storage.local.set({ chatHistories: chatHistories });
}

function broadcastStatus(status) {
  chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', payload: status }).catch(() => {});
}

function toggleOverlay(show) {
  if (currentTabIdForAgent) {
    chrome.tabs.sendMessage(currentTabIdForAgent, { type: show ? 'SHOW_OVERLAY' : 'HIDE_OVERLAY' }).catch(() => {});
  }
}

const DEEPSEEK_API_URL = 'https://api.deepseek.com/chat/completions';

const tools = [
  {
    type: "function",
    function: {
      name: "interact_with_page",
      description: "Interact with the current webpage or a specific tab. You can click, type, scroll, wait, hover, right_click, or switch_tab.",
      parameters: {
        type: "object",
        properties: {
          "action": { type: "string", enum: ["click", "type", "scroll", "wait", "hover", "right_click", "switch_tab", "press_key", "upload_file"], description: "The action to perform." },
          "target_id": { type: "string", description: "The numeric ID of the element to interact with." },
          "tab_id": { type: "number", description: "The ID of the tab you want to interact with. Crucial for Multi-Tab operations." },
          "value": { type: "string", description: "The text to type if action is 'type'." },
          "key": { type: "string", description: "The key to press if action is 'press_key' (e.g. 'Enter', 'Escape', 'Tab')." },
          "direction": { type: "string", enum: ["up", "down"], description: "Direction to scroll if action is 'scroll'." },
          "wait_ms": { type: "number", description: "Milliseconds to wait if action is 'wait'." }
        },
        "required": ["action"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "navigate_to",
      description: "Navigate the active tab to a specific URL.",
      parameters: {
        type: "object",
        properties: {
          "url": { type: "string", description: "The full URL to navigate to (e.g. 'https://www.google.com')." }
        },
        "required": ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "execute_javascript",
      description: "Injects and executes arbitrary JavaScript on the current active tab. Use this to bypass visual restrictions, write into hidden inputs, fill Rich Text Editors (TinyMCE, Quill), or force DOM changes when standard UI interaction fails.",
      parameters: {
        type: "object",
        properties: {
          "script": { type: "string", description: "The JavaScript code to execute. Example: document.querySelector('#editor').value = 'hello';" }
        },
        "required": ["script"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "wait_for_text",
      description: "Pauses the agent and continuously scans the page until a specific text appears on the screen (up to 10 seconds). Use this to wait for an element to load after an action.",
      parameters: {
        type: "object",
        properties: {
          "text": { type: "string", description: "The text to wait for." }
        },
        "required": ["text"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "take_screenshot_and_read",
      description: "Take a screenshot of the current visible tab and run OCR to extract all visible text. Use this when you are confused, when the DOM structure doesn't match what the user describes, or for Canvas/Complex components that hide text from the DOM. Returns the extracted text.",
      parameters: {
        type: "object",
        properties: {},
        required: []
      }
    }
  },
  {
    type: "function",
    function: {
      name: "extract_data_to_csv",
      description: "Extract structured data from the page (e.g. lists, tables, profiles) and save it as a CSV file for the user. Call this when the user asks to scrape or extract data to Excel/CSV.",
      parameters: {
        type: "object",
        properties: {
          "filename": { type: "string", description: "Name of the file without extension (e.g. 'amazon_products')." },
          "columns": { type: "array", items: { type: "string" }, description: "Array of column headers." },
          "rows": { 
            type: "array", 
            items: { 
              type: "array", 
              items: { type: "string" } 
            }, 
            description: "Array of rows. Each row is an array of strings corresponding to the columns." 
          }
        },
        "required": ["filename", "columns", "rows"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "download_qa_report",
      description: "Generate and download a QA Testing Report in Markdown format. Use this when you have finished testing a page and the user wants to download the testing results.",
      parameters: {
        type: "object",
        properties: {
          "filename": { type: "string", description: "Name of the file without extension (e.g. 'qa_report_login')." },
          "summary": { type: "string", description: "Your detailed summary of the testing session, what was tested, and your conclusions." },
          "errors_found": { type: "array", items: { type: "string" }, description: "Array of raw errors you found in the context (Network, Console, UI errors)." }
        },
        "required": ["filename", "summary", "errors_found"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "save_user_preference",
      description: "Save a fact about the user to your long-term memory (e.g., 'email': 'user@example.com', 'role': 'developer').",
      parameters: {
        type: "object",
        properties: {
          "key": { type: "string", description: "The memory key." },
          "value": { type: "string", description: "The value to remember." }
        },
        "required": ["key", "value"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "delete_user_preference",
      description: "Delete a fact from long-term memory.",
      parameters: {
        type: "object",
        properties: {
          "key": { type: "string", description: "The memory key to delete." }
        },
        "required": ["key"]
      }
    }
  }
];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'USER_MESSAGE') {
    isAgentPaused = false;
    chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      if (tabs[0]) {
        currentTabIdForAgent = tabs[0].id; // Ensure it's set before toggling overlay
        toggleOverlay(true);
        const contextId = getContextIdForTab(tabs[0]);
        handleUserMessage(message.payload, contextId);
      }
    });
    sendResponse({ received: true });
  } 
  else if (message.type === 'EDIT_MESSAGE') {
    isAgentPaused = false;
    chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      if (tabs[0]) {
        currentTabIdForAgent = tabs[0].id;
        toggleOverlay(true);
        const contextId = getContextIdForTab(tabs[0]);
        
        // Truncate history up to the index of the edited message
        const index = message.index;
        const newContent = message.payload;
        
        if (chatHistories[contextId] && chatHistories[contextId].length > index) {
          // Keep history before the edited message
          chatHistories[contextId] = chatHistories[contextId].slice(0, index);
        }
        
        handleUserMessage(newContent, contextId);
      }
    });
    sendResponse({ received: true });
  }
  else if (message.type === 'GET_HISTORY') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      if (tabs[0]) {
        const contextId = getContextIdForTab(tabs[0]);
        sendResponse({ history: getChatHistory(contextId) });
      } else {
        sendResponse({ history: [SYSTEM_PROMPT] });
      }
    });
    return true;
  }
  else if (message.type === 'CHECK_BALANCE') {
    chrome.storage.local.get('deepseekApiKey', (data) => {
      const apiKey = data.deepseekApiKey || currentApiKey;
      if (!apiKey) {
        sendResponse({ error: 'No API Key' });
        return;
      }
      fetch('https://api.deepseek.com/user/balance', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Accept': 'application/json'
        }
      })
      .then(res => res.json())
      .then(data => sendResponse(data))
      .catch(err => sendResponse({ error: err.message }));
    });
    return true;
  }
  else if (message.type === 'GET_AVAILABLE_TABS') {
    chrome.tabs.query({ currentWindow: true }).then(tabs => {
      chrome.tabs.query({ active: true, currentWindow: true }).then(activeTabs => {
        const activeGroupId = activeTabs[0]?.groupId || chrome.tabGroups.TAB_GROUP_ID_NONE;
        const availableTabs = tabs
          .filter(t => t.groupId !== activeGroupId && !t.url.startsWith('chrome://') && !t.url.startsWith('chrome-extension://'))
          .map(t => ({ id: t.id, title: t.title, url: t.url, favIconUrl: t.favIconUrl }));
        sendResponse({ tabs: availableTabs });
      });
    });
    return true;
  }
  else if (message.type === 'ADD_TABS_TO_GROUP') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(async activeTabs => {
      const activeTab = activeTabs[0];
      if (activeTab) {
        try {
          let groupId = activeTab.groupId;
          if (groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) {
            groupId = await retryTabGroup(() => chrome.tabs.group({ tabIds: [activeTab.id, ...message.tabIds] }));
            currentGroupId = groupId;
          } else {
            await retryTabGroup(() => chrome.tabs.group({ tabIds: message.tabIds, groupId: groupId }));
          }
          sendResponse({ success: true, groupId });
        } catch (e) {
          sendResponse({ error: e.message });
        }
      } else {
        sendResponse({ error: "No active tab found" });
      }
    });
    return true;
  }
  else if (message.type === 'CLEAR_HISTORY') {
    // Full reset: stop agent, hide overlay, clear history
    isAgentPaused = true;
    toggleOverlay(false);
    
    chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      if (tabs[0]) {
        const contextId = getContextIdForTab(tabs[0]);
        chatHistories[contextId] = [SYSTEM_PROMPT];
        saveHistory();
        // Clear visual marks on the active tab
        chrome.tabs.sendMessage(tabs[0].id, { type: 'CLEAR_MARKS' }).catch(()=>{});
      }
      sendResponse({ success: true });
    });
    return true;
  }
  else if (message.type === 'PAUSE_AGENT') {
    isAgentPaused = true;
    toggleOverlay(false);
    sendResponse({ success: true });
  }
  else if (message.type === 'RESUME_AGENT') {
    isAgentPaused = false;
    chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
      if (tabs[0] && currentApiKey) {
        currentTabIdForAgent = tabs[0].id;
        currentGroupId = tabs[0].groupId;
        toggleOverlay(true);
        const contextId = getContextIdForTab(tabs[0]);
        chrome.runtime.sendMessage({ type: 'CONTEXT_CHANGED', payload: contextId }).catch(()=>{});
        const messagesForApi = [...getChatHistory(contextId)];
        resumeAgent(messagesForApi, currentApiKey, contextId);
      } else {
        chrome.runtime.sendMessage({ type: 'ASSISTANT_ERROR', payload: "No hay una tarea activa para reanudar." }).catch(()=>{});
      }
      sendResponse({ success: true });
    });
    return true;
  }
  else if (message.type === 'CREATE_TAB_GROUP') {
    createAgentTabGroup().then(groupId => {
      sendResponse({ groupId });
    });
    return true; // async
  }
  else if (message.type === 'ADD_TAB_TO_GROUP') {
    addCurrentTabToGroup()
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
  else if (message.type === 'TOGGLE_MARKS') {
    // Forward to the active tab's content script
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { type: 'TOGGLE_MARKS', enabled: message.enabled }).catch(() => {});
      }
    });
    sendResponse({ success: true });
  }
  return true;
});

// Listen for group changes to update context and side panel visibility
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.groupId !== undefined) {
    updateSidePanelState(tabId);
  }
  chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
    if (changeInfo.status === 'complete' && tabs[0]) {
      if (tabs[0].groupId && tabs[0].groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
        chrome.runtime.sendMessage({ type: 'CONTEXT_CHANGED', payload: getContextIdForTab(tabs[0]) }).catch(() => {});
      }
    }
  });
});

chrome.tabs.onActivated.addListener(activeInfo => {
  updateSidePanelState(activeInfo.tabId);
  chrome.tabs.get(activeInfo.tabId).then(tab => {
    chrome.runtime.sendMessage({ type: 'CONTEXT_CHANGED', payload: getContextIdForTab(tab) }).catch(() => {});
  }).catch(() => {});
});

// Clean up isolated tab history when closed
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  const contextId = 'tab_' + tabId;
  if (chatHistories[contextId]) {
    delete chatHistories[contextId];
    saveHistory();
  }
});

// Clean up group history when group is closed
chrome.tabGroups.onRemoved.addListener((tabGroup) => {
  const contextId = 'group_' + tabGroup.id;
  if (chatHistories[contextId]) {
    delete chatHistories[contextId];
    saveHistory();
  }
});

// Retry helper for tab group operations that can fail during user tab interactions
async function retryTabGroup(operation, maxRetries = 5) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await operation();
    } catch (e) {
      if (attempt === maxRetries - 1) throw e;
      const delay = 300 * Math.pow(2, attempt); // 300ms, 600ms, 1200ms, 2400ms, 4800ms
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// Auto-create a Tab Group for the agent
async function createAgentTabGroup() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];
    
    // Check if tab is already in a group
    if (activeTab.groupId && activeTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
      agentGroupId = activeTab.groupId;
      currentGroupId = activeTab.groupId;
      return agentGroupId;
    }
    
    // Create a new group with the active tab
    const groupId = await retryTabGroup(() => chrome.tabs.group({ tabIds: [activeTab.id] }));
    await retryTabGroup(() => chrome.tabGroups.update(groupId, { 
      title: 'Lumi',
      color: 'blue',
      collapsed: false
    }));
    agentGroupId = groupId;
    currentGroupId = groupId;
    return groupId;
  } catch(e) {
    console.error("Failed to create tab group:", e);
    return null;
  }
}

// Add the currently active tab to the agent's group
async function addCurrentTabToGroup() {
  if (!agentGroupId) return { success: false, error: "No active agent group" };
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];
    if (activeTab.groupId !== agentGroupId) {
      await retryTabGroup(() => chrome.tabs.group({ tabIds: [activeTab.id], groupId: agentGroupId }));
    }
    return { success: true };
  } catch(e) {
    console.error("Failed to add tab to group:", e);
    return { success: false, error: e.message };
  }
}

async function extractPageSafe(tabId) {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab) return `Tab ${tabId} no longer exists.`;

  // Skip restricted URLs
  if (tab.url && (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:'))) {
    return `Cannot read content from ${tab.url}. This is a restricted internal page. Use 'navigate_to' to go to any website (e.g. 'https://www.google.com') — the system will open a new tab to bypass this restriction.`;
  }

  // Wait for page to finish loading (retry up to 15s for slow SPA pages)
  for (let waitAttempt = 0; waitAttempt < 15; waitAttempt++) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'complete') break;
    } catch(e) { break; }
    broadcastStatus(`Esperando que la p\u00e1gina cargue... (${waitAttempt + 1}s)`);
    await new Promise(r => setTimeout(r, 1000));
  }

  // Extra wait for dynamic content (Google, SPA frameworks)
  await new Promise(r => setTimeout(r, 1500));

  // Helper to try extraction via message
  async function tryExtract() {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'EXTRACT_PAGE' });
    if (response && response.content && response.content.length > 30) {
      return response.content;
    }
    return null;
  }

  // Helper to force-inject scripts
  async function forceInject() {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['js/dom-mapper.js']
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 300));
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content.js']
    }).catch(() => {});
    await new Promise(r => setTimeout(r, 1000));
  }

  // Attempt 1: Existing content script
  let content = await tryExtract().catch(() => null);
  if (content) return content;

  // Attempt 2: Force-inject both scripts
  broadcastStatus("Inyectando scripts de lectura...");
  await forceInject();
  content = await tryExtract().catch(() => null);
  if (content) return content;

  // Attempt 3: Wait more for SPA pages and try again
  broadcastStatus("Reintentando lectura de p\u00e1gina...");
  await new Promise(r => setTimeout(r, 2000));
  content = await tryExtract().catch(() => null);
  if (content) return content;

  // Attempt 4: Re-inject and try one final time
  await forceInject();
  await new Promise(r => setTimeout(r, 1000));
  content = await tryExtract().catch(() => null);
  if (content) return content;

  return `Unable to read this tab's content. The page may have strict security policies or dynamic loading that prevents DOM analysis. You can still try 'execute_javascript' to interact directly, or 'navigate_to' to go to a different URL. Tab ID: ${tabId}, URL: ${tab.url}`;
}

async function extractFullContext() {
  // If we are operating in a group context
  if (currentGroupId && currentGroupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
    const tabsInGroup = await chrome.tabs.query({ groupId: currentGroupId });
    let combinedContext = `[MULTI-TAB GROUP CONTEXT - ${tabsInGroup.length} TABS DETECTED]\n\n`;
    
    for (const tab of tabsInGroup) {
      broadcastStatus(`Leyendo pestaña: ${tab.title.substring(0, 15)}...`);
      const pageStr = await extractPageSafe(tab.id);
      combinedContext += `--- [TAB ID: ${tab.id}] URL: ${tab.url} ---\n${pageStr}\n\n`;
    }
    return combinedContext;
  } else {
    // Single tab fallback
    broadcastStatus("Extrayendo estructura de la página...");
    const tab = await chrome.tabs.get(currentTabIdForAgent);
    const pageStr = await extractPageSafe(currentTabIdForAgent);
    return `--- [TAB ID: ${tab.id}] URL: ${tab.url} ---\n${pageStr}`;
  }
}

async function handleUserMessage(userText, contextId) {
  try {
    const { deepseekApiKey } = await chrome.storage.local.get('deepseekApiKey');
    if (!deepseekApiKey) throw new Error("API Key not found.");
    currentApiKey = deepseekApiKey;

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeTab = tabs[0];
    currentTabIdForAgent = activeTab.id;
    currentGroupId = activeTab.groupId;
    
    const pageContext = await extractFullContext();

    const history = getChatHistory(contextId);
    history.push({ role: "user", content: userText });
    saveHistory();
    
    // Load preferences
    const { userPreferences = {} } = await chrome.storage.local.get('userPreferences');
    const prefStr = Object.keys(userPreferences).length > 0 
      ? Object.entries(userPreferences).map(([k, v]) => `- ${k}: ${v}`).join("\n") 
      : "No preferences saved yet.";

    const messagesForApi = [...history];
    messagesForApi.splice(messagesForApi.length - 1, 0, {
      role: "system",
      content: `[CURRENT PAGE CONTEXT]\n${pageContext}\n\n[USER PREFERENCES (LONG-TERM MEMORY)]\n${prefStr}`
    });

    await callDeepSeekAPI(messagesForApi, deepseekApiKey, contextId);

  } catch (error) {
    console.error(error);
    toggleOverlay(false);
    chrome.runtime.sendMessage({ type: 'ASSISTANT_ERROR', payload: error.message });
  }
}

async function resumeAgent(messagesForApi, apiKey, contextId) {
  const pageContext = await extractFullContext();
  
  const { userPreferences = {} } = await chrome.storage.local.get('userPreferences');
  const prefStr = Object.keys(userPreferences).length > 0 
    ? Object.entries(userPreferences).map(([k, v]) => `- ${k}: ${v}`).join("\n") 
    : "No preferences saved yet.";

  messagesForApi.push({
    role: "system",
    content: `[REANUDADO] CURRENT WEBPAGE CONTEXT:\n${pageContext}\n\n[USER PREFERENCES (LONG-TERM MEMORY)]\n${prefStr}`
  });
  
  await callDeepSeekAPI(messagesForApi, apiKey, contextId);
}

async function callDeepSeekAPI(messages, apiKey, contextId, loopCount = 0) {
  if (loopCount >= 50) {
    toggleOverlay(false);
    chrome.runtime.sendMessage({ 
      type: 'ASSISTANT_ERROR', 
      payload: "Límite de seguridad alcanzado: El agente ha realizado 50 acciones consecutivas sin terminar. Se ha detenido para evitar un bucle infinito." 
    });
    return;
  }

  if (isAgentPaused) {
    toggleOverlay(false);
    chrome.runtime.sendMessage({ type: 'AGENT_PAUSED' });
    return;
  }

  toggleOverlay(true);

  try {
    broadcastStatus("Pensando la siguiente acción...");
    
    // Sanitize messages right before sending to prevent DeepSeek API errors
    messages = sanitizeMessagesForApi(messages);
    
    const response = await fetch(DEEPSEEK_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: messages,
        tools: tools,
        tool_choice: "auto"
      })
    });

    if (!response.ok) {
      const err = await response.json();
      throw new Error(err.error?.message || `API Error: ${response.status}`);
    }

    if (isAgentPaused) {
      chrome.runtime.sendMessage({ type: 'AGENT_PAUSED' });
      return;
    }

    const data = await response.json();
    const assistantMessage = data.choices[0].message;

    const history = getChatHistory(contextId);

    if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
      messages.push(assistantMessage);
      history.push(assistantMessage);
      saveHistory();

      for (const toolCall of assistantMessage.tool_calls) {
        if (isAgentPaused) {
          const toolResultMessage = {
            role: "tool",
            tool_call_id: toolCall.id,
            content: "Agent was paused by user. Tool execution cancelled."
          };
          messages.push(toolResultMessage);
          history.push(toolResultMessage);
          saveHistory();
          continue;
        }

        if (toolCall.function.name === 'interact_with_page') {
          const args = JSON.parse(toolCall.function.arguments);
          let actionResult = "Action executed successfully.";
          
          try {
            // Determine which tab to act on
            let targetTabId = args.tab_id ? parseInt(args.tab_id) : currentTabIdForAgent;
            
            if (args.action === 'wait') {
              broadcastStatus(`Esperando ${args.wait_ms || 2000}ms...`);
              const ms = args.wait_ms || 2000;
              await new Promise(r => setTimeout(r, ms));
              actionResult = `Waited for ${ms}ms.`;
            } else if (args.action === 'switch_tab') {
              broadcastStatus(`Cambiando a pestaña ${targetTabId}...`);
              await chrome.tabs.update(targetTabId, { active: true });
              await new Promise(r => setTimeout(r, 500));
              actionResult = `Switched focus to tab ${targetTabId}.`;
            } else {
              broadcastStatus(`Ejecutando ${args.action} en pesta\u00f1a ${targetTabId}...`);
              const res = await chrome.tabs.sendMessage(targetTabId, {
                type: 'EXECUTE_ACTION',
                payload: args
              });
              let parsedRes = null;
              let actionFailed = false;
              try {
                if (res && res.result && typeof res.result === 'string' && res.result.startsWith('{')) {
                  parsedRes = JSON.parse(res.result);
                }
              } catch(e) {}

              if (parsedRes && parsedRes.status === 'success' && typeof parsedRes.cx === 'number' && typeof parsedRes.cy === 'number') {
                actionResult = parsedRes.message;
                let debuggerUsed = false;
                
                // Try Debugger API first for native-level interaction
                try {
                  await chrome.debugger.attach({ tabId: targetTabId }, "1.3");
                  debuggerUsed = true;
                  try {
                    await new Promise(r => setTimeout(r, 50));
                    const cx = parsedRes.cx;
                    const cy = parsedRes.cy;
                    
                    if (args.action === 'hover') {
                      await chrome.debugger.sendCommand({ tabId: targetTabId }, "Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
                      actionResult += `\nHover via Debugger API.`;
                    } else if (args.action === 'click') {
                      await chrome.debugger.sendCommand({ tabId: targetTabId }, "Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
                      await new Promise(r => setTimeout(r, 50));
                      await chrome.debugger.sendCommand({ tabId: targetTabId }, "Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
                      await new Promise(r => setTimeout(r, 50));
                      await chrome.debugger.sendCommand({ tabId: targetTabId }, "Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });
                      actionResult += `\nClick via Debugger API.`;
                    } else if (args.action === 'right_click') {
                      await chrome.debugger.sendCommand({ tabId: targetTabId }, "Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
                      await new Promise(r => setTimeout(r, 50));
                      await chrome.debugger.sendCommand({ tabId: targetTabId }, "Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "right", clickCount: 1 });
                      await new Promise(r => setTimeout(r, 50));
                      await chrome.debugger.sendCommand({ tabId: targetTabId }, "Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "right", clickCount: 1 });
                      actionResult += `\nRight-click via Debugger API.`;
                    }
                  } finally {
                    await chrome.debugger.detach({ tabId: targetTabId }).catch(()=>{});
                  }
                } catch(e) {
                  debuggerUsed = false;
                  broadcastStatus("Usando fallback program\u00e1tico...");
                  try {
                    const fallbackRes = await chrome.tabs.sendMessage(targetTabId, {
                      type: 'EXECUTE_ACTION_PROGRAMMATIC',
                      payload: args
                    });
                    actionResult += `\n${fallbackRes?.result || 'Action via programmatic fallback.'}`;
                  } catch(fallbackErr) {
                    actionResult += `\nWarning: Both Debugger and programmatic fallback failed: ${e.message}. ${fallbackErr.message || ''}`;
                  }
                }
              } else {
                actionResult = res.result || actionResult;
                actionFailed = true;
              }
              
              // Only attempt type/press_key if the action succeeded
              if (!actionFailed && args.action === 'type' && args.value) {
                let typedViaDebugger = false;
                try {
                  broadcastStatus(`Inyectando texto a nivel de sistema...`);
                  await chrome.debugger.attach({ tabId: targetTabId }, "1.3");
                  try {
                    await new Promise(r => setTimeout(r, 100));
                    await chrome.debugger.sendCommand({ tabId: targetTabId }, "Input.insertText", { text: args.value });
                    actionResult += `\nText injected via Debugger API.`;
                    typedViaDebugger = true;
                  } finally {
                    await chrome.debugger.detach({ tabId: targetTabId }).catch(()=>{});
                  }
                } catch(e) {
                  actionResult += `\nDebugger typing unavailable, using programmatic fallback.`;
                }
                
                if (!typedViaDebugger) {
                  try {
                    const typeRes = await chrome.tabs.sendMessage(targetTabId, {
                      type: 'EXECUTE_ACTION_PROGRAMMATIC',
                      payload: { ...args, forceType: true }
                    });
                    actionResult += `\n${typeRes?.result || 'Text typed via programmatic fallback.'}`;
                  } catch(fbErr) {
                    actionResult += `\nWarning: Programmatic typing also failed: ${fbErr.message}`;
                  }
                }
              } else if (args.action === 'press_key' && args.key) {
                let keyViaDebugger = false;
                try {
                  broadcastStatus(`Pulsando tecla a nivel de sistema...`);
                  await chrome.debugger.attach({ tabId: targetTabId }, "1.3");
                  try {
                    await new Promise(r => setTimeout(r, 100));
                    const textVal = args.key === 'Enter' ? '\r' : args.key;
                    await chrome.debugger.sendCommand({ tabId: targetTabId }, "Input.dispatchKeyEvent", { type: "keyDown", text: textVal });
                    await chrome.debugger.sendCommand({ tabId: targetTabId }, "Input.dispatchKeyEvent", { type: "keyUp", text: textVal });
                    actionResult += `\nKey pressed via Debugger API.`;
                    keyViaDebugger = true;
                  } finally {
                    await chrome.debugger.detach({ tabId: targetTabId }).catch(()=>{});
                  }
                } catch(e) {
                  actionResult += `\nDebugger key press unavailable, using programmatic fallback.`;
                }
                
                if (!keyViaDebugger) {
                  try {
                    const keyRes = await chrome.tabs.sendMessage(targetTabId, {
                      type: 'EXECUTE_ACTION_PROGRAMMATIC',
                      payload: { ...args, forceKey: true }
                    });
                    actionResult += `\n${keyRes?.result || 'Key pressed via programmatic fallback.'}`;
                  } catch(fbErr) {
                    actionResult += `\nWarning: Programmatic key press also failed: ${fbErr.message}`;
                  }
                }
              }
              
              if (actionFailed && actionResult.includes("not found")) {
                // Element not found — extract fresh context immediately, skip wait
                broadcastStatus("Elemento no encontrado, re-escaneando p\u00e1gina...");
              } else {
                broadcastStatus("Esperando a que la p\u00e1gina cargue...");
                await new Promise(r => setTimeout(r, 1500));
              }
            }

            if (isAgentPaused) {
              actionResult += "\nAgent was paused by user before extracting new context.";
            } else {
              broadcastStatus("Analizando nuevos cambios en pantalla...");
              const newPageContext = await extractFullContext();
              if (actionResult.includes("not found")) {
                actionResult += `\n\n[IMPORTANT] The element you referenced no longer exists on the page. Page layout changed. Here is the FRESH updated context with NEW element IDs:\n${newPageContext}\n\nUse the NEW IDs from above to complete your task.`;
              } else {
                actionResult += `\n\n--- NEW UPDATED FULL CONTEXT AFTER YOUR ACTION ---\n${newPageContext}\n\nAnalyze this new structure. If the task is not finished, invoke the tool again immediately.`;
              }
            }

          } catch(e) {
            actionResult = `Failed to execute action: ${e.message}`;
          }

          const toolResultMessage = {
            role: "tool",
            tool_call_id: toolCall.id,
            content: actionResult
          };
          messages.push(toolResultMessage);
          history.push(toolResultMessage);
          saveHistory();
        } else if (toolCall.function.name === 'navigate_to') {
          let actionResult = "";
          try {
            const { url } = JSON.parse(toolCall.function.arguments);
            broadcastStatus(`Navegando a ${url}...`);
            
            // Navigate the current active tab to the new URL
            let targetTabId = currentTabIdForAgent;
            if (!targetTabId) {
              const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
              targetTabId = tabs[0]?.id;
            }
            
            if (targetTabId) {
              // Check if we're on a restricted page that blocks tab.update
              let tab = await chrome.tabs.get(targetTabId).catch(() => null);
              const isRestricted = tab && tab.url && (
                tab.url.startsWith('chrome://') || 
                tab.url.startsWith('chrome-extension://') || 
                tab.url.startsWith('about:')
              );
              
              if (isRestricted) {
                // Chrome blocks navigating from chrome:// pages — open a new tab instead
                broadcastStatus("Abriendo nueva pesta\u00f1a para navegar...");
                const newTab = await chrome.tabs.create({ url: url, active: true, windowId: tab.windowId });
                targetTabId = newTab.id;
                currentTabIdForAgent = newTab.id;
                actionResult = `Opened new tab and navigating to ${url} (original tab was a restricted internal page). Waiting for page to load...`;
              } else {
                await chrome.tabs.update(targetTabId, { url: url, active: true });
                currentTabIdForAgent = targetTabId;
                actionResult = `Started navigation to ${url}. Waiting for page to fully load...`;
              }

              // Wait for page to actually complete loading (up to 20s for slow pages)
              broadcastStatus("Esperando a que la nueva p\u00e1gina cargue...");
              let pageLoaded = false;
              for (let i = 0; i < 20; i++) {
                await new Promise(r => setTimeout(r, 1000));
                try {
                  const t = await chrome.tabs.get(targetTabId);
                  if (t.status === 'complete' && t.url) {
                    pageLoaded = true;
                    await new Promise(r => setTimeout(r, 1500)); // extra wait for JS frameworks
                    break;
                  }
                } catch(e) { break; }
              }

              if (!isAgentPaused) {
                broadcastStatus("Analizando la nueva p\u00e1gina...");
                const newPageContext = await extractFullContext();
                actionResult += `\n\n--- NEW UPDATED FULL CONTEXT AFTER NAVIGATION ---\n${newPageContext}\n\nAnalyze this new structure to see if you reached the destination.`;
              }
            } else {
              actionResult = "Failed to navigate: Could not determine active tab.";
            }
          } catch(e) {
            actionResult = `Failed to navigate: ${e.message}`;
          }
          
          const toolResultMessage = {
            role: "tool",
            tool_call_id: toolCall.id,
            content: actionResult
          };
          messages.push(toolResultMessage);
          history.push(toolResultMessage);
          saveHistory();
        } else if (toolCall.function.name === 'take_screenshot_and_read') {
          let actionResult = "Failed to take screenshot or read text.";
          try {
            broadcastStatus("Capturando pantalla y leyendo texto...");
            
            // Ensure the active tab is the one we are supposed to be looking at
            const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            const activeTab = tabs[0];
            
            const dataUrl = await chrome.tabs.captureVisibleTab(activeTab.windowId, { format: 'jpeg', quality: 80 });
            
            // Ask the sidepanel (which has Tesseract) to OCR it, with a 15-second timeout
            const ocrPromise = chrome.runtime.sendMessage({ type: 'DO_OCR', dataUrl: dataUrl });
            const timeoutPromise = new Promise((_, reject) => 
              setTimeout(() => reject(new Error("OCR request timed out. Please ensure the side panel is open.")), 15000)
            );
            
            const res = await Promise.race([ocrPromise, timeoutPromise]);
            
            // Broadcast the screenshot to the UI
            chrome.runtime.sendMessage({ type: 'AGENT_SCREENSHOT', payload: dataUrl }).catch(() => {});
            
            if (res && res.text) {
              actionResult = `[SCREENSHOT OCR TEXT EXTRACTED]:\n"""\n${res.text}\n"""\n\nAnalyze this text to find the element you were looking for. If you now know what to do, use interact_with_page.`;
            } else if (res && res.error) {
              actionResult = `Failed to OCR: ${res.error}`;
            } else {
              actionResult = "No response from OCR engine. Ensure side panel is open.";
            }
          } catch (e) {
            actionResult = `Error taking screenshot: ${e.message}`;
          }
          
          const toolResultMessage = {
            role: "tool",
            tool_call_id: toolCall.id,
            content: actionResult
          };
          messages.push(toolResultMessage);
          history.push(toolResultMessage);
          saveHistory();
        } else if (toolCall.function.name === 'extract_data_to_csv') {
          let actionResult = "";
          try {
            const { filename, columns, rows } = JSON.parse(toolCall.function.arguments);
            broadcastStatus("Exportando datos a CSV...");
            
            // Build CSV string
            let csvContent = "";
            csvContent += columns.map(c => `"${c.replace(/"/g, '""')}"`).join(",") + "\n";
            rows.forEach(row => {
              csvContent += row.map(cell => `"${(cell||'').replace(/"/g, '""')}"`).join(",") + "\n";
            });
            
            const dataUrl = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csvContent);
            await chrome.downloads.download({
              url: dataUrl,
              filename: `${filename}.csv`,
              saveAs: true
            });
            
            actionResult = `Successfully extracted ${rows.length} rows and triggered download of ${filename}.csv.`;
          } catch(e) {
            actionResult = `Failed to export CSV: ${e.message}`;
          }
          const toolResultMessage = { role: "tool", tool_call_id: toolCall.id, content: actionResult };
          messages.push(toolResultMessage);
          history.push(toolResultMessage);
          saveHistory();

        } else if (toolCall.function.name === 'download_qa_report') {
          let actionResult = "";
          try {
            const { filename, summary, errors_found } = JSON.parse(toolCall.function.arguments);
            broadcastStatus("Generando Reporte QA...");
            
            let mdContent = `# QA Testing Report: ${filename}\n\n`;
            mdContent += `## Summary\n${summary}\n\n`;
            mdContent += `## Errors Found (${errors_found.length})\n`;
            if (errors_found.length === 0) {
              mdContent += "No errors found during testing.\n";
            } else {
              errors_found.forEach((err, idx) => {
                mdContent += `### Error ${idx + 1}\n\`\`\`json\n${err}\n\`\`\`\n\n`;
              });
            }
            
            const dataUrl = 'data:text/markdown;charset=utf-8,' + encodeURIComponent(mdContent);
            await chrome.downloads.download({
              url: dataUrl,
              filename: `${filename}.md`,
              saveAs: true
            });
            
            actionResult = `Successfully generated QA report and triggered download of ${filename}.md.`;
          } catch(e) {
            actionResult = `Failed to generate QA report: ${e.message}`;
          }
          const toolResultMessage = { role: "tool", tool_call_id: toolCall.id, content: actionResult };
          messages.push(toolResultMessage);
          history.push(toolResultMessage);
          saveHistory();

        } else if (toolCall.function.name === 'save_user_preference') {
          let actionResult = "";
          try {
            const { key, value } = JSON.parse(toolCall.function.arguments);
            const { userPreferences = {} } = await chrome.storage.local.get('userPreferences');
            userPreferences[key] = value;
            await chrome.storage.local.set({ userPreferences });
            actionResult = `Successfully saved preference '${key}'.`;
          } catch(e) {
            actionResult = `Error saving preference: ${e.message}`;
          }
          const toolResultMessage = { role: "tool", tool_call_id: toolCall.id, content: actionResult };
          messages.push(toolResultMessage);
          history.push(toolResultMessage);
          saveHistory();

        } else if (toolCall.function.name === 'delete_user_preference') {
          let actionResult = "";
          try {
            const { key } = JSON.parse(toolCall.function.arguments);
            const { userPreferences = {} } = await chrome.storage.local.get('userPreferences');
            delete userPreferences[key];
            await chrome.storage.local.set({ userPreferences });
            actionResult = `Successfully deleted preference '${key}'.`;
          } catch(e) {
            actionResult = `Error deleting preference: ${e.message}`;
          }
          const toolResultMessage = { role: "tool", tool_call_id: toolCall.id, content: actionResult };
          messages.push(toolResultMessage);
          history.push(toolResultMessage);
          saveHistory();

        } else if (toolCall.function.name === 'execute_javascript') {
          let actionResult = "";
          try {
            const { script } = JSON.parse(toolCall.function.arguments);
            broadcastStatus("Inyectando JavaScript en la página...");
            
            let targetTabId = currentTabIdForAgent;
            if (!targetTabId) {
              const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
              targetTabId = tabs[0]?.id;
            }

            if (targetTabId) {
              const res = await chrome.scripting.executeScript({
                target: { tabId: targetTabId },
                func: (code) => {
                  try {
                    // Try to evaluate the code
                    const result = eval(code);
                    return { success: true, result: String(result) };
                  } catch (err) {
                    return { success: false, error: err.message };
                  }
                },
                args: [script]
              });
              
              if (res && res[0] && res[0].result) {
                if (res[0].result.success) {
                  actionResult = `JavaScript executed successfully. Return value: ${res[0].result.result}`;
                } else {
                  actionResult = `JavaScript execution failed: ${res[0].result.error}`;
                }
              } else {
                actionResult = `Executed JavaScript but got no valid response.`;
              }
              
              // Give the DOM a moment to update if the script modified it
              await new Promise(r => setTimeout(r, 1000));
              
              if (!isAgentPaused) {
                const newPageContext = await extractFullContext();
                actionResult += `\n\n--- NEW UPDATED FULL CONTEXT AFTER JAVASCRIPT EXECUTION ---\n${newPageContext}`;
              }
            } else {
              actionResult = "Failed to execute script: Could not determine active tab.";
            }
          } catch(e) {
            actionResult = `Failed to execute JavaScript: ${e.message}`;
          }
          
          const toolResultMessage = { role: "tool", tool_call_id: toolCall.id, content: actionResult };
          messages.push(toolResultMessage);
          history.push(toolResultMessage);
          saveHistory();

        } else if (toolCall.function.name === 'wait_for_text') {
          let actionResult = "Timed out waiting for text.";
          try {
            const { text } = JSON.parse(toolCall.function.arguments);
            broadcastStatus(`Esperando a que aparezca: "${text}"...`);
            
            let found = false;
            // Poll for up to 10 seconds (20 iterations of 500ms)
            for (let i = 0; i < 20; i++) {
              if (isAgentPaused) break;
              
              const pageContext = await extractFullContext();
              if (pageContext.toLowerCase().includes(text.toLowerCase())) {
                found = true;
                actionResult = `Success: The text "${text}" appeared on the page.\n\n--- NEW UPDATED FULL CONTEXT ---\n${pageContext}`;
                break;
              }
              
              await new Promise(r => setTimeout(r, 500));
            }
            
            if (!found && !isAgentPaused) {
              const lastContext = await extractFullContext();
              actionResult = `Timeout: The text "${text}" did not appear after 10 seconds.\n\n--- CURRENT CONTEXT ---\n${lastContext}`;
            }
          } catch(e) {
            actionResult = `Error waiting for text: ${e.message}`;
          }
          
          const toolResultMessage = { role: "tool", tool_call_id: toolCall.id, content: actionResult };
          messages.push(toolResultMessage);
          history.push(toolResultMessage);
          saveHistory();
        } else {
          // Fallback for hallucinated or unknown tools
          const toolResultMessage = { role: "tool", tool_call_id: toolCall.id, content: `Error: Tool '${toolCall.function.name}' is not recognized.` };
          messages.push(toolResultMessage);
          history.push(toolResultMessage);
          saveHistory();
        }
      }

      if (isAgentPaused) {
        toggleOverlay(false);
        chrome.runtime.sendMessage({ type: 'AGENT_PAUSED' });
        return;
      }

      // Recursive loop
      await callDeepSeekAPI(messages, apiKey, contextId, loopCount + 1);
      toggleOverlay(false);
      
    } else {
      history.push(assistantMessage);
      saveHistory();
      toggleOverlay(false);
      chrome.runtime.sendMessage({ type: 'ASSISTANT_RESPONSE', payload: assistantMessage.content }).catch(()=>{});
    }
    
  } catch(error) {
    console.error(error);
    toggleOverlay(false);
    
    // Attempt to stringify messages for debugging, but truncate if too long
    let debugStr = "";
    try {
      debugStr = JSON.stringify(messages, null, 2);
      if (debugStr.length > 5000) debugStr = debugStr.substring(0, 5000) + "... [TRUNCATED]";
    } catch(e) {}
    
    chrome.runtime.sendMessage({ 
      type: 'ASSISTANT_ERROR', 
      payload: `${error.message}\n\n--- DEBUG MESSAGES ---\n${debugStr}` 
    });
  }
}
