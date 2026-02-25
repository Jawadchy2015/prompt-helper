(() => {
  const API_BASE = "http://localhost:8787";
  const DEBOUNCE_MS = 550;

  let bypassNextSendIntercept = false;
  let activeInput = null;
  let lastTextSent = "";
  let currentGhost = "";
  let debounceTimer = null;
  let observer = null;

  let finalGateActive = false;
  let pendingFinal = null; // { original, rewritten, editorEl }
  let finalDiv = null;

  // --- UI overlay (ghost suggestion) ---
  const ghostEl = document.createElement("div");
  ghostEl.id = "ph-ghost";
  ghostEl.innerHTML = `<div id="ph-ghost-text"></div><div class="ph-hint">Tab: accept • Esc: dismiss</div>`;
  document.documentElement.appendChild(ghostEl);

  function normalizeSuggestion(s) {
    if (!s) return "";
    let out = s.trim();
    out = out.replace(/^(add|suggestion|append)\s*[:\-]?\s*/i, "");
    out = out.replace(/^add\s+/i, "");
    return out;
  }

  // --- Final rewrite overlay ---
  function ensureFinalDiv() {
    if (finalDiv) return finalDiv;

    finalDiv = document.createElement("div");
    finalDiv.id = "ph-final";
    finalDiv.style.display = "none";
    finalDiv.innerHTML = `
      <div class="ph-title">Rewrite suggestion (press Enter to use, Esc to keep yours)</div>
      <div class="ph-body"></div>
      <div class="ph-hint">Enter = send rewritten • Esc = send original</div>
    `;
    document.body.appendChild(finalDiv);
    return finalDiv;
  }

  function showFinalDiv(text) {
    const div = ensureFinalDiv();
    div.querySelector(".ph-body").textContent = text;
    div.style.display = "block";
  }

  function hideFinalDiv() {
    if (finalDiv) finalDiv.style.display = "none";
  }

  // Prefer the editor element that actually received the key event
  function getEditorFromEventTarget(t) {
    if (!t) return null;
    return (t.closest && t.closest("textarea, input, [contenteditable='true']")) || null;
  }

  async function requestFinalRewrite(text) {
    try {
      const res = await fetch(`${API_BASE}/suggestFinal`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      });
      const data = await res.json();
      return (data?.rewritten || "").trim();
    } catch {
      return "";
    }
  }

  async function requestSuggestion(text) {
    try {
      const res = await fetch(`${API_BASE}/suggest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text })
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      return (data && data.ghostText) || "";
    } catch (e) {
      console.warn("[PromptHelper] Suggest request failed:", e.message || e);
      return "";
    }
  }

  function getInputText(el) {
    if (!el) return "";
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") return el.value || "";
    if (el.isContentEditable) return el.textContent || "";
    return "";
  }

  function getText(el) {
    if (!el) return "";
    if (el.tagName === "TEXTAREA") return el.value || "";
    if (el.getAttribute("contenteditable") === "true") return el.textContent || "";
    return "";
  }

  // -------------------------------
  // COMPOSER: find textarea + form + send button (tied together)
  // -------------------------------
  function getComposerTextarea(editorEl) {
    // Most reliable on chatgpt.com
    const byId = document.querySelector("textarea#prompt-textarea");
    if (byId) return byId;

    // Next best: textarea in the same form as the editor target
    const form = editorEl?.closest?.("form");
    if (form) {
      const t = form.querySelector("textarea");
      if (t) return t;
    }

    // Fallback: the largest visible textarea near bottom
    const textareas = Array.from(document.querySelectorAll("textarea"));
    const visible = textareas
      .map(t => ({ t, r: t.getBoundingClientRect() }))
      .filter(x => x.r.width > 80 && x.r.height > 20 && x.r.bottom > 0)
      .sort((a, b) => (b.r.bottom + b.r.width * b.r.height) - (a.r.bottom + a.r.width * a.r.height));
    return visible[0]?.t || null;
  }

  function getComposerForm(editorEl) {
    const t = getComposerTextarea(editorEl);
    return t?.closest?.("form") || editorEl?.closest?.("form") || null;
  }

  function getComposerSendButton(editorEl) {
    const form = getComposerForm(editorEl);

    // Prefer send button within the composer form
    if (form) {
      const btnInForm =
        form.querySelector('button[data-testid="send-button"]') ||
        form.querySelector('button[aria-label="Send prompt"]') ||
        form.querySelector('button[aria-label="Send message"]') ||
        form.querySelector('button[type="submit"]');

      if (btnInForm) return btnInForm;
    }

    // Fallback (page-level)
    return (
      document.querySelector('button[data-testid="send-button"]') ||
      document.querySelector('button[aria-label="Send prompt"]') ||
      document.querySelector('button[aria-label="Send message"]') ||
      document.querySelector('form button[type="submit"]')
    );
  }

  function setComposerText(editorEl, text) {
    const t = getComposerTextarea(editorEl);

    if (!t) return false;

    t.focus();

    // Native setter (React-safe)
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    )?.set;

    if (setter) setter.call(t, text);
    else t.value = text;

    // Events ChatGPT/React listens for
    t.dispatchEvent(new Event("input", { bubbles: true }));
    t.dispatchEvent(new Event("change", { bubbles: true }));

    return true;
  }

  function rafTick() {
    return new Promise(resolve => requestAnimationFrame(() => resolve()));
  }

  async function sendComposer(editorEl) {
    // Wait a couple frames so ChatGPT internal state catches up
    await rafTick();
    await rafTick();

    const btn = getComposerSendButton(editorEl);
    if (btn && !btn.disabled) {
      btn.click();
      return true;
    }

    // If button not found, dispatch submit on form as fallback
    const form = getComposerForm(editorEl);
    if (form) {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      return true;
    }

    return false;
  }

  // --- Ghost positioning ---
  function positionGhostNearInput() {
    if (!activeInput) return;

    const rect = activeInput.getBoundingClientRect();
    const top = Math.max(10, rect.top - 56);
    const left = Math.max(10, rect.left);

    ghostEl.style.top = `${top}px`;
    ghostEl.style.left = `${left}px`;
  }

  window.addEventListener("resize", () => positionGhostNearInput(), { passive: true });
  window.addEventListener("scroll", () => positionGhostNearInput(), { passive: true });

  function setGhost(text) {
    currentGhost = text || "";
    const textEl = ghostEl.querySelector("#ph-ghost-text");
    if (!textEl) return;

    if (!currentGhost.trim()) {
      ghostEl.style.display = "none";
      textEl.textContent = "";
      return;
    }

    textEl.textContent = currentGhost;
    positionGhostNearInput();
    ghostEl.style.display = "block";
  }

  function clearGhost() {
    setGhost("");
  }

  // --- Input detection (textarea or contenteditable) ---
  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style && style.visibility !== "hidden" && style.display !== "none";
  }

  function findChatInput() {
    const candidates = [];
    document.querySelectorAll("textarea").forEach(el => candidates.push(el));
    document.querySelectorAll("[contenteditable='true']").forEach(el => candidates.push(el));

    let best = null;
    let bestScore = -Infinity;

    for (const el of candidates) {
      if (!isVisible(el)) continue;

      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area < 5000) continue;

      const bottomBias = r.bottom;
      const editable = el.tagName === "TEXTAREA" || el.getAttribute("contenteditable") === "true";

      let score = 0;
      score += editable ? 50 : 0;
      score += Math.min(2000, area / 200);
      score += bottomBias / 10;
      score -= (r.top < 0 ? 100 : 0);

      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    return best;
  }

  function onInput() {
    if (!activeInput) return;
    if (finalGateActive) return;

    const text = getText(activeInput).trimEnd();
    if (text.trim().length < 8) {
      clearGhost();
      return;
    }

    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      if (text === lastTextSent) return;
      lastTextSent = text;

      const ghost = await requestSuggestion(text);

      const ae = document.activeElement;
      const stillActive = ae === activeInput || (activeInput.contains && activeInput.contains(ae));
      if (!stillActive) return;

      if (ghost && text.endsWith(ghost)) {
        clearGhost();
        return;
      }

      setGhost(ghost);
    }, DEBOUNCE_MS);
  }

  function attachToInput(el) {
    if (!el || el === activeInput) return;

    if (activeInput) {
      activeInput.removeEventListener("input", onInput);
    }

    activeInput = el;
    lastTextSent = "";
    clearGhost();

    activeInput.addEventListener("input", onInput);

    positionGhostNearInput();
    console.log("[PromptHelper] Attached to input:", activeInput);
  }

  // ==============================
  // KEYDOWN (FINAL REWRITE GATE)
  // ==============================
  document.addEventListener(
    "keydown",
    async (e) => {
      // Allow our own bypass once (mainly for safety)
      if (bypassNextSendIntercept) {
        bypassNextSendIntercept = false;
        return;
      }

      // Gate mode: user is choosing rewritten vs original
      if (finalGateActive) {
        if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation?.();

          const { rewritten, editorEl } = pendingFinal || {};
          hideFinalDiv();
          finalGateActive = false;

          if (rewritten && editorEl) {
            setComposerText(editorEl, rewritten);
            // IMPORTANT: send from composer form/button tied to textarea
            await sendComposer(editorEl);
          }

          pendingFinal = null;
          return;
        }

        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation?.();

          const { original, editorEl } = pendingFinal || {};
          hideFinalDiv();
          finalGateActive = false;

          if (original != null && editorEl) {
            setComposerText(editorEl, original);
            await sendComposer(editorEl);
          }

          pendingFinal = null;
          return;
        }

        // While gating, block other keys so ChatGPT doesn't react
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation?.();
        return;
      }

      // Normal mode: intercept "send" Enter (not Shift+Enter)
      const isSendEnter =
        e.key === "Enter" &&
        !e.shiftKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.metaKey;

      if (!isSendEnter) return;

      const editorEl = getEditorFromEventTarget(e.target) || activeInput;
      if (!editorEl) return;

      const original = getInputText(editorEl).trim();
      if (!original) return;

      // Block ChatGPT sending immediately
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation?.();

      const snapshot = original;
      const rewritten = await requestFinalRewrite(original);

      // If user changed text while waiting, abort
      if (getInputText(editorEl).trim() !== snapshot) return;

      // No rewrite needed → just send what user wrote (from the composer)
      if (!rewritten || rewritten === original) {
        setComposerText(editorEl, original);
        await sendComposer(editorEl);
        return;
      }

      // Rewrite exists → show gate
      clearGhost();
      pendingFinal = { original, rewritten, editorEl };
      finalGateActive = true;
      showFinalDiv(rewritten);
    },
    true // capture
  );

  // ==============================
  // KEYDOWN (GHOST ACCEPT)
  // ==============================
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      clearGhost();
      return;
    }

    if (e.key === "Tab" && currentGhost) {
      if (!activeInput) return;

      const ae = document.activeElement;
      const focused = ae === activeInput || (activeInput.contains && activeInput.contains(ae));
      if (!focused) return;

      e.preventDefault();

      let ghost = normalizeSuggestion(currentGhost);
      if (!ghost) {
        clearGhost();
        return;
      }

      if (activeInput.tagName === "TEXTAREA" || activeInput.tagName === "INPUT") {
        const existing = activeInput.value;
        const spacer = (existing && !/\s$/.test(existing) && !/^[.,!?;:)\]]/.test(ghost)) ? " " : "";
        activeInput.value = existing + spacer + ghost;
        activeInput.dispatchEvent(new Event("input", { bubbles: true }));
        activeInput.focus();
      } else if (activeInput.isContentEditable) {
        // Keeping your current approach here for simplicity
        activeInput.focus();
        document.execCommand("insertText", false, " " + ghost);
        activeInput.dispatchEvent(new Event("input", { bubbles: true }));
      }

      clearGhost();
    }
  });

  // Observe DOM changes because ChatGPT often re-renders
  function startObserver() {
    if (observer) observer.disconnect();

    observer = new MutationObserver(() => {
      const el = findChatInput();
      if (el) attachToInput(el);
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }

  function init() {
    const el = findChatInput();
    if (el) attachToInput(el);
    startObserver();

    setInterval(() => {
      const el2 = findChatInput();
      if (el2) attachToInput(el2);
    }, 2000);

    console.log("[PromptHelper] Initialized.");
  }

  init();
})();