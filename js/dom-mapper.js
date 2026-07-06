(function() {
if (window.DOMMapper) return;

class DOMMapper {
  constructor() {
    this.elementMap = new Map(); // id -> HTMLElement
    this.nextId = 1;
    this.showMarks = false; // Marks are OFF by default
  }

  // Identify if an element is interactive (REFINED: catches custom dropdowns)
  isInteractive(el) {
    const tagName = el.tagName ? el.tagName.toLowerCase() : '';
    
    // Core interactive elements
    if (['a', 'button', 'input', 'select', 'textarea'].includes(tagName)) return true;
    
    // ARIA roles (including dropdown options)
    const role = el.getAttribute('role');
    if (['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'slider', 'option', 'listitem', 'treeitem'].includes(role)) return true;
    
    // Rich text editors (like Gemini's chat input)
    if (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false') return true;
    if (['textbox', 'searchbox', 'combobox', 'listbox', 'menu'].includes(role)) return true;
    
    // Elements with explicit click handlers
    if (el.hasAttribute('onclick')) return true;
    
    // Custom dropdown options: <li> inside a listbox, menu, or dropdown container
    if (tagName === 'li') {
      const parent = el.closest('[role="listbox"], [role="menu"], [class*="dropdown"], [class*="select"], [class*="menu"], [class*="options"], [class*="popover"], [class*="overlay"]');
      if (parent) return true;
    }
    
    // Elements with data-value, data-option (common in custom selects)
    if (el.hasAttribute('data-value') || el.hasAttribute('data-option') || el.hasAttribute('data-key')) return true;
    
    // Only mark tabIndex elements if they also have an aria-label (meaningful)
    if (el.tabIndex >= 0 && el.hasAttribute('aria-label') && tagName !== 'body' && tagName !== 'html') return true;
    
    // cursor:pointer ONLY if the element is "leaf-like" (no interactive children)
    try {
      if (window.getComputedStyle(el).cursor === 'pointer') {
        const hasInteractiveChild = el.querySelector('a, button, input, select, textarea, [role="button"], [role="link"]');
        if (!hasInteractiveChild && el.textContent.trim().length > 0 && el.textContent.trim().length < 200) {
          return true;
        }
      }
    } catch(e) {}
    
    return false;
  }

  // Check if element is visible AND in viewport
  isVisible(el) {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 5 || rect.height < 5) return false;
    // Only map elements within the visible viewport (± small margin)
    if (rect.bottom < -50 || rect.top > window.innerHeight + 50) return false;
    if (rect.right < -50 || rect.left > window.innerWidth + 50) return false;
    return true;
  }

  // Check if an element is obscured by a backdrop/modal overlay
  isObscured(el, rect) {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    
    // If center is outside viewport, we can't reliably check occlusion via elementFromPoint
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return false;
    
    const topEl = document.elementFromPoint(cx, cy);
    if (!topEl) return false;
    
    // If the top element is the element itself, a child, or a parent wrapper, it's not obscured.
    if (topEl === el || el.contains(topEl) || topEl.contains(el)) {
      return false;
    }
    
    // If we reach here, topEl is some other sibling or overlay covering this element.
    return true;
  }

  // Calculate Spatial Position
  getSpatialPosition(rect) {
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    let yPos = "Center";
    if (rect.top < vh / 3) yPos = "Top";
    else if (rect.bottom > (vh / 3) * 2) yPos = "Bottom";
    let xPos = "Center";
    if (rect.left < vw / 3) xPos = "Left";
    else if (rect.right > (vw / 3) * 2) xPos = "Right";
    return `${yPos}-${xPos}`;
  }

  // Create Visual Mark (Set of Mark) — only when enabled
  createVisualMark(id, rect) {
    if (!this.showMarks) return;
    
    const mark = document.createElement('div');
    mark.className = 'deepseek-som-mark';
    mark.textContent = id;
    
    const scrollX = window.scrollX || window.pageXOffset;
    const scrollY = window.scrollY || window.pageYOffset;
    
    Object.assign(mark.style, {
      position: 'absolute',
      top: `${rect.top + scrollY - 8}px`,
      left: `${rect.left + scrollX - 8}px`,
      backgroundColor: 'rgba(0, 168, 255, 0.85)',
      color: 'white',
      padding: '1px 4px',
      fontSize: '10px',
      fontWeight: 'bold',
      borderRadius: '3px',
      zIndex: '2147483647',
      pointerEvents: 'none',
      boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
      border: '1px solid rgba(255,255,255,0.6)',
      fontFamily: 'monospace',
      lineHeight: '1.2'
    });
    
    document.body.appendChild(mark);
  }

  // Remove all visual marks from the page
  clearMarks() {
    document.querySelectorAll('.deepseek-som-mark').forEach(el => el.remove());
  }

  // Traverse DOM and build simplified text representation
  extractPage() {
    this.elementMap.clear();
    this.nextId = 1;
    
    // Always clean up old marks and IDs
    this.clearMarks();
    document.querySelectorAll('[data-deepseek-id]').forEach(el => el.removeAttribute('data-deepseek-id'));

    const result = this.traverse(document.body, 0).trim();
    
    // Auto-hide marks after 8 seconds (agent should be done reading by then)
    if (this.showMarks) {
      setTimeout(() => this.clearMarks(), 8000);
    }
    
    return result;
  }

  traverse(node, depth) {
    if (depth > 150) return '';

    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent.trim();
      if (!text) return '';
      // We only emit text if its parent element is visible (within viewport)
      const parent = node.parentElement;
      if (parent && this.isVisible(parent)) {
        return text + ' ';
      }
      return '';
    }

    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    
    const el = node;
    const tagName = el.tagName.toLowerCase();

    if (['script', 'style', 'noscript', 'iframe', 'svg', 'path', 'link', 'meta'].includes(tagName)) return '';
    if (el.classList && el.classList.contains('deepseek-som-mark')) return '';

    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return '';

    let output = '';
    const isVisible = this.isVisible(el);
    const isInt = isVisible && this.isInteractive(el);
    let id = null;

    if (isInt) {
      const rect = el.getBoundingClientRect();
      const obscured = this.isObscured(el, rect);
      
      id = this.nextId++;
      el.setAttribute('data-deepseek-id', id);
      this.elementMap.set(id.toString(), el);
      
      this.createVisualMark(id, rect);

      let elementType = tagName;
      if (tagName === 'input') elementType += `(${el.type || 'text'})`;
      
      const spatialPos = this.getSpatialPosition(rect);
      
      output += `\n[ID:${id}] ${elementType} [Pos:${spatialPos}]`;
      if (obscured) output += ` [⚠️ BLOCKED BY OVERLAY]`;
      output += `: `;
      
      const ariaLabel = el.getAttribute('aria-label');
      const title = el.getAttribute('title');
      const innerText = el.textContent.trim().substring(0, 80);
      
      if (ariaLabel) output += `aria-label="${ariaLabel}" `;
      else if (title) output += `title="${title}" `;
      else if (innerText && innerText.length < 60) output += `text="${innerText}" `;
      
      if (tagName === 'input' || tagName === 'textarea') {
        if (el.value) output += `value="${el.value}" `;
        if (el.placeholder) output += `placeholder="${el.placeholder}" `;
      }
      if (el.href) output += `href="${el.href}" `;
    }

    // Traverse children
    for (const child of el.childNodes) {
      output += this.traverse(child, depth + 1);
    }

    // Pierce Shadow DOM
    if (el.shadowRoot) {
      for (const child of el.shadowRoot.childNodes) {
        output += this.traverse(child, depth + 1);
      }
    }

    if (isInt) output += '\n';

    return output;
  }

  showCursorInteraction(x, y, action) {
    return new Promise(resolve => {
      let cursor = document.getElementById('deepseek-simulated-cursor');
      if (!cursor) {
        cursor = document.createElement('div');
        cursor.id = 'deepseek-simulated-cursor';
        // Base SVG pointer
        cursor.innerHTML = `
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M5.5 3.21V20.8C5.5 21.45 6.27 21.79 6.75 21.36L11.08 17.43C11.31 17.22 11.62 17.11 11.94 17.14L17.29 17.65C17.94 17.71 18.38 16.98 17.98 16.44L5.5 3.21Z" fill="#00a8ff" stroke="white" stroke-width="1.5" stroke-linejoin="round"/>
          </svg>
        `;
        cursor.style.position = 'fixed';
        cursor.style.pointerEvents = 'none';
        cursor.style.zIndex = '2147483647';
        // Use a smooth, realistic ease-out curve for mouse movement
        cursor.style.transition = 'all 0.4s cubic-bezier(0.25, 1, 0.5, 1)';
        cursor.style.left = `${window.innerWidth / 2}px`;
        cursor.style.top = `${window.innerHeight / 2}px`;
        cursor.style.filter = 'drop-shadow(0px 3px 6px rgba(0,0,0,0.4))';
        cursor.style.marginLeft = '-4px'; // Center the tip of the cursor
        cursor.style.marginTop = '-2px';
        document.body.appendChild(cursor);
        
        // Force reflow
        cursor.getBoundingClientRect();
      }
      
      // Move cursor
      cursor.style.left = `${x}px`;
      cursor.style.top = `${y}px`;
      
      // Wait for movement to finish
      setTimeout(() => {
        if (action === 'click' || action === 'type' || action === 'right_click') {
          // Ripple effect
          const ripple = document.createElement('div');
          ripple.style.position = 'absolute';
          ripple.style.left = `${x}px`;
          ripple.style.top = `${y}px`;
          ripple.style.width = '20px';
          ripple.style.height = '20px';
          ripple.style.borderRadius = '50%';
          ripple.style.backgroundColor = 'rgba(0, 168, 255, 0.4)';
          ripple.style.pointerEvents = 'none';
          ripple.style.zIndex = '2147483646';
          ripple.style.boxShadow = '0 0 15px rgba(0, 168, 255, 0.8)';
          
          ripple.style.transition = 'all 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
          ripple.style.transform = 'translate(-50%, -50%) scale(0)';
          ripple.style.opacity = '1';
          
          document.body.appendChild(ripple);
          
          requestAnimationFrame(() => {
            ripple.style.transform = 'scale(3)';
            ripple.style.opacity = '0';
          });
          
          setTimeout(() => {
            if (ripple.parentNode) ripple.parentNode.removeChild(ripple);
            resolve();
          }, 300); // resolve slightly before ripple completely fades
        } else {
          resolve(); // For hover, resolve immediately after moving
        }
      }, 400); // 400ms matches the CSS transition duration
    });
  }

  async executeAction({action, targetId, value, direction, key}) {
    if (action === 'scroll') {
      const scrollAmount = window.innerHeight * 0.8;
      
      if (targetId !== undefined && targetId !== null) {
        const target = this.elementMap.get(targetId.toString()) || document.querySelector(`[data-deepseek-id="${targetId}"]`);
        if (target) {
          target.scrollBy({ top: direction === 'down' ? scrollAmount : -scrollAmount, behavior: 'smooth' });
          return `Scrolled ${direction} inside element [ID:${targetId}].`;
        }
      }
      
      // Try to find the largest scrollable container if window scrolling isn't enough
      const scrollableElements = Array.from(document.querySelectorAll('*')).filter(el => {
        const style = window.getComputedStyle(el);
        return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
      });
      
      // Sort by area to find the main container
      scrollableElements.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight));
      
      if (scrollableElements.length > 0 && scrollableElements[0] !== document.documentElement && scrollableElements[0] !== document.body) {
        scrollableElements[0].scrollBy({ top: direction === 'down' ? scrollAmount : -scrollAmount, behavior: 'smooth' });
        return `Scrolled ${direction} on main scrollable container.`;
      }
      
      window.scrollBy({ top: direction === 'down' ? scrollAmount : -scrollAmount, behavior: 'smooth' });
      return `Scrolled ${direction} on main window.`;
    }

    if (targetId === undefined || targetId === null) {
      throw new Error("Missing target_id for action: " + action);
    }
    const el = this.elementMap.get(targetId.toString());
    if (!el) {
      const fallback = document.querySelector(`[data-deepseek-id="${targetId}"]`);
      if (!fallback) throw new Error(`Element with ID ${targetId} not found on page. The page layout has likely changed and IDs have been regenerated. Please examine the latest [CURRENT WEBPAGE CONTEXT] provided in your prompt to find the NEW ID for the element you want to interact with.`);
      this.elementMap.set(targetId.toString(), fallback);
    }
    
    const target = this.elementMap.get(targetId.toString());

    // Automatically scroll the target into view before interacting
    if (['click', 'type', 'hover', 'right_click'].includes(action)) {
      try {
        target.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
        // Give the browser a tiny moment to complete the instant scroll
        await new Promise(r => setTimeout(r, 50));
      } catch (e) {}
    }

    if (action === 'click') {
      const rect = target.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      
      await this.showCursorInteraction(cx, cy, action);
      
      // Let background.js handle the actual click via Debugger API
      return JSON.stringify({ status: 'success', cx, cy, message: `Prepared for native click at (${cx}, ${cy}).` });
    }
    else if (action === 'right_click') {
      const rect = target.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      await this.showCursorInteraction(cx, cy, action);
      
      return JSON.stringify({ status: 'success', cx, cy, message: `Prepared for native right-click at (${cx}, ${cy}).` });
    }
    else if (action === 'hover') {
      const rect = target.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      await this.showCursorInteraction(cx, cy, action);
      
      return JSON.stringify({ status: 'success', cx, cy, message: `Prepared for native hover at (${cx}, ${cy}).` });
    }
    else if (action === 'type') {
      const rect = target.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      await this.showCursorInteraction(cx, cy, action);
      
      target.focus();
      
      // Select all existing text so insertText replaces it
      if (target.setSelectionRange) {
        try {
          target.setSelectionRange(0, target.value.length);
        } catch(e) {}
      } else if (window.getSelection && document.createRange) {
        const range = document.createRange();
        range.selectNodeContents(target);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      } else {
        target.select && target.select();
      }

      // No need to dispatch events or use execCommand here.
      // No need to dispatch events or use execCommand here.
      // The background script will use chrome.debugger to type.
      return `Focused element [ID:${targetId}] and prepared for debugger typing.`;
    }
    else if (action === 'press_key') {
      const rect = target.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      await this.showCursorInteraction(cx, cy, action);
      
      target.focus();
      // The background script will use chrome.debugger to press the key.
      return `Focused element [ID:${targetId}] and prepared for debugger key press.`;
    }
    else if (action === 'upload_file') {
      const rect = target.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      await this.showCursorInteraction(cx, cy, action);
      
      if (target.tagName.toLowerCase() !== 'input' || target.type !== 'file') {
        throw new Error("Target is not an input type=file.");
      }
      
      // Create a dummy file
      const fileContent = "This is a dummy file created by Lumi AI for automation purposes.";
      const file = new File([fileContent], "dummy_upload.txt", { type: "text/plain", lastModified: new Date().getTime() });
      
      // Create a DataTransfer object to simulate file drag/drop or selection
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      
      target.files = dataTransfer.files;
      target.dispatchEvent(new Event('change', { bubbles: true }));
      
      return `Uploaded dummy file 'dummy_upload.txt' to element [ID:${targetId}].`;
    }

    throw new Error(`Unknown action: ${action}`);
  }

  // Programmatic fallback: dispatches real DOM events when debugger API is unavailable
  async executeProgrammatic({action, targetId, value, key, forceType, forceKey}) {
    if (targetId === undefined || targetId === null) {
      throw new Error("Missing target_id for programmatic action: " + action);
    }
    let el = this.elementMap.get(targetId.toString());
    if (!el) {
      el = document.querySelector(`[data-deepseek-id="${targetId}"]`);
      if (!el) throw new Error(`Element with ID ${targetId} not found for programmatic action.`);
    }

    if (action === 'click' || (action === undefined && !forceType && !forceKey)) {
      el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      await new Promise(r => setTimeout(r, 50));

      el.focus();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

      if (el.tagName === 'A' && el.href) {
        await new Promise(r => setTimeout(r, 100));
      }

      return `Programmatic click on element [ID:${targetId}] completed.`;
    }

    if (action === 'right_click') {
      el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      await new Promise(r => setTimeout(r, 50));

      el.focus();
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, view: window }));

      return `Programmatic right-click on element [ID:${targetId}] completed.`;
    }

    if (action === 'hover') {
      el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      await new Promise(r => setTimeout(r, 50));

      el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));

      return `Programmatic hover on element [ID:${targetId}] completed.`;
    }

    if (forceType && value) {
      el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      await new Promise(r => setTimeout(r, 50));
      el.focus();

      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        if (el.setSelectionRange) {
          try { el.setSelectionRange(0, el.value.length); } catch(e) {}
        }
        el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false') {
        el.textContent = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }

      return `Programmatic typing of "${value}" into element [ID:${targetId}] completed.`;
    }

    if (forceKey && key) {
      el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
      await new Promise(r => setTimeout(r, 50));
      el.focus();

      const keyCode = key === 'Enter' ? 13 : key === 'Escape' ? 27 : key === 'Tab' ? 9 : 0;
      const keyName = key === 'Enter' ? 'Enter' : key === 'Escape' ? 'Escape' : key === 'Tab' ? 'Tab' : key;

      el.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, keyCode, code: keyName, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keypress', { key: keyName, keyCode, code: keyName, bubbles: true, cancelable: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: keyName, keyCode, code: keyName, bubbles: true, cancelable: true }));

      return `Programmatic key press "${key}" on element [ID:${targetId}] completed.`;
    }

    throw new Error(`Unknown programmatic action: ${action}`);
  }
}

window.DOMMapper = DOMMapper;

})();
