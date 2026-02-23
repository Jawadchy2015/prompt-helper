(() => {
  const API_BASE = "http://localhost:8787";
  const DEBOUNCE_MS = 550;

  let activeInput = null;
  let lastTextSent = "";
  let currentGhost = "";
  let debounceTimer = null;
  let observer = null;

  // --- UI overlay ---
  const ghostEl = document.createElement("div");
  ghostEl.id = "ph-ghost";
  ghostEl.innerHTML = `<div id="ph-ghost-text"></div><div class="ph-hint">Tab: accept • Esc: dismiss</div>`;
  document.documentElement.appendChild(ghostEl);

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

  function positionGhostNearInput() {
    if (!activeInput) return;

    const rect = activeInput.getBoundingClientRect();
    // Place ghost slightly above the input, aligned left
    const top = Math.max(10, rect.top - 56);
    const left = Math.max(10, rect.left);

    ghostEl.style.top = `${top}px`;
    ghostEl.style.left = `${left}px`;
  }

  window.addEventListener("resize", () => positionGhostNearInput(), { passive: true });
  window.addEventListener("scroll", () => positionGhostNearInput(), { passive: true });

  // --- Input detection (textarea or contenteditable) ---
  function isVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style && style.visibility !== "hidden" && style.display !== "none";
  }

  function findChatInput() {
    // Try common candidates
    const candidates = [];

    // 1) Textarea (often present)
    document.querySelectorAll("textarea").forEach(el => candidates.push(el));

    // 2) contenteditable divs
    document.querySelectorAll("[contenteditable='true']").forEach(el => candidates.push(el));

    // Score candidate: visible, near bottom, reasonably sized
    let best = null;
    let bestScore = -Infinity;

    for (const el of candidates) {
      if (!isVisible(el)) continue;

      const r = el.getBoundingClientRect();
      const area = r.width * r.height;

      // Ignore tiny editable elements
      if (area < 5000) continue;

      // Prefer elements near bottom of viewport (chat inputs usually are)
      const bottomBias = r.bottom;

      // Prefer elements the user can type into
      const editable = el.tagName === "TEXTAREA" || el.getAttribute("contenteditable") === "true";

      let score = 0;
      score += editable ? 50 : 0;
      score += Math.min(2000, area / 200); // size
      score += bottomBias / 10; // near bottom
      score -= (r.top < 0 ? 100 : 0);

      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    return best;
  }

  function getText(el) {
    if (!el) return "";
    if (el.tagName === "TEXTAREA") return el.value || "";
    if (el.getAttribute("contenteditable") === "true") return el.textContent || "";
    return "";
  }

  function setText(el, text) {
    if (!el) return;
    if (el.tagName === "TEXTAREA") {
      el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
    if (el.getAttribute("contenteditable") === "true") {
      el.textContent = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return;
    }
  }

  function attachToInput(el) {
    if (!el || el === activeInput) return;

    // Detach old
    if (activeInput) {
      activeInput.removeEventListener("input", onInput);
      activeInput.removeEventListener("focus", onFocus);
      activeInput.removeEventListener("blur", onBlur);
    }

    activeInput = el;
    lastTextSent = "";
    clearGhost();

    activeInput.addEventListener("input", onInput);
    activeInput.addEventListener("focus", onFocus);
    activeInput.addEventListener("blur", onBlur);

    // Position ghost if needed
    positionGhostNearInput();

    console.log("[PromptHelper] Attached to input:", activeInput);
  }

  function onFocus() {
    positionGhostNearInput();
  }

  function onBlur() {
    // Hide ghost when leaving input (MVP)
    ghostEl.style.display = "none";
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
      // If backend is down, just hide ghost
      console.warn("[PromptHelper] Suggest request failed:", e.message || e);
      return "";
    }
  }

  function onInput() {
    if (!activeInput) return;

    const text = getText(activeInput).trimEnd();

    // MVP: don't suggest on very short text
    if (text.trim().length < 8) {
      clearGhost();
      return;
    }

    // Debounce
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      // Avoid sending same text repeatedly
      if (text === lastTextSent) return;
      lastTextSent = text;

      const ghost = await requestSuggestion(text);

      // Only show if still same input and still focused
      const stillActive = document.activeElement === activeInput;
      if (!stillActive) return;

      // Don't show duplicates (if already contained)
      if (ghost && text.endsWith(ghost)) {
        clearGhost();
        return;
      }

      setGhost(ghost);
    }, DEBOUNCE_MS);
  }

  // Tab accept + Esc dismiss
  document.addEventListener("keydown", (e) => {
    if (!activeInput) return;
    const focused = document.activeElement === activeInput;
    if (!focused) return;

    if (e.key === "Escape") {
      clearGhost();
      return;
    }

    if (e.key === "Tab") {
      if (!currentGhost.trim()) return;
      e.preventDefault();

      const base = getText(activeInput).trimEnd();
      const next = base + currentGhost;

      setText(activeInput, next);
      clearGhost();

      // Keep focus
      activeInput.focus();
    }
  }, true);

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

  // Init
  function init() {
    const el = findChatInput();
    if (el) attachToInput(el);
    startObserver();

    // Also re-check periodically in case of heavy SPA transitions
    setInterval(() => {
      const el2 = findChatInput();
      if (el2) attachToInput(el2);
    }, 2000);

    console.log("[PromptHelper] Initialized.");
  }

  init();
})();