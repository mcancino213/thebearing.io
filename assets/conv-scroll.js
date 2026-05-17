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
// v74l: NEW `wasAtBottom(wrap)` helper. Callers should sample this BEFORE
// they re-render messages (which would wipe innerHTML and reset scrollTop),
// then pass the result as `pinToBottom(wrap, { observe: false, force: bool })`.
// When `force` is false (the default for observe:false), the pin is skipped
// — leaving a user who's scrolled up to read history exactly where they are.
// This fixes the "scroll up to read older messages, get yanked back down
// 5 seconds later by the poll" bug across all three chat surfaces.
//
// Usage (initial open):
//   pinToBottom(messagesWrapElement);
// Usage (refresh-poll):
//   var wasAtBottom = window.wasAtBottom(wrap);
//   // ... rerender messages ...
//   pinToBottom(wrap, { observe: false, force: wasAtBottom });
(function() {
  // v74l: "at bottom" means within this many pixels of the bottom edge.
  // 80px gives a comfortable buffer (a single message bubble is ~40-60px)
  // without being so wide that a deliberately-scrolled user gets snapped
  // back. Live-typing / just-sent-a-message UX still pins (they're at the
  // bottom anyway when sending).
  var BOTTOM_THRESHOLD_PX = 80;

  function wasAtBottom(wrap) {
    if (!wrap) return true;
    var distanceFromBottom = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight;
    return distanceFromBottom <= BOTTOM_THRESHOLD_PX;
  }

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

    // v74l: when this is a refresh-poll call (observe: false), only pin
    // if the caller has explicitly said "the user was at the bottom
    // before I re-rendered" via opts.force = true. Initial-open calls
    // (observe: true) always pin — that's the expected behavior when
    // first viewing a conversation.
    //
    // We can't read scrollTop here ourselves because the renderer has
    // already done wrap.innerHTML = '' before reaching this point, which
    // resets scrollTop to 0. So callers MUST capture wasAtBottom(wrap)
    // BEFORE re-rendering, then pass it as force.
    if (!observe && opts.force !== true) return;

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

  // Expose globally — each conversation page calls window.pinToBottom().
  window.pinToBottom = pinToBottom;
  window.wasAtBottom = wasAtBottom;
})();
