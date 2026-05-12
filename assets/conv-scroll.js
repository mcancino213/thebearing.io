// conv-scroll.js — shared scroll-to-bottom for conversation message panes
//
// The naïve `wrap.scrollTop = wrap.scrollHeight` inside a `setTimeout(..., 50)`
// is unreliable: when a conversation is opened, the messages-wrap initially
// reports the right scrollHeight, but moments later the layout shifts because:
//   • avatar images load and resize their rows
//   • emoji reactions render after the message DOM is built
//   • web fonts swap in and reflow text
//   • the composer below transitions/resizes
// Any of those push the last message out of view *after* we scrolled, and
// because scrollTop is now numerically still at "the old scrollHeight," the
// user sees the second-to-last message at the bottom of the pane while the
// real last message hides under the composer.
//
// This helper fixes that by:
//   1. Scrolling using `scrollIntoView({block:'end'})` on the last message
//      element — the browser handles padding/composer correctly.
//   2. Repeating across 3 animation frames so any post-mount reflows are
//      caught.
//   3. Watching the messages-wrap with a short-lived ResizeObserver — for
//      ~1s after open, any height change re-pins to bottom.
//
// Usage:
//   pinToBottom(messagesWrapElement);
// or for the refresh-after-new-message case (no ResizeObserver needed):
//   pinToBottom(messagesWrapElement, { observe: false });
(function() {
  function pinToBottomNow(wrap) {
    if (!wrap) return;
    var last = wrap.lastElementChild;
    if (last && typeof last.scrollIntoView === 'function') {
      // `block:'end'` aligns the bottom edge of the last child with the
      // bottom edge of the visible scroll area. `inline:'nearest'` avoids
      // horizontal jumps if the container is also scrollable horizontally.
      last.scrollIntoView({ block: 'end', inline: 'nearest' });
    } else {
      // Fallback: brute scrollTop. Rare path — only if no children rendered.
      wrap.scrollTop = wrap.scrollHeight;
    }
  }

  function pinToBottom(wrap, opts) {
    if (!wrap) return;
    opts = opts || {};
    var observe = opts.observe !== false; // default true

    // Pin across 3 animation frames so late layout shifts are caught.
    // 3 frames ≈ 50ms at 60fps — same budget as the old setTimeout but
    // synchronised to actual paints rather than a wall-clock guess.
    pinToBottomNow(wrap);
    requestAnimationFrame(function() {
      pinToBottomNow(wrap);
      requestAnimationFrame(function() {
        pinToBottomNow(wrap);
        requestAnimationFrame(function() { pinToBottomNow(wrap); });
      });
    });

    if (!observe || typeof ResizeObserver === 'undefined') return;

    // Watch the wrap and its content for size changes for ~1s after open.
    // Any reflow (image load, font swap, reaction render) re-pins. We tear
    // down after the window so subsequent user scrolling isn't hijacked.
    var ro = new ResizeObserver(function() { pinToBottomNow(wrap); });
    ro.observe(wrap);
    // Also observe the last child if it exists — catches the case where the
    // wrap height stays the same but a child grows (e.g. tall image loads).
    if (wrap.lastElementChild) ro.observe(wrap.lastElementChild);
    setTimeout(function() { ro.disconnect(); }, 1000);
  }

  // Expose globally — each conversation page just calls window.pinToBottom().
  window.pinToBottom = pinToBottom;
})();
