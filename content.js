// Makes the debug widgets that sit in the page corner draggable:
//
// - The Elm debugger "mini controls" (elm/browser, Debugger/Overlay.elm,
//   viewMiniControls): a div with inline styles `position: fixed;
//   bottom: 2em; right: 2em; z-index: 2147483647` and no id or class.
// - The json-render devtools toggle (@json-render/devtools): a
//   `button.jr-toggle` (`position: fixed; bottom: 20px; right: 20px`) inside
//   the open shadow root of a `div[data-jr-devtools-host]`.
//
// We move each widget with a CSS transform, which neither library sets, so
// their re-renders leave our offset alone. Each widget gets a "slot" that
// keeps its offset while the library swaps DOM around underneath it.
(() => {
  const DRAG_THRESHOLD = 4;
  // Widgets start stacked on top of each other, so spread them out vertically.
  const STACK_SPACING = 44;
  const STORAGE_KEY = `draggableDevWidgets:${location.origin}`;

  // slot: { kind, id, widget, offset: { dx, dy }, ...kind-specific fields }
  // `kind` is "elm" or "jr"; `id` counts slots of that kind in page order.
  const slots = [];
  // Offsets by slot key, as loaded from and written to storage.
  let saved = {};
  let suppressClickFor = null;

  const keyOf = (slot) => `${slot.kind}:${slot.id}`;
  const defaultOffset = (slot) => ({ dx: 0, dy: -slot.id * STACK_SPACING });

  const newSlot = (kind, fields = {}) => {
    const id = slots.filter((slot) => slot.kind === kind).length;
    const slot = { kind, id, widget: null, ...fields };
    slot.offset = saved[keyOf(slot)] || defaultOffset(slot);
    slots.push(slot);
    return slot;
  };

  const slotForWidget = (el) => slots.find((slot) => slot.widget === el);

  // The innermost tracked widget under the event. `composedPath` also sees
  // into open shadow roots, where `event.target` would only be the host.
  const slotAt = (event) => {
    for (const node of event.composedPath()) {
      const slot = slotForWidget(node);
      if (slot) return slot;
    }
    return null;
  };

  // Keep the widget fully inside the viewport. The rect includes the current
  // transform, so subtract it to get the widget's native position.
  const clamp = (slot, dx, dy) => {
    const rect = slot.widget.getBoundingClientRect();
    const left = rect.left - slot.offset.dx;
    const top = rect.top - slot.offset.dy;
    const minDx = -left;
    const maxDx = window.innerWidth - rect.width - left;
    const minDy = -top;
    const maxDy = window.innerHeight - rect.height - top;
    return {
      dx: Math.round(Math.min(Math.max(dx, minDx), Math.max(minDx, maxDx))),
      dy: Math.round(Math.min(Math.max(dy, minDy), Math.max(minDy, maxDy))),
    };
  };

  const apply = (slot) => {
    const { widget, offset } = slot;
    widget.style.transform = `translate(${offset.dx}px, ${offset.dy}px)`;
    widget.style.touchAction = "none";
    widget.style.userSelect = "none";
  };

  const unapply = (el) => {
    el.style.transform = "";
    el.style.touchAction = "";
    el.style.userSelect = "";
  };

  const save = () => {
    for (const slot of slots) saved[keyOf(slot)] = slot.offset;
    try {
      chrome.storage.local.set({ [STORAGE_KEY]: saved });
    } catch (_) {
      // Extension context invalidated (e.g. extension reloaded); ignore.
    }
  };

  // Drop a slot's widget once the library removed it or reused it for
  // something else.
  const dropWidgets = (kind, stillWidget) => {
    for (const slot of slots) {
      if (slot.kind !== kind || !slot.widget || stillWidget(slot.widget)) continue;
      if (slot.widget.isConnected) unapply(slot.widget);
      slot.widget = null;
    }
  };

  // ---- Elm debugger ------------------------------------------------------
  //
  // A page can contain several Elm apps, each with its own widget. A slot's
  // root is the node Elm renders the debugger corner into. Elm swaps that
  // node around: it becomes a text node while the popout is open, and the
  // same div is reused as the full-screen "Click to Resume" overlay (with a
  // fresh widget inside) while paused. We follow those swaps so each debugger
  // keeps its own position.

  const ELM_SELECTOR =
    'div[style*="2147483647"][style*="bottom: 2em"][style*="right: 2em"]';
  const rootToSlot = new WeakMap();

  // The node Elm renders the debugger corner into: the paused overlay if the
  // widget is inside one, otherwise the widget itself.
  const elmRootOf = (el) =>
    el.parentElement && el.parentElement.id === "elm-debugger-overlay"
      ? el.parentElement
      : el;

  const findElmSlot = (el) => {
    for (let node = el; node && node !== document.body; node = node.parentNode) {
      const slot = rootToSlot.get(node);
      if (slot) return slot;
    }
    // Elm sometimes appends a fresh corner node instead of patching the old
    // one (e.g. when a Browser.document view gains children). Reuse a slot
    // that lost its widget, unless it's just waiting on an open popout.
    return slots.find(
      (slot) =>
        slot.kind === "elm" && !slot.widget && slot.root.nodeType !== Node.TEXT_NODE
    );
  };

  const checkElm = (records) => {
    // Follow Elm replacing a slot's root node (e.g. with a text node while the
    // popout is open, and back again when it closes).
    for (const record of records) {
      if (record.addedNodes.length !== 1) continue;
      for (const removed of record.removedNodes) {
        const slot = rootToSlot.get(removed);
        if (!slot) continue;
        slot.root = record.addedNodes[0];
        rootToSlot.set(slot.root, slot);
      }
    }

    dropWidgets("elm", (el) => el.isConnected && el.matches(ELM_SELECTOR));

    for (const el of document.querySelectorAll(ELM_SELECTOR)) {
      if (slotForWidget(el)) continue;
      const slot = findElmSlot(el) || newSlot("elm", { root: el });
      slot.root = elmRootOf(el);
      rootToSlot.set(slot.root, slot);
      slot.widget = el;
      apply(slot);
    }
  };

  // ---- json-render devtools ----------------------------------------------
  //
  // The devtools mounts one host div per instance and builds the toggle
  // button inside its shadow root in the same tick, so by the time we see the
  // host the button is there. The host is never swapped, so one slot per host
  // is enough; a slot is reused if the devtools is unmounted and remounted.

  const JR_HOST_SELECTOR = "[data-jr-devtools-host]";
  const hostToSlot = new WeakMap();

  const checkJr = () => {
    dropWidgets("jr", (el) => el.isConnected);

    for (const host of document.querySelectorAll(JR_HOST_SELECTOR)) {
      const el = host.shadowRoot && host.shadowRoot.querySelector(".jr-toggle");
      if (!el || slotForWidget(el)) continue;
      const slot =
        hostToSlot.get(host) ||
        slots.find((slot) => slot.kind === "jr" && !slot.widget) ||
        newSlot("jr");
      hostToSlot.set(host, slot);
      slot.widget = el;
      apply(slot);
    }
  };

  // ---- Shared behaviour --------------------------------------------------

  const check = (records = []) => {
    checkElm(records);
    checkJr();
  };

  window.addEventListener(
    "pointerdown",
    (event) => {
      if (event.button !== 0) return;
      const slot = slotAt(event);
      if (!slot) return;
      const el = slot.widget;

      const startX = event.clientX;
      const startY = event.clientY;
      const start = { ...slot.offset };
      let dragging = false;
      el.setPointerCapture(event.pointerId);

      const onMove = (e) => {
        const moveX = e.clientX - startX;
        const moveY = e.clientY - startY;
        if (!dragging && Math.hypot(moveX, moveY) < DRAG_THRESHOLD) return;
        if (!dragging) {
          dragging = true;
          el.style.cursor = "grabbing";
          // The json-render toggle shrinks with `scale: 0.95` (transitioned)
          // while :active. That scale is applied around the untransformed
          // box, on top of our translate, which skews the rects `clamp`
          // measures, so switch it off for the duration of the drag.
          el.style.scale = "none";
          el.style.transition = "none";
        }
        slot.offset = clamp(slot, start.dx + moveX, start.dy + moveY);
        apply(slot);
      };

      const onUp = (e) => {
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", onUp);
        el.removeEventListener("pointercancel", onUp);
        if (el.hasPointerCapture(e.pointerId)) {
          el.releasePointerCapture(e.pointerId);
        }
        if (dragging) {
          el.style.cursor = "pointer";
          el.style.scale = "";
          el.style.transition = "";
          suppressClickFor = el;
          save();
        }
      };

      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", onUp);
      el.addEventListener("pointercancel", onUp);
    },
    true
  );

  // Both widgets open their panel from a click listener on the widget itself,
  // so a capture listener on window runs first and can swallow the click that
  // ends a drag. Alt+clicks are swallowed too, since Alt+double-click resets.
  window.addEventListener(
    "click",
    (event) => {
      const slot = slotAt(event);
      const el = slot && slot.widget;
      const suppress = el && (el === suppressClickFor || event.altKey);
      suppressClickFor = null;
      if (suppress) {
        event.stopImmediatePropagation();
        event.preventDefault();
      }
    },
    true
  );

  window.addEventListener(
    "dblclick",
    (event) => {
      if (!event.altKey) return;
      const slot = slotAt(event);
      if (!slot) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      slot.offset = defaultOffset(slot);
      apply(slot);
      save();
    },
    true
  );

  window.addEventListener("resize", () => {
    for (const slot of slots) {
      if (!slot.widget) continue;
      slot.offset = clamp(slot, slot.offset.dx, slot.offset.dy);
      apply(slot);
    }
  });

  new MutationObserver(check).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  check();

  chrome.storage.local.get(STORAGE_KEY, (result) => {
    saved = (result && result[STORAGE_KEY]) || {};
    for (const slot of slots) {
      const offset = saved[keyOf(slot)];
      if (!offset) continue;
      slot.offset = offset;
      if (slot.widget) {
        slot.offset = clamp(slot, slot.offset.dx, slot.offset.dy);
        apply(slot);
      }
    }
  });
})();
