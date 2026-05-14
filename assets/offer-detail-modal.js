// TheBearing.io — Read-only offer detail modal for admin + partner (v73ad)
//
// Customer side has its own openOfferDetail() inline in conversations.html
// because that view has Accept/Decline/Request-changes actions that admin
// and partner don't need. This shared asset is the read-only twin: same
// look, no actions.
//
// Usage:
//   TBOfferDetail.open(offerId, { mode: 'admin' | 'partner' });
//
// Reads /api/offer?id=X. Renders all the same fields the customer sees:
// status badge, room/dates/guests, total + deposit, valid-until, balance
// due date, inclusions, exclusions, cancellation, partner notes.

(function() {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function fmtDate(iso) {
    if (!iso) return '';
    try {
      var d = new Date(iso.length === 10 ? (iso + 'T00:00') : iso);
      return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch (_) { return iso; }
  }
  function fmtMoney(amt) {
    if (typeof amt !== 'number' || isNaN(amt) || amt === 0) return '\u2014';
    return '$' + Number(amt).toLocaleString();
  }

  function open(offerId, opts) {
    if (!offerId) return;
    opts = opts || {};
    var mode = opts.mode === 'partner' ? 'partner' : 'admin';

    // Clear any existing modal
    var existing = document.getElementById('tb-od-modal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'tb-od-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9000;display:grid;place-items:start center;backdrop-filter:blur(6px);overflow-y:auto;padding:5vh 16px;font-family:Geist,system-ui,sans-serif;';
    // Same cream/light sheet for both portals \u2014 the offer document itself
    // looks the same regardless of who's reading. The portal CHROME differs
    // (admin is dark, partner is light), but a document overlay is universal.
    modal.innerHTML =
      '<div id="tb-od-sheet" style="background:#faf7f1;border-radius:20px;width:100%;max-width:620px;margin:0 auto;padding:0;box-shadow:0 20px 60px rgba(0,0,0,.25);overflow:hidden;color:#1e1810;">' +
      '  <div style="padding:18px 22px;border-bottom:1px solid rgba(80,60,30,.1);display:flex;align-items:center;justify-content:space-between;gap:12px;">' +
      '    <div>' +
      '      <div style="font-size:.58rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#b05830;">' + (mode === 'partner' ? 'Offer sent to guest' : 'Offer details') + '</div>' +
      '      <div id="tb-od-prop" style="font-family:\'Instrument Serif\',Georgia,serif;font-size:1.4rem;line-height:1.15;margin-top:2px;">Loading\u2026</div>' +
      '    </div>' +
      '    <button id="tb-od-close" aria-label="Close" style="width:32px;height:32px;border-radius:50%;border:1px solid #e5e0d8;background:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;">' +
      '      <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="#1e1810" stroke-width="2.5" stroke-linecap="round"><line x1="2" y1="2" x2="14" y2="14"/><line x1="14" y1="2" x2="2" y2="14"/></svg>' +
      '    </button>' +
      '  </div>' +
      '  <div id="tb-od-body" style="padding:22px;">' +
      '    <div style="color:#9a8e80;font-size:.85rem;text-align:center;padding:36px 0;">Loading offer\u2026</div>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(modal);
    document.body.style.overflow = 'hidden';

    function closeModal() {
      modal.remove();
      document.body.style.overflow = '';
    }
    document.getElementById('tb-od-close').addEventListener('click', closeModal);
    modal.addEventListener('click', function(e) { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', function escHandler(e) {
      if (e.key === 'Escape') {
        if (document.getElementById('tb-od-modal')) {
          closeModal();
          document.removeEventListener('keydown', escHandler);
        }
      }
    });

    // Fetch + render
    fetch('/api/offer?id=' + encodeURIComponent(offerId), { cache: 'no-store' })
      .then(function(r) { return r.json(); })
      .then(function(resp) {
        if (!resp || !resp.data) {
          document.getElementById('tb-od-body').innerHTML =
            '<div style="text-align:center;padding:30px 0;color:#9a8e80;font-size:.85rem;">Offer not found. It may have been withdrawn.</div>';
          return;
        }
        var o = resp.data;
        document.getElementById('tb-od-prop').textContent = o.propertyName || 'Property';

        var statusBadge = '';
        if (o.status === 'sent')        statusBadge = '<span style="background:rgba(58,112,85,.12);color:#3a7055;padding:3px 10px;border-radius:100px;font-size:.62rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;">Awaiting guest reply</span>';
        else if (o.status === 'accepted')   statusBadge = '<span style="background:rgba(45,138,78,.15);color:#1f6a3a;padding:3px 10px;border-radius:100px;font-size:.62rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;">Accepted</span>';
        else if (o.status === 'declined')   statusBadge = '<span style="background:rgba(160,30,30,.1);color:#a01e1e;padding:3px 10px;border-radius:100px;font-size:.62rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;">Declined</span>';
        else if (o.status === 'withdrawn')  statusBadge = '<span style="background:rgba(120,100,80,.12);color:#7a6a58;padding:3px 10px;border-radius:100px;font-size:.62rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;">Withdrawn</span>';
        else if (o.status === 'superseded') statusBadge = '<span style="background:rgba(120,100,80,.12);color:#7a6a58;padding:3px 10px;border-radius:100px;font-size:.62rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;">Replaced by newer offer</span>';
        else if (o.status === 'draft')      statusBadge = '<span style="background:rgba(120,100,80,.12);color:#7a6a58;padding:3px 10px;border-radius:100px;font-size:.62rem;font-weight:600;letter-spacing:.08em;text-transform:uppercase;">Draft</span>';

        var inclList = '';
        if (Array.isArray(o.inclusions) && o.inclusions.length) {
          inclList = '<ul style="list-style:none;padding:0;margin:8px 0 0;display:flex;flex-direction:column;gap:6px;">' +
            o.inclusions.map(function(i) {
              return '<li style="display:flex;align-items:flex-start;gap:8px;font-size:.85rem;color:#1e1810;line-height:1.5;">' +
                '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3a7055" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;margin-top:3px;"><polyline points="20 6 9 17 4 12"/></svg>' +
                '<span>' + esc(i) + '</span>' +
              '</li>';
            }).join('') +
            '</ul>';
        }

        var nightsStr = o.nights ? (o.nights + ' night' + (o.nights === 1 ? '' : 's')) : '';
        var datesLine = (o.arrival && o.departure) ? (fmtDate(o.arrival) + ' \u2192 ' + fmtDate(o.departure) + (nightsStr ? ' \u00b7 ' + nightsStr : '')) : '';
        var guestsLine = o.guests ? (o.guests + ' guest' + (o.guests === 1 ? '' : 's')) : '';

        var validLine = '';
        if (o.valid_until) {
          var days = Math.ceil((new Date(o.valid_until) - new Date()) / (24 * 60 * 60 * 1000));
          validLine = days > 0 ? ('Valid for ' + days + ' more day' + (days === 1 ? '' : 's')) : 'Expired';
        }

        var balanceDueLine = '';
        if (o.balance_due_date) {
          balanceDueLine = '<div style="margin-top:10px;font-size:.78rem;color:#5a4e40;"><strong>Balance due:</strong> ' + esc(fmtDate(o.balance_due_date)) + '</div>';
        }

        var html =
          (statusBadge ? '<div style="text-align:center;margin-bottom:14px;">' + statusBadge + '</div>' : '') +
          '<div style="text-align:center;padding:14px 0 16px;border-bottom:1px solid rgba(80,60,30,.1);">' +
            (o.room ? '<div style="font-size:.86rem;color:#5a4e40;margin-bottom:6px;">' + esc(o.room) + (guestsLine ? ' \u00b7 ' + esc(guestsLine) : '') + '</div>' : (guestsLine ? '<div style="font-size:.86rem;color:#5a4e40;margin-bottom:6px;">' + esc(guestsLine) + '</div>' : '')) +
            (datesLine ? '<div style="font-family:\'Instrument Serif\',Georgia,serif;font-size:1.05rem;color:#1e1810;">' + esc(datesLine) + '</div>' : '') +
          '</div>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin:18px 0;padding:18px;background:rgba(176,88,48,.06);border-radius:14px;">' +
            '<div>' +
              '<div style="font-size:.58rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#9a8e80;margin-bottom:4px;">Total stay</div>' +
              '<div style="font-family:\'Instrument Serif\',Georgia,serif;font-size:1.5rem;color:#1e1810;">' + fmtMoney(o.total_amount || 0) + '</div>' +
              (o.pricing_mode === 'per_night' && o.nightly_rate ? '<div style="font-size:.72rem;color:#9a8e80;margin-top:2px;">' + fmtMoney(o.nightly_rate) + ' avg nightly \u00d7 ' + (o.nights || '?') + '</div>' : '') +
            '</div>' +
            '<div>' +
              '<div style="font-size:.58rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#9a8e80;margin-bottom:4px;">Deposit to confirm</div>' +
              '<div style="font-family:\'Instrument Serif\',Georgia,serif;font-size:1.5rem;color:#b05830;">' + fmtMoney(o.deposit_amount || 0) + '</div>' +
              '<div style="font-size:.72rem;color:#9a8e80;margin-top:2px;">' + (o.balance_due_date ? 'Balance due ' + esc(fmtDate(o.balance_due_date)) : 'Balance settled with property') + '</div>' +
            '</div>' +
          '</div>' +
          (validLine ? '<div style="text-align:center;font-size:.74rem;color:#9a8e80;font-style:italic;margin-bottom:14px;">' + esc(validLine) + '</div>' : '') +
          (inclList ? '<div style="margin:18px 0;"><div style="font-size:.58rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#9a8e80;margin-bottom:8px;">Included</div>' + inclList + '</div>' : '') +
          (o.exclusions ? '<div style="margin:18px 0;"><div style="font-size:.58rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#9a8e80;margin-bottom:6px;">Not included</div><div style="font-size:.85rem;color:#1e1810;line-height:1.55;white-space:pre-line;">' + esc(o.exclusions) + '</div></div>' : '') +
          (o.cancellation_terms ? '<div style="margin:18px 0;"><div style="font-size:.58rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#9a8e80;margin-bottom:6px;">Cancellation</div><div style="font-size:.85rem;color:#1e1810;line-height:1.55;white-space:pre-line;">' + esc(o.cancellation_terms) + '</div></div>' : '') +
          (o.partner_notes ? '<div style="margin:18px 0;padding:14px 16px;background:rgba(176,88,48,.06);border-radius:10px;border-left:3px solid #b05830;"><div style="font-size:.58rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#9a8e80;margin-bottom:6px;">A note from the property</div><div style="font-size:.85rem;color:#1e1810;line-height:1.55;white-space:pre-line;font-style:italic;">' + esc(o.partner_notes) + '</div></div>' : '');

        document.getElementById('tb-od-body').innerHTML = html;
      })
      .catch(function(err) {
        console.error('[Offer detail] fetch error:', err);
        document.getElementById('tb-od-body').innerHTML =
          '<div style="text-align:center;padding:30px 0;color:#a01e1e;font-size:.85rem;">Could not load offer: ' + esc(err && err.message ? err.message : 'unknown error') + '</div>';
      });
  }

  window.TBOfferDetail = { open: open };
})();
