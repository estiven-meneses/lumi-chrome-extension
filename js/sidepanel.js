document.addEventListener('DOMContentLoaded', async () => {
  const setupView = document.getElementById('setup-view');
  const chatView = document.getElementById('chat-view');
  const apiKeyInput = document.getElementById('api-key-input');
  const saveKeyBtn = document.getElementById('save-key-btn');
  const setupError = document.getElementById('setup-error');
  
  const chatInput = document.getElementById('chat-input');
  const sendBtn = document.getElementById('send-btn');
  const chatHistoryContainer = document.getElementById('chat-history');
  const currentTabDomain = document.getElementById('current-tab-domain');
  const settingsBtn = document.getElementById('settings-btn');

  // New controls
  const newChatBtn = document.getElementById('new-chat-btn');
  const agentControlBar = document.getElementById('agent-control-bar');
  const stopBtn = document.getElementById('stop-btn');
  const agentStatusText = document.getElementById('agent-status-text');

  // Settings panel controls
  const settingsPanel = document.getElementById('settings-panel');
  const closeSettingsBtn = document.getElementById('close-settings-btn');
  const settingsApiKey = document.getElementById('settings-api-key');
  const saveSettingsKeyBtn = document.getElementById('save-settings-key-btn');
  const settingsSavedMsg = document.getElementById('settings-saved-msg');
  const deleteKeyBtn = document.getElementById('delete-key-btn');

  // Image paste/attach controls
  const attachBtn = document.getElementById('attach-btn');
  const fileInput = document.getElementById('file-input');
  const imagePreviewArea = document.getElementById('image-preview-area');
  const imageThumbnailsContainer = document.getElementById('image-thumbnails');
  const ocrStatus = document.getElementById('ocr-status');
  
  let marksEnabled = false;
  let pendingImages = []; // Array of { dataUrl, ocrText, id }
  let currentMessageIndex = 1;

  // Initialize Theme, Size & QA Test Mode
  let isQaTestModeEnabled = false;
  const { uiTheme = 'auto', uiSize = 'normal', qaTestMode = false, showQaBtn = true } = await chrome.storage.local.get(['uiTheme', 'uiSize', 'qaTestMode', 'showQaBtn']);
  document.documentElement.setAttribute('data-theme', uiTheme);
  document.documentElement.setAttribute('data-size', uiSize);
  
  const toggleTestBtn = document.getElementById('toggle-test-btn');
  if (toggleTestBtn) {
    toggleTestBtn.style.display = showQaBtn ? 'flex' : 'none';
  }
  
  const settingsShowQaBtn = document.getElementById('settings-show-qa-btn');
  if (settingsShowQaBtn) {
    settingsShowQaBtn.checked = showQaBtn;
    settingsShowQaBtn.addEventListener('change', async (e) => {
      const isVisible = e.target.checked;
      await chrome.storage.local.set({ showQaBtn: isVisible });
      if (toggleTestBtn) {
        toggleTestBtn.style.display = isVisible ? 'flex' : 'none';
      }
    });
  }
  
  isQaTestModeEnabled = qaTestMode;
  updateTestModeUI();

  function updateTestModeUI() {
    if (!toggleTestBtn) return;
    if (isQaTestModeEnabled) {
      toggleTestBtn.style.color = '#ef4444'; // Red
      toggleTestBtn.style.borderColor = '#ef4444';
      toggleTestBtn.title = "Modo Testeo: Capturando Errores (Activo)";
      toggleTestBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path><path d="M9 15h6"></path><path d="M9 11h6"></path></svg> QA Test (ON)`;
    } else {
      toggleTestBtn.style.color = 'var(--text-secondary)';
      toggleTestBtn.style.borderColor = 'var(--border-color)';
      toggleTestBtn.title = "Modo Testeo: Capturar Errores (Inactivo)";
      toggleTestBtn.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path><path d="M9 15h6"></path><path d="M9 11h6"></path></svg> QA Test`;
    }
  }

  if (toggleTestBtn) {
    toggleTestBtn.addEventListener('click', async () => {
      isQaTestModeEnabled = !isQaTestModeEnabled;
      await chrome.storage.local.set({ qaTestMode: isQaTestModeEnabled });
      updateTestModeUI();
      // Notify active tab
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, { type: 'SET_TEST_MODE', enabled: isQaTestModeEnabled }).catch(()=>{});
        }
      });
    });
  }
  
  const settingsTheme = document.getElementById('settings-theme');
  if (settingsTheme) {
    settingsTheme.value = uiTheme;
    settingsTheme.addEventListener('change', async (e) => {
      const selected = e.target.value;
      await chrome.storage.local.set({ uiTheme: selected });
      document.documentElement.setAttribute('data-theme', selected);
    });
  }
  
  const settingsSize = document.getElementById('settings-size');
  if (settingsSize) {
    settingsSize.value = uiSize;
    settingsSize.addEventListener('change', async (e) => {
      const selected = e.target.value;
      await chrome.storage.local.set({ uiSize: selected });
      document.documentElement.setAttribute('data-size', selected);
    });
  }

  // Initialize Auth
  const { deepseekApiKey } = await chrome.storage.local.get('deepseekApiKey');
  if (deepseekApiKey) {
    showChatView();
    loadHistory();
  } else {
    showSetupView();
  }

  // ==========================================
  // Setup View Logic (first-time only)
  // ==========================================
  saveKeyBtn.addEventListener('click', async () => {
    const key = apiKeyInput.value.trim();
    if (key && key.startsWith('sk-')) {
      await chrome.storage.local.set({ deepseekApiKey: key });
      setupError.classList.add('hidden');
      showChatView();
      loadHistory();
    } else {
      setupError.classList.remove('hidden');
    }
  });

  apiKeyInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') saveKeyBtn.click();
  });

  // ==========================================
  // Settings Panel Logic (opens as overlay)
  // ==========================================
  settingsBtn.addEventListener('click', async () => {
    // Pre-fill with masked key
    const { deepseekApiKey } = await chrome.storage.local.get('deepseekApiKey');
    if (deepseekApiKey) {
      settingsApiKey.value = deepseekApiKey.substring(0, 5) + '•'.repeat(20);
    }
    // Pre-fill profile fields
    const { userPreferences } = await chrome.storage.local.get('userPreferences');
    if (userPreferences) {
      document.getElementById('profile-name').value = userPreferences.Nombre || '';
      document.getElementById('profile-email').value = userPreferences.Email || '';
      document.getElementById('profile-location').value = userPreferences['País/Ciudad'] || '';
      document.getElementById('profile-prefs').value = userPreferences['Preferencias Adicionales'] || '';
    }
    
    settingsSavedMsg.classList.add('hidden');
    document.getElementById('profile-saved-msg').classList.add('hidden');
    settingsPanel.classList.remove('hidden');
    
    fetchBalanceInfo();
  });
  
  function fetchBalanceInfo() {
    const card = document.getElementById('api-balance-card');
    const details = document.getElementById('balance-details');
    const fill = document.getElementById('balance-bar-fill');
    const percentTxt = document.getElementById('balance-percentage');
    
    if (!card) return;
    card.style.display = 'block';
    details.textContent = "Consultando...";
    fill.style.width = '0%';
    fill.className = 'balance-bar-fill';
    percentTxt.textContent = '--%';
    
    chrome.runtime.sendMessage({ type: 'CHECK_BALANCE' }, async (res) => {
      if (chrome.runtime.lastError || !res || res.error) {
        details.textContent = "Error al consultar saldo. " + (res?.error || "");
        return;
      }
      
      if (res.is_available !== undefined && res.balance_infos && res.balance_infos.length > 0) {
        // Find USD or fallback to the first currency
        const info = res.balance_infos.find(b => b.currency === 'USD') || res.balance_infos[0];
        let currentBal = parseFloat(info.total_balance);
        let currency = info.currency;
        
        const { max_balance_recorded = {}, manual_total_invested } = await chrome.storage.local.get(['max_balance_recorded', 'manual_total_invested']);
        const totalInvestedInput = document.getElementById('balance-total-invested');
        
        let maxBal = manual_total_invested || max_balance_recorded[currency] || currentBal;
        
        // Auto-tracker if no manual input
        if (!manual_total_invested) {
          if (currentBal > maxBal || maxBal === 0) {
            maxBal = currentBal;
            max_balance_recorded[currency] = maxBal;
            await chrome.storage.local.set({ max_balance_recorded });
          }
          if (totalInvestedInput) totalInvestedInput.value = '';
        } else {
          if (totalInvestedInput) totalInvestedInput.value = manual_total_invested;
        }
        
        if (totalInvestedInput && !totalInvestedInput.hasListener) {
          totalInvestedInput.hasListener = true;
          totalInvestedInput.addEventListener('change', async () => {
            let val = parseFloat(totalInvestedInput.value);
            if (!isNaN(val) && val > 0) {
              await chrome.storage.local.set({ manual_total_invested: val });
              fetchBalanceInfo();
            } else {
              await chrome.storage.local.remove('manual_total_invested');
              fetchBalanceInfo();
            }
          });
        }
        
        let percentage = 100;
        if (maxBal > 0) {
          percentage = Math.max(0, Math.min(100, Math.round((currentBal / maxBal) * 100)));
        }
        
        percentTxt.textContent = `${percentage}%`;
        fill.style.width = `${percentage}%`;
        details.textContent = `Disponible: ${currentBal.toFixed(2)} ${currency}`;
        
        if (percentage <= 20) {
          fill.classList.add('danger');
        } else if (percentage <= 50) {
          fill.classList.add('warning');
        }
      } else {
        details.textContent = "Información de saldo no disponible.";
      }
    });
  }

  closeSettingsBtn.addEventListener('click', () => {
    settingsPanel.classList.add('hidden');
  });

  saveSettingsKeyBtn.addEventListener('click', async () => {
    const newKey = settingsApiKey.value.trim();
    if (newKey && newKey.startsWith('sk-') && !newKey.includes('•')) {
      await chrome.storage.local.set({ deepseekApiKey: newKey });
      showToast('success', 'API Key guardada correctamente');
    } else {
      showToast('alert', 'El formato de la API Key parece incorrecto');
    }
  });

  const saveProfileBtn = document.getElementById('save-profile-btn');
  const profileSavedMsg = document.getElementById('profile-saved-msg');
  
  if (saveProfileBtn) {
    saveProfileBtn.addEventListener('click', async () => {
      const prefs = {
        Nombre: document.getElementById('profile-name').value.trim(),
        Email: document.getElementById('profile-email').value.trim(),
        'País/Ciudad': document.getElementById('profile-location').value.trim(),
        'Preferencias Adicionales': document.getElementById('profile-prefs').value.trim()
      };
      
      // Clean up empty fields
      for (const key in prefs) {
        if (!prefs[key]) delete prefs[key];
      }
      
      await chrome.storage.local.set({ userPreferences: prefs });
      showToast('success', 'Perfil guardado con éxito');
    });
  }

  deleteKeyBtn.addEventListener('click', async () => {
    await chrome.storage.local.remove('deepseekApiKey');
    settingsPanel.classList.add('hidden');
    showSetupView();
  });

  // ==========================================
  // Chat View Logic
  // ==========================================
  newChatBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_HISTORY' }, () => {
      chatHistoryContainer.innerHTML = '';
      showWelcomeCard();
      hideControlBar();
    });
  });

  function showWelcomeCard() {
    const card = document.createElement('div');
    card.className = 'welcome-card';
    card.innerHTML = `
      <div class="welcome-header">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="var(--accent-color)"><path d="M12 12 L 4.9 4.9 A 10 10 0 1 1 4.9 19.1 Z" /></svg>
        Bienvenido a tu Copiloto
      </div>
      <div class="welcome-body">
        Soy tu asistente autónomo de navegación. Puedo controlar tu navegador y realizar tareas complejas por ti.
        <ul>
          <li>👀 <strong>Ojos en la web:</strong> Analizo la estructura de la página en tiempo real.</li>
          <li>🖱️ <strong>Manos hábiles:</strong> Clic, hover, scroll, clic derecho y escribir texto.</li>
          <li>🗂️ <strong>Multi-Pestaña:</strong> Agrupa pestañas en Chrome y podré cruzar información entre ellas.</li>
          <li>🔴 <strong>Números Rojos:</strong> Usa los <span class="highlight-red">marcadores visuales</span> en pantalla para guiarme.</li>
          <li>⏸️ <strong>Control Total:</strong> Usa el botón "Detener" para pausarme y escribe "continuar" para reanudar.</li>
        </ul>
        <br>¿Qué necesitas que haga?
      </div>
    `;
    chatHistoryContainer.appendChild(card);
  }

  stopBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'PAUSE_AGENT' });
    agentStatusText.textContent = "Deteniendo agente...";
    stopBtn.disabled = true;
  });

  function showSetupView() {
    setupView.classList.remove('hidden');
    chatView.classList.add('hidden');
    apiKeyInput.value = '';
  }

  function showChatView() {
    setupView.classList.add('hidden');
    chatView.classList.remove('hidden');
    updateCurrentTabInfo();
    chatInput.focus();
    // Auto-create Tab Group on first load
    chrome.runtime.sendMessage({ type: 'CREATE_TAB_GROUP' });
  }

  function loadHistory() {
    chrome.runtime.sendMessage({ type: 'GET_HISTORY' }, (response) => {
      chatHistoryContainer.innerHTML = '';
      currentMessageIndex = 1;
      
      if (!response || !response.history || response.history.length <= 1) {
        showWelcomeCard();
        return;
      }

      response.history.forEach((msg, idx) => {
        if (idx === 0) return; // Skip SYSTEM_PROMPT
        currentMessageIndex = idx;
        if (msg.role === 'user') {
          appendMessage('user', msg.content, idx);
        } else if (msg.role === 'assistant' && msg.content) {
          appendMessage('assistant', msg.content, idx);
        }
      });
      chatHistoryContainer.scrollTop = chatHistoryContainer.scrollHeight;
    });
  }

  let mentionState = { active: false, start: -1 };
  let mentionedTabIds = [];
  const mentionPopup = document.getElementById('mention-popup');

  const addTabBtn = document.getElementById('add-tab-btn');
  if (addTabBtn) {
    addTabBtn.addEventListener('click', () => {
      if (!mentionPopup.classList.contains('hidden') && !mentionState.active) {
        closeMentionPopup();
      } else {
        showMentionPopup("", true);
      }
    });
  }

  function closeMentionPopup() {
    mentionState.active = false;
    if (mentionPopup) mentionPopup.classList.add('hidden');
  }

  function showMentionPopup(query, isDirectAdd = false) {
    chrome.runtime.sendMessage({ type: 'GET_AVAILABLE_TABS' }, (res) => {
      if (!res || !res.tabs) return;
      const filteredTabs = res.tabs.filter(t => t.title.toLowerCase().includes(query) || t.url.toLowerCase().includes(query));
      
      if (filteredTabs.length === 0) {
        if (mentionPopup) {
          mentionPopup.innerHTML = '';
          const titleDiv = document.createElement('div');
          titleDiv.style.padding = '8px 12px';
          titleDiv.style.fontSize = '11px';
          titleDiv.style.color = 'var(--text-secondary)';
          titleDiv.textContent = isDirectAdd ? 'No hay otras pestañas abiertas para añadir.' : 'No hay coincidencias.';
          mentionPopup.appendChild(titleDiv);
          mentionPopup.classList.remove('hidden');
          setTimeout(() => { if (mentionState.active === false && isDirectAdd) closeMentionPopup(); }, 3000);
        }
        return;
      }
      
      if (mentionPopup) {
        mentionPopup.innerHTML = '';
        if (isDirectAdd) {
          const titleDiv = document.createElement('div');
          titleDiv.style.padding = '8px 12px';
          titleDiv.style.fontSize = '11px';
          titleDiv.style.color = 'var(--text-secondary)';
          titleDiv.style.borderBottom = '1px solid var(--border-color)';
          titleDiv.textContent = 'Selecciona una pestaña para añadir al contexto:';
          mentionPopup.appendChild(titleDiv);
        }
        
        filteredTabs.slice(0, 10).forEach(tab => {
          const item = document.createElement('div');
          item.className = 'mention-item';
          const icon = tab.favIconUrl ? `<img src="${tab.favIconUrl}">` : `<span>📄</span>`;
          item.innerHTML = `${icon} <span class="mention-title">${tab.title}</span>`;
          item.addEventListener('click', () => {
            if (isDirectAdd) {
              closeMentionPopup();
              showControlBar("Agrupando pestaña...");
              chrome.runtime.sendMessage({ type: 'ADD_TABS_TO_GROUP', tabIds: [tab.id] }, () => {
                hideControlBar();
                updateCurrentTabInfo();
              });
            } else {
              insertMention(tab);
            }
          });
          mentionPopup.appendChild(item);
        });
        mentionPopup.classList.remove('hidden');
      }
    });
  }

  function insertMention(tab) {
    const val = chatInput.value;
    const prefix = val.substring(0, mentionState.start);
    const suffix = val.substring(chatInput.selectionStart);
    chatInput.value = `${prefix}[@${tab.title}] ${suffix}`;
    
    if (!mentionedTabIds.includes(tab.id)) {
      mentionedTabIds.push(tab.id);
    }
    
    closeMentionPopup();
    chatInput.focus();
    checkSendButton();
  }

  // Auto-resize textarea and check mentions
  chatInput.addEventListener('input', () => {
    chatInput.style.height = 'auto';
    chatInput.style.height = (chatInput.scrollHeight) + 'px';
    checkSendButton();
    
    const val = chatInput.value;
    const cursorPos = chatInput.selectionStart;
    const textBeforeCursor = val.substring(0, cursorPos);
    const lastAtPos = textBeforeCursor.lastIndexOf('@');
    
    if (lastAtPos !== -1 && (lastAtPos === 0 || /[\s\n]/.test(textBeforeCursor[lastAtPos - 1]))) {
      const query = textBeforeCursor.substring(lastAtPos + 1).toLowerCase();
      if (!query.includes(' ') && !query.includes('\n')) {
        mentionState.active = true;
        mentionState.start = lastAtPos;
        showMentionPopup(query);
      } else {
        closeMentionPopup();
      }
    } else {
      closeMentionPopup();
    }
  });

  function checkSendButton() {
    sendBtn.disabled = chatInput.value.trim().length === 0 && pendingImages.length === 0;
  }

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!sendBtn.disabled) sendBtn.click();
    }
  });

  sendBtn.addEventListener('click', async () => {
    let text = chatInput.value.trim();
    if (!text && pendingImages.length === 0) return;
    
    let displayMessage = text;
    
    // Process mentions first
    if (mentionedTabIds.length > 0) {
      showControlBar("Agrupando pestañas...");
      await new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'ADD_TABS_TO_GROUP', tabIds: mentionedTabIds }, () => resolve());
      });
      mentionedTabIds = []; // reset
    }
    
    // Append OCR text from all images to the payload sent to the agent
    if (pendingImages.length > 0) {
      let imageContext = "";
      let imageHtml = "";
      
      pendingImages.forEach((img, index) => {
        imageHtml += `<img src="${img.dataUrl}" alt="Captura de pantalla ${index + 1}">\n`;
        
        if (img.ocrText) {
          imageContext += `[Imagen ${index + 1} adjunta. Texto extraído vía OCR local:]\n"""\n${img.ocrText}\n"""\n\n`;
        } else {
          imageContext += `[Imagen ${index + 1} adjunta, pero no se pudo extraer texto vía OCR]\n\n`;
        }
      });
      
      text = imageContext + text;
      displayMessage = imageHtml + displayMessage;
      
      clearImages();
    }
    
    currentMessageIndex++;
    appendMessage('user', displayMessage, currentMessageIndex);
    chatInput.value = '';
    chatInput.style.height = 'auto';
    sendBtn.disabled = true;
    closeMentionPopup();
    
    // If user says continue, we send resume command, else regular user message
    if (text.toLowerCase() === 'continue' || text.toLowerCase() === 'continua' || text.toLowerCase() === 'continuar') {
      showControlBar("Reanudando bucle del agente...");
      chrome.runtime.sendMessage({ type: 'RESUME_AGENT' });
    } else {
      showControlBar("Pensando...");
      chrome.runtime.sendMessage({ type: 'USER_MESSAGE', payload: text }, (response) => {
        if (chrome.runtime.lastError) {
          hideControlBar();
          currentMessageIndex++;
          appendMessage('assistant', 'Error: No se pudo conectar con el servicio. ' + chrome.runtime.lastError.message, currentMessageIndex);
        }
      });
    }
  });

  function appendMessage(role, text, index) {
    const msgDiv = document.createElement('div');
    msgDiv.className = `message ${role}`;
    if (index !== undefined) {
      msgDiv.dataset.index = index;
    }
    
    if (role === 'assistant') {
      const avatarDiv = document.createElement('div');
      avatarDiv.className = 'avatar';
      avatarDiv.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="var(--accent-color)"><path d="M12 12 L 4.9 4.9 A 10 10 0 1 1 4.9 19.1 Z" /></svg>`;
      msgDiv.appendChild(avatarDiv);
    }
    
    let formattedText = text
      .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/^### (.*$)/gim, '<h3>$1</h3>')
      .replace(/^## (.*$)/gim, '<h2>$1</h2>')
      .replace(/^# (.*$)/gim, '<h1>$1</h1>')
      // Don't replace newlines if it's an image tag
      .replace(/(?!<img[^>]*>)\n/g, '<br>');

    const contentDiv = document.createElement('div');
    contentDiv.className = 'content';
    contentDiv.innerHTML = formattedText;
    
    const bodyDiv = document.createElement('div');
    bodyDiv.className = 'message-body';
    bodyDiv.appendChild(contentDiv);
    
    // Action Buttons
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'message-actions';
    
    if (role === 'assistant') {
      const copyBtn = document.createElement('button');
      copyBtn.className = 'action-btn copy-btn';
      copyBtn.title = 'Copiar mensaje';
      copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(text);
        copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
        setTimeout(() => {
          copyBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
        }, 2000);
      });
      actionsDiv.appendChild(copyBtn);
    } else if (role === 'user' && index !== undefined) {
      const editBtn = document.createElement('button');
      editBtn.className = 'action-btn edit-btn';
      editBtn.title = 'Editar y regenerar';
      editBtn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>`;
      editBtn.addEventListener('click', () => {
        enableEditMode(msgDiv, text, index);
      });
      actionsDiv.appendChild(editBtn);
    }
    
    if (actionsDiv.children.length > 0) {
      bodyDiv.appendChild(actionsDiv);
    }
    
    msgDiv.appendChild(bodyDiv);
    
    chatHistoryContainer.appendChild(msgDiv);
    chatHistoryContainer.scrollTop = chatHistoryContainer.scrollHeight;
  }
  
  function enableEditMode(msgDiv, originalText, index) {
    // Hide original content and actions
    const bodyDiv = msgDiv.querySelector('.message-body');
    const contentDiv = msgDiv.querySelector('.content');
    const actionsDiv = msgDiv.querySelector('.message-actions');
    contentDiv.style.display = 'none';
    if (actionsDiv) actionsDiv.style.display = 'none';
    
    // Create edit container
    const editContainer = document.createElement('div');
    editContainer.className = 'edit-container';
    
    const textarea = document.createElement('textarea');
    textarea.className = 'edit-textarea';
    // Remove HTML tags for images from originalText if they exist so user doesn't see raw HTML
    textarea.value = originalText.replace(/<img[^>]*>/g, '').trim();
    
    const btnRow = document.createElement('div');
    btnRow.className = 'edit-btn-row';
    
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'edit-cancel-btn';
    cancelBtn.textContent = 'Cancelar';
    cancelBtn.addEventListener('click', () => {
      editContainer.remove();
      contentDiv.style.display = '';
      if (actionsDiv) actionsDiv.style.display = '';
    });
    
    const saveBtn = document.createElement('button');
    saveBtn.className = 'edit-save-btn primary-btn-sm';
    saveBtn.textContent = 'Guardar y Enviar';
    saveBtn.addEventListener('click', () => {
      const newText = textarea.value.trim();
      if (!newText) return;
      
      // Tell backend to edit history and resubmit
      chrome.runtime.sendMessage({ type: 'EDIT_MESSAGE', index: index, payload: newText });
      
      // Reload history (this will immediately truncate visually and append the thinking state)
      setTimeout(() => {
        loadHistory();
        showControlBar("Pensando...");
      }, 300);
    });
    
    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(saveBtn);
    editContainer.appendChild(textarea);
    editContainer.appendChild(btnRow);
    
    bodyDiv.appendChild(editContainer);
    textarea.focus();
    textarea.style.height = 'auto';
    textarea.style.height = (textarea.scrollHeight) + 'px';
  }
  // --- SANDBOX COMMUNICATION ---
  function runOcrInSandbox(dataUrl) {
    return new Promise((resolve, reject) => {
      const sandbox = document.getElementById('ocr-sandbox');
      const reqId = Date.now() + Math.random().toString();
      
      const timeoutId = setTimeout(() => {
        window.removeEventListener('message', listener);
        reject(new Error("OCR Sandbox timed out. The worker might have hung."));
      }, 14000); // 14 seconds (slightly less than the 15s in background)
      
      const listener = (event) => {
        if (event.data && event.data.id === reqId) {
          window.removeEventListener('message', listener);
          clearTimeout(timeoutId);
          if (event.data.type === 'OCR_RESULT') {
            resolve(event.data.text);
          } else if (event.data.type === 'OCR_ERROR') {
            reject(new Error(event.data.error));
          }
        }
      };
      
      window.addEventListener('message', listener);
      sandbox.contentWindow.postMessage({ type: 'RUN_OCR', id: reqId, dataUrl }, '*');
    });
  }

  // --- BACKGROUND COMMUNICATION ---
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'DO_OCR') {
      runOcrInSandbox(message.dataUrl)
        .then(text => sendResponse({ text }))
        .catch(err => sendResponse({ error: err.toString() }));
      return true; // Keep channel open for async response
    }

    if (message.type === 'AGENT_SCREENSHOT') {
      const displayMessage = `<img src="${message.payload}" alt="Captura del agente">
<br><em>El agente tomó una captura de pantalla para analizar la página.</em>`;
      appendMessage('assistant', displayMessage);
    }

    if (message.type === 'CONTEXT_CHANGED') {
      loadHistory();
    }
    
    if (message.type === 'TAB_GROUP_UPDATE') {
      chrome.tabs.query({ active: true, currentWindow: true }).then(tabs => {
        if (tabs[0]) {
          const currentContextId = (tabs[0].groupId && tabs[0].groupId > 0) ? 'group_' + tabs[0].groupId : 'tab_' + tabs[0].id;
          if (message.contextId === currentContextId) {
            currentMessageIndex++;
            appendMessage('assistant', `ℹ️ *Sistema*: La pestaña "${message.tabTitle}" se ha unido a este grupo. Ahora puedo leer e interactuar con ambas ventanas.`, currentMessageIndex);
          }
        }
      });
    }
  });

  // --- EVENT LISTENERS ---
  attachBtn.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', (e) => {
    if (e.target.files && e.target.files[0]) {
      processImage(e.target.files[0]);
    }
  });

  chatInput.addEventListener('paste', (e) => {
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (const item of items) {
      if (item.type.indexOf('image') === 0) {
        e.preventDefault();
        const file = item.getAsFile();
        processImage(file);
        break;
      }
    }
  });

  function clearImages() {
    pendingImages = [];
    imagePreviewArea.classList.add('hidden');
    imageThumbnailsContainer.innerHTML = '';
    fileInput.value = '';
    checkSendButton();
  }

  function renderThumbnails() {
    imageThumbnailsContainer.innerHTML = '';
    
    if (pendingImages.length === 0) {
      imagePreviewArea.classList.add('hidden');
      return;
    }
    
    imagePreviewArea.classList.remove('hidden');
    
    pendingImages.forEach(img => {
      const container = document.createElement('div');
      container.className = 'thumbnail-container';
      
      const imgEl = document.createElement('img');
      imgEl.src = img.dataUrl;
      
      const removeBtn = document.createElement('button');
      removeBtn.className = 'remove-image-btn';
      removeBtn.innerHTML = '✕';
      removeBtn.title = 'Quitar imagen';
      
      removeBtn.addEventListener('click', () => {
        pendingImages = pendingImages.filter(p => p.id !== img.id);
        renderThumbnails();
        checkSendButton();
      });
      
      container.appendChild(imgEl);
      container.appendChild(removeBtn);
      imageThumbnailsContainer.appendChild(container);
    });
  }

  function processImage(file) {
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = async (e) => {
      const dataUrl = e.target.result;
      const imgId = Date.now() + Math.random().toString(36).substr(2, 9);
      
      const imgObj = { id: imgId, dataUrl: dataUrl, ocrText: null };
      pendingImages.push(imgObj);
      
      renderThumbnails();
      
      ocrStatus.classList.remove('hidden');
      ocrStatus.textContent = "Extrayendo texto de la imagen...";
      checkSendButton();
      
      try {
        const text = await runOcrInSandbox(dataUrl);
        
        // Find the image object in the array and update it
        const targetImg = pendingImages.find(p => p.id === imgId);
        if (targetImg) {
          targetImg.ocrText = text;
        }
        ocrStatus.textContent = "¡Texto extraído! Listo para enviar.";
        setTimeout(() => ocrStatus.classList.add('hidden'), 2000);
      } catch (err) {
        console.error("OCR Error:", err);
        ocrStatus.textContent = "Error al extraer texto.";
        setTimeout(() => ocrStatus.classList.add('hidden'), 3000);
      }
    };
    reader.readAsDataURL(file);
  }

  function showControlBar(status) {
    agentControlBar.classList.remove('hidden');
    agentStatusText.textContent = status;
    stopBtn.disabled = false;
  }

  function hideControlBar() {
    agentControlBar.classList.add('hidden');
  }

  async function updateCurrentTabInfo() {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      const activeTab = tabs[0];
      if (activeTab) {
        if (activeTab.groupId && activeTab.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE) {
          const groupTabs = await chrome.tabs.query({ groupId: activeTab.groupId });
          let chipsHtml = `<div style="display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none; width: 100%; align-items: center; mask-image: linear-gradient(to right, black 85%, transparent 100%); -webkit-mask-image: linear-gradient(to right, black 85%, transparent 100%); padding-right: 16px;">`;
          groupTabs.forEach(t => {
            const icon = t.favIconUrl ? `<img src="${t.favIconUrl}" style="width: 12px; height: 12px; border-radius: 2px;">` : `<span style="font-size: 10px;">📄</span>`;
            chipsHtml += `<div style="display: flex; align-items: center; gap: 4px; background-color: rgba(0, 168, 255, 0.1); border: 1px solid rgba(0, 168, 255, 0.3); color: var(--text-primary); padding: 2px 8px; border-radius: 12px; font-size: 11px; white-space: nowrap; max-width: 120px;">
              ${icon}
              <span style="overflow: hidden; text-overflow: ellipsis; font-weight: 500;">${t.title}</span>
            </div>`;
          });
          chipsHtml += `</div>`;
          currentTabDomain.innerHTML = chipsHtml;
        } else {
          try {
            const url = new URL(activeTab.url);
            const icon = activeTab.favIconUrl ? `<img src="${activeTab.favIconUrl}" style="width: 12px; height: 12px; border-radius: 2px;">` : `<span style="font-size: 10px;">📄</span>`;
            currentTabDomain.innerHTML = `<div style="display: flex; align-items: center; gap: 4px; background-color: var(--bg-surface); border: 1px solid var(--border-color); color: var(--text-secondary); padding: 2px 8px; border-radius: 12px; font-size: 11px; white-space: nowrap;">
              ${icon}
              <span style="overflow: hidden; text-overflow: ellipsis; max-width: 150px;">${url.hostname}</span>
            </div>`;
          } catch(e) {
            currentTabDomain.textContent = "Nueva Pestaña";
          }
        }
      }
    });
  }

  chrome.tabs.onActivated.addListener(updateCurrentTabInfo);
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url) updateCurrentTabInfo();
  });

  // Listen for messages from background
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'ASSISTANT_RESPONSE') {
      hideControlBar();
      appendMessage('assistant', message.payload);
    } else if (message.type === 'ASSISTANT_ERROR') {
      hideControlBar();
      appendMessage('assistant', `**Error:** ${message.payload}`);
    } else if (message.type === 'STATUS_UPDATE') {
      showControlBar(message.payload);
    } else if (message.type === 'AGENT_PAUSED') {
      hideControlBar();
      appendMessage('assistant', '*Agente detenido. Escribe "continuar" para retomar la tarea.*');
    }
  });

  // --- Toast System ---
  function showToast(type, message) {
    const container = document.getElementById('toast-container');
    if (!container) return;
    
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    let iconSvg = '';
    if (type === 'success') {
      iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path><polyline points="22 4 12 14.01 9 11.01"></polyline></svg>`;
    } else if (type === 'alert') {
      iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`;
    } else if (type === 'error') {
      iconSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`;
    }
    
    toast.innerHTML = `
      <div class="toast-icon">${iconSvg}</div>
      <div class="toast-message">${message}</div>
    `;
    
    container.appendChild(toast);
    
    setTimeout(() => {
      toast.classList.add('fade-out');
      toast.addEventListener('animationend', () => toast.remove());
    }, 3000);
  }
});
