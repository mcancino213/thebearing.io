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

  // ════════════════════════════════════════════════════════════════════
  // v74m: ConvScroll.install — pill + jump-to-bottom button for any chat
  // ════════════════════════════════════════════════════════════════════
  // Modern chat UX expectation: when the user scrolls up to read history,
  // (a) auto-scroll-on-poll should NOT yank them back (handled in v74l via
  // `wasAtBottom` + `force`), and (b) there should be visual affordances
  // to get them back to live — a jump-to-bottom button, and a "↓ N new
  // messages" pill if new messages arrive while they're scrolled away.
  //
  // ConvScroll.install(wrap, opts) attaches both:
  //   - A jump-to-bottom button (subtle, terracotta) shown when scrolled
  //     up beyond `threshold` px (default 200). Click → smooth-scroll to
  //     bottom.
  //   - A new-messages pill ("↓ N new messages") that appears when the
  //     caller calls api.showNewMessagesPill(count) AND the user is
  //     scrolled up. Auto-clears once user reaches bottom or clicks pill.
  //     Stacks: pill replaces button when both would be visible.
  //
  // Returns an api object: { showNewMessagesPill, hideNewMessagesPill,
  //   destroy }. showNewMessagesPill(n) sets the count; if user is
  //   already at-bottom it does nothing (no notification needed because
  //   they'll see the message land).
  //
  // The controls position relative to the FIRST positioned ancestor of
  // `wrap`. The chat columns are already position:relative, so this
  // works out of the box.
  function installScrollControls(wrap, opts) {
    if (!wrap) return null;
    opts = opts || {};
    var threshold = typeof opts.threshold === 'number' ? opts.threshold : 200;
    var pillUnreadCount = 0;

    // v74p: The previous strategy (walk up to find a positioned ancestor +
    // position the controls at `bottom:96px` inside it) was unreliable —
    // the "positioned ancestor" was usually the whole chat column, so
    // `bottom:96px` put the controls ABOVE the column bottom (which is
    // below the composer), causing the controls to float over the
    // composer/reply box at certain composer heights.
    //
    // New approach: wrap the messages-wrap in a position:relative "stage"
    // that shares the same flex behaviour. The messages-wrap (which has
    // overflow-y:auto) goes inside the stage; the pill + jump button get
    // absolutely positioned at `bottom:16px right:18px` of the stage. The
    // composer is a SIBLING of the stage, never overlapped.
    //
    // This is idempotent — if a stage is already in place from a previous
    // install on the same wrap, we reuse it (callers call destroy() then
    // re-install on the same DOM, so this can happen).
    var stage;
    if (wrap.parentElement && wrap.parentElement.classList.contains('conv-scroll-stage')) {
      stage = wrap.parentElement;
      // Clear any previous controls
      var oldBtn = stage.querySelector('.conv-scroll-jump-btn');
      var oldPill = stage.querySelector('.conv-scroll-new-pill');
      if (oldBtn) oldBtn.remove();
      if (oldPill) oldPill.remove();
    } else {
      stage = document.createElement('div');
      stage.className = 'conv-scroll-stage';
      // Match the messages-wrap's flex behaviour so layout doesn't shift.
      // The wrap typically has `flex:1` inside a flex column; the stage
      // inherits that role and the wrap inside it gets `flex:1 1 0; min-height:0`
      // so it fills the stage and scrolls.
      stage.style.cssText = 'position:relative;display:flex;flex-direction:column;flex:1 1 auto;min-height:0;';
      // Insert stage in the same position as the wrap, then move wrap inside
      var parent = wrap.parentElement;
      if (parent) {
        parent.insertBefore(stage, wrap);
        stage.appendChild(wrap);
        // Ensure the inner wrap can fill the stage and scroll
        wrap.style.flex = '1 1 0';
        wrap.style.minHeight = '0';
      }
    }
    var anchor = stage;

    // ─ Button ──
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'conv-scroll-jump-btn';
    btn.setAttribute('aria-label', 'Scroll to latest messages');
    btn.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="12" y1="5" x2="12" y2="19"/>' +
      '<polyline points="19 12 12 19 5 12"/>' +
      '</svg>';
    btn.style.cssText =
      'position:absolute;right:18px;bottom:16px;' +
      'width:38px;height:38px;border-radius:50%;' +
      'background:#fff;color:#1e1810;border:1px solid rgba(80,60,30,.18);' +
      'box-shadow:0 4px 14px rgba(0,0,0,.10),0 2px 4px rgba(0,0,0,.05);' +
      'display:none;align-items:center;justify-content:center;cursor:pointer;' +
      'opacity:0;transform:translateY(8px);' +
      'transition:opacity .2s ease, transform .2s ease, background .15s ease;' +
      'z-index:50;font-family:Geist,system-ui,sans-serif;';
    btn.addEventListener('mouseenter', function() { btn.style.background = '#faf7f1'; });
    btn.addEventListener('mouseleave', function() { btn.style.background = '#fff'; });
    btn.addEventListener('click', function() { scrollToBottomSmooth(); });
    anchor.appendChild(btn);

    // ─ Pill ──
    var pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'conv-scroll-new-pill';
    pill.style.cssText =
      'position:absolute;right:18px;bottom:16px;' +
      'padding:9px 16px 9px 14px;border-radius:100px;' +
      'background:linear-gradient(135deg,#b05830,#8c4422);color:#fff;' +
      'border:none;box-shadow:0 4px 18px rgba(176,88,48,.30);' +
      'display:none;align-items:center;gap:8px;cursor:pointer;' +
      'opacity:0;transform:translateY(8px);' +
      'transition:opacity .2s ease, transform .2s ease, box-shadow .15s ease;' +
      'z-index:51;' +
      'font-family:Geist,system-ui,sans-serif;font-size:.78rem;font-weight:600;' +
      'white-space:nowrap;';
    pill.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">' +
      '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>' +
      '</svg>' +
      '<span class="conv-scroll-pill-text">1 new message</span>';
    pill.addEventListener('mouseenter', function() { pill.style.boxShadow = '0 6px 22px rgba(176,88,48,.40)'; });
    pill.addEventListener('mouseleave', function() { pill.style.boxShadow = '0 4px 18px rgba(176,88,48,.30)'; });
    pill.addEventListener('click', function() {
      pillUnreadCount = 0;
      hidePill();
      scrollToBottomSmooth();
    });
    anchor.appendChild(pill);

    function scrollToBottomSmooth() {
      var last = wrap.lastElementChild;
      if (last && typeof last.scrollIntoView === 'function') {
        last.scrollIntoView({ block: 'end', behavior: 'smooth' });
      } else {
        wrap.scrollTo({ top: wrap.scrollHeight, behavior: 'smooth' });
      }
    }

    function showBtn() {
      btn.style.display = 'flex';
      // Use rAF so display:flex paints before we animate
      requestAnimationFrame(function() {
        btn.style.opacity = '1';
        btn.style.transform = 'translateY(0)';
      });
    }
    function hideBtn() {
      btn.style.opacity = '0';
      btn.style.transform = 'translateY(8px)';
      setTimeout(function() {
        if (btn.style.opacity === '0') btn.style.display = 'none';
      }, 220);
    }
    function showPill(count) {
      pill.querySelector('.conv-scroll-pill-text').textContent =
        count + ' new message' + (count === 1 ? '' : 's');
      pill.style.display = 'flex';
      requestAnimationFrame(function() {
        pill.style.opacity = '1';
        pill.style.transform = 'translateY(0)';
      });
    }
    function hidePill() {
      pill.style.opacity = '0';
      pill.style.transform = 'translateY(8px)';
      setTimeout(function() {
        if (pill.style.opacity === '0') pill.style.display = 'none';
      }, 220);
    }

    function distanceFromBottom() {
      return wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight;
    }

    // Decide what to show based on scroll position + pending pill count.
    // Pill takes priority over plain jump button.
    function syncControls() {
      var dist = distanceFromBottom();
      var scrolledUp = dist > threshold;
      // Auto-dismiss pill once user gets close to bottom (within 80px,
      // matching the BOTTOM_THRESHOLD_PX used by wasAtBottom).
      if (pillUnreadCount > 0 && dist <= BOTTOM_THRESHOLD_PX) {
        pillUnreadCount = 0;
      }
      if (pillUnreadCount > 0 && scrolledUp) {
        // Show pill, hide button
        hideBtn();
        showPill(pillUnreadCount);
      } else if (scrolledUp) {
        // Show plain jump button, hide pill
        hidePill();
        showBtn();
      } else {
        // Hide both
        hidePill();
        hideBtn();
      }
    }

    // Throttle scroll handler to one rAF
    var scrollScheduled = false;
    function onScroll() {
      if (scrollScheduled) return;
      scrollScheduled = true;
      requestAnimationFrame(function() {
        scrollScheduled = false;
        syncControls();
      });
    }
    wrap.addEventListener('scroll', onScroll, { passive: true });
    // Initial check
    syncControls();

    return {
      // Caller signals "new messages just arrived from others". If user is
      // scrolled away, this updates the pill count. If they're at bottom,
      // does nothing (no notification needed — they'll see it).
      showNewMessagesPill: function(count) {
        var dist = distanceFromBottom();
        if (dist <= BOTTOM_THRESHOLD_PX) return; // at-bottom, no pill needed
        pillUnreadCount = (pillUnreadCount || 0) + (count || 1);
        syncControls();
      },
      hideNewMessagesPill: function() {
        pillUnreadCount = 0;
        hidePill();
        syncControls();
      },
      destroy: function() {
        wrap.removeEventListener('scroll', onScroll);
        if (btn.parentNode) btn.parentNode.removeChild(btn);
        if (pill.parentNode) pill.parentNode.removeChild(pill);
      },
    };
  }
  window.ConvScroll = { install: installScrollControls, wasAtBottom: wasAtBottom };
})();
