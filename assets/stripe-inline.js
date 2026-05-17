// TheBearing.io — Stripe inline payment widget (v73ab)
//
// Replaces the redirect-to-Stripe-Checkout flow with an embedded
// Payment Element. Customer stays on thebearing.io throughout.
//
// Usage:
//   TBStripeInline.payDeposit({
//     offerId: 'OFR-2026-12345',
//     offerLabel: 'Nour El Nil X · Panoramic Suite · 1 Sep \u2192 8 Sep',
//     onSuccess: function() { window.location = '/bookings?checkout=success'; },
//     onCancel:  function() { /* close modal / restore previous view */ },
//     onError:   function(message) { /* show inline error */ },
//   });
//
// Behavior:
//   1. Calls /api/checkout/create-intent with offerId + Clerk email
//   2. Mounts Stripe Payment Element into a fullscreen modal
//   3. On submit \u2192 stripe.confirmPayment() \u2192 success or 3DS challenge
//   4. On success: webhook fires async, we redirect to /bookings?checkout=success
//      which already has the persistent confirmed-hero card (v73x).
//
// 3DS: Stripe handles 3D Secure challenges in an iframe overlay it manages.
// Customer technically stays on our domain throughout, except for the iframe
// which loads issuer-bank content during the challenge.
//
// The webhook is the source of truth \u2014 we don't update the UI based on
// client-side confirmation alone. After stripe.confirmPayment returns
// success, we wait briefly and redirect; the webhook will have updated
// the booking record by then, and the /bookings page reads from KV.

(function() {
  'use strict';

  // Cache the Stripe.js script load so multiple invocations don't re-fetch
  var stripeJsPromise = null;
  function loadStripeJs() {
    if (stripeJsPromise) return stripeJsPromise;
    if (window.Stripe) return Promise.resolve(window.Stripe);
    stripeJsPromise = new Promise(function(resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://js.stripe.com/v3/';
      s.async = true;
      s.onload = function() { resolve(window.Stripe); };
      s.onerror = function() { reject(new Error('Failed to load Stripe.js')); };
      document.head.appendChild(s);
    });
    return stripeJsPromise;
  }

  function payDeposit(config) {
    config = config || {};
    var offerId = config.offerId;
    var offerLabel = config.offerLabel || 'Your booking';
    var onSuccess = config.onSuccess || function() {};
    var onCancel  = config.onCancel  || function() {};
    var onError   = config.onError   || function(){};
    // v74v: Reserve Credits redemption flag — caller (conversation offer
    // accept handler) sets this when the guest ticks the "Apply $4,000"
    // checkbox. Forwarded to /api/checkout/create-intent which reduces
    // the deposit proportionally and stamps PI metadata. Redemption is
    // only marked in the ledger on payment success, not at intent create.
    var applyCredits = config.applyCredits === true;
    var applyCreditsMemberId = config.applyCreditsMemberId || '';

    if (!offerId) {
      onError('Missing offer reference. Please refresh and try again.');
      return;
    }

    var user = window.Clerk && window.Clerk.user;
    var email = user && user.primaryEmailAddress ? user.primaryEmailAddress.emailAddress : '';
    if (!email) {
      onError('Sign-in expired. Please refresh and sign in again.');
      return;
    }

    // Build the modal shell immediately so the user sees feedback even while
    // Stripe.js is loading. The Payment Element mounts into #tb-pe-mount once
    // ready.
    var modal = createModal(offerLabel);
    modal.setStatus('loading', 'Preparing secure payment\u2026');

    // Parallel: create the PaymentIntent server-side AND load Stripe.js
    var intentPromise = fetch('/api/checkout/create-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offerId: offerId,
        requesterEmail: email,
        applyCredits: applyCredits,
        applyCreditsMemberId: applyCreditsMemberId,
      }),
    }).then(function(r) {
      return r.json().then(function(j){ return { ok: r.ok, body: j }; });
    });

    Promise.all([intentPromise, loadStripeJs()])
      .then(function(results) {
        var intentRes = results[0];
        var Stripe = results[1];
        if (!intentRes.ok) {
          var msg = (intentRes.body && intentRes.body.error) || 'Could not start payment';
          modal.setStatus('error', msg);
          return;
        }
        // v74v: $0-deposit bypass. When credits cover the full booking, the
        // worker confirms the booking server-side and returns skipStripe:true.
        // No Payment Element needed — just show success and trigger onSuccess.
        if (intentRes.body && intentRes.body.skipStripe === true) {
          modal.setStatus('success', intentRes.body.message || 'Booking confirmed with credits applied.');
          setTimeout(function() {
            try { modal.close(); } catch(_) {}
            onSuccess();
          }, 1500);
          return;
        }
        var clientSecret = intentRes.body.client_secret;
        var publishableKey = intentRes.body.publishable_key;
        var amountCents = intentRes.body.amount;
        var currency = (intentRes.body.currency || 'usd').toUpperCase();

        if (!clientSecret || !publishableKey) {
          modal.setStatus('error', 'Stripe response missing required keys');
          return;
        }

        var stripe = Stripe(publishableKey);
        var elements = stripe.elements({
          clientSecret: clientSecret,
          appearance: {
            theme: 'stripe',
            variables: {
              colorPrimary: '#b05830',
              colorBackground: '#ffffff',
              colorText: '#1e1810',
              colorDanger: '#b91c1c',
              fontFamily: 'Geist, system-ui, sans-serif',
              borderRadius: '10px',
            }
          }
        });
        var paymentElement = elements.create('payment', {
          layout: { type: 'tabs', defaultCollapsed: false }
        });
        paymentElement.mount('#tb-pe-mount');

        modal.setStatus('ready', '', { amount: amountCents, currency: currency });

        // Wire submit
        modal.onSubmit(function() {
          modal.setStatus('processing', 'Processing your payment\u2026');
          stripe.confirmPayment({
            elements: elements,
            confirmParams: {
              // After 3DS or async confirmation, Stripe redirects here.
              // For non-3DS cards (most test cards), the promise resolves
              // synchronously and no redirect happens \u2014 we manually
              // redirect in the .then() handler below.
              return_url: window.location.origin + '/bookings?checkout=success',
              receipt_email: email,
            },
            redirect: 'if_required',
          }).then(function(result) {
            if (result.error) {
              modal.setStatus('error', result.error.message || 'Payment failed');
            } else if (result.paymentIntent && result.paymentIntent.status === 'succeeded') {
              // v73af: Stripe accepted the payment client-side. The webhook
              // will eventually fire and update the booking record, but we
              // can't trust the webhook always being subscribed to
              // payment_intent.succeeded (operator could have it set to only
              // checkout.session.completed). So we proactively call
              // /api/checkout/sync-payment which verifies with Stripe and
              // runs the booking-confirmation flow directly. Idempotent
              // with the webhook \u2014 whichever lands first wins, the other
              // no-ops.
              modal.setStatus('processing', 'Confirming your booking\u2026');
              fetch('/api/checkout/sync-payment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  paymentIntentId: result.paymentIntent.id,
                  requesterEmail: email,
                }),
              })
                .then(function(r) { return r.json().then(function(j){ return { ok: r.ok, body: j }; }); })
                .then(function(syncRes) {
                  if (syncRes.ok && syncRes.body.status) {
                    modal.setStatus('success', 'Payment confirmed. Redirecting\u2026');
                    setTimeout(function() { onSuccess(result.paymentIntent); }, 900);
                  } else {
                    // Payment succeeded at Stripe but our sync failed \u2014 surface
                    // this to the user honestly. Their card WAS charged.
                    console.error('[Stripe inline] sync-payment failed:', syncRes);
                    modal.setStatus('error',
                      'Payment received but we could not finalise your booking on our side. ' +
                      'Please contact us at admin@thebearing.io with reference ' +
                      result.paymentIntent.id + ' \u2014 your payment is safe.');
                  }
                })
                .catch(function(err) {
                  console.error('[Stripe inline] sync-payment error:', err);
                  modal.setStatus('error',
                    'Payment received but we could not finalise your booking on our side. ' +
                    'Please contact us at admin@thebearing.io with reference ' +
                    result.paymentIntent.id + ' \u2014 your payment is safe.');
                });
            } else if (result.paymentIntent && result.paymentIntent.status === 'requires_action') {
              // 3DS challenge in progress (shouldn't reach here with redirect:'if_required'
              // but defensive)
              modal.setStatus('processing', 'Completing authentication\u2026');
            } else {
              modal.setStatus('error', 'Payment did not complete. Please try again.');
            }
          }).catch(function(err) {
            console.error('[Stripe inline] confirmPayment error:', err);
            modal.setStatus('error', 'Payment error: ' + (err.message || 'unknown'));
          });
        });

        modal.onCancel(function() { onCancel(); });
      })
      .catch(function(err) {
        console.error('[Stripe inline] setup error:', err);
        modal.setStatus('error', 'Could not load payment form: ' + (err.message || 'unknown'));
      });
  }

  // ── Modal builder ────────────────────────────────────────────────
  // Builds a centered modal with header, Payment Element mount point,
  // status area, and Pay/Cancel buttons. Returns control API.
  function createModal(offerLabel) {
    // Clean up any prior
    var existing = document.getElementById('tb-pe-modal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'tb-pe-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:flex-start;justify-content:center;backdrop-filter:blur(6px);overflow-y:auto;padding:5vh 16px;font-family:Geist,system-ui,sans-serif;';

    var sheet = document.createElement('div');
    sheet.style.cssText = 'background:#faf7f1;border-radius:20px;width:100%;max-width:560px;margin:0 auto;padding:0;box-shadow:0 20px 60px rgba(0,0,0,.25);overflow:hidden;';

    sheet.innerHTML =
      '<div style="padding:20px 24px;border-bottom:1px solid rgba(80,60,30,.1);display:flex;align-items:center;justify-content:space-between;gap:12px;">' +
      '  <div>' +
      '    <div style="font-size:.58rem;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#b05830;">Secure payment</div>' +
      '    <div id="tb-pe-label" style="font-family:\'Instrument Serif\',Georgia,serif;font-size:1.25rem;line-height:1.2;margin-top:2px;color:#1e1810;"></div>' +
      '  </div>' +
      '  <button id="tb-pe-close" aria-label="Close" style="width:32px;height:32px;border-radius:50%;border:1px solid #e5e0d8;background:#fff;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;">' +
      '    <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="#1e1810" stroke-width="2.5" stroke-linecap="round"><line x1="2" y1="2" x2="14" y2="14"/><line x1="14" y1="2" x2="2" y2="14"/></svg>' +
      '  </button>' +
      '</div>' +
      '<div id="tb-pe-amount" style="padding:14px 24px;background:rgba(176,88,48,.06);display:none;">' +
      '  <div style="font-size:.62rem;font-weight:600;letter-spacing:.1em;text-transform:uppercase;color:#9a8e80;margin-bottom:2px;">Deposit</div>' +
      '  <div id="tb-pe-amount-num" style="font-family:\'Instrument Serif\',Georgia,serif;font-size:1.6rem;color:#1e1810;"></div>' +
      '</div>' +
      '<div style="padding:20px 24px;">' +
      '  <div id="tb-pe-mount" style="min-height:140px;"></div>' +
      '  <div id="tb-pe-status" style="margin-top:14px;padding:10px 12px;border-radius:8px;font-size:.82rem;line-height:1.5;display:none;"></div>' +
      '</div>' +
      '<div style="padding:14px 24px 20px;display:flex;gap:10px;align-items:center;border-top:1px solid rgba(80,60,30,.08);">' +
      '  <button id="tb-pe-cancel" style="padding:11px 18px;background:transparent;border:1px solid rgba(80,60,30,.2);border-radius:10px;font-family:Geist,sans-serif;font-size:.85rem;color:#5a4e40;cursor:pointer;">Cancel</button>' +
      '  <div style="flex:1;"></div>' +
      '  <button id="tb-pe-submit" style="padding:11px 22px;background:linear-gradient(135deg,#b05830,#8c4422);color:#fff;border:none;border-radius:10px;font-family:Geist,sans-serif;font-size:.85rem;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(176,88,48,.3);" disabled>Pay deposit</button>' +
      '</div>';

    modal.appendChild(sheet);
    document.body.appendChild(modal);
    document.body.style.overflow = 'hidden';

    document.getElementById('tb-pe-label').textContent = offerLabel;

    var submitBtn = document.getElementById('tb-pe-submit');
    var cancelBtn = document.getElementById('tb-pe-cancel');
    var closeBtn = document.getElementById('tb-pe-close');
    var statusEl = document.getElementById('tb-pe-status');
    var amountEl = document.getElementById('tb-pe-amount');
    var amountNumEl = document.getElementById('tb-pe-amount-num');

    var submitHandler = null;
    var cancelHandler = null;

    function close() {
      modal.remove();
      document.body.style.overflow = '';
    }
    function doCancel() {
      close();
      if (cancelHandler) cancelHandler();
    }
    cancelBtn.addEventListener('click', doCancel);
    closeBtn.addEventListener('click', doCancel);
    document.addEventListener('keydown', function escHandler(e) {
      if (e.key === 'Escape') {
        var stillExists = document.getElementById('tb-pe-modal');
        if (stillExists) { doCancel(); document.removeEventListener('keydown', escHandler); }
      }
    });

    submitBtn.addEventListener('click', function() {
      if (submitHandler) submitHandler();
    });

    function fmtMoney(cents, currency) {
      var amt = cents / 100;
      return (currency === 'USD' ? '$' : (currency + ' ')) + amt.toLocaleString();
    }

    return {
      setStatus: function(state, message, data) {
        if (state === 'loading') {
          statusEl.style.display = 'block';
          statusEl.style.background = 'rgba(120,100,80,.08)';
          statusEl.style.color = '#5a4e40';
          statusEl.textContent = message;
          submitBtn.disabled = true;
          submitBtn.style.opacity = '.5';
          submitBtn.style.cursor = 'not-allowed';
        } else if (state === 'ready') {
          statusEl.style.display = 'none';
          submitBtn.disabled = false;
          submitBtn.style.opacity = '1';
          submitBtn.style.cursor = 'pointer';
          if (data && data.amount && data.currency) {
            amountEl.style.display = 'block';
            amountNumEl.textContent = fmtMoney(data.amount, data.currency);
            submitBtn.textContent = 'Pay ' + fmtMoney(data.amount, data.currency);
          }
        } else if (state === 'processing') {
          statusEl.style.display = 'block';
          statusEl.style.background = 'rgba(58,112,85,.08)';
          statusEl.style.color = '#3a7055';
          statusEl.textContent = message;
          submitBtn.disabled = true;
          submitBtn.style.opacity = '.5';
          submitBtn.style.cursor = 'not-allowed';
          submitBtn.textContent = 'Processing\u2026';
        } else if (state === 'success') {
          statusEl.style.display = 'block';
          statusEl.style.background = 'rgba(31,106,58,.12)';
          statusEl.style.color = '#1f6a3a';
          statusEl.innerHTML = '<strong>\u2713</strong> ' + message;
          submitBtn.style.display = 'none';
          cancelBtn.style.display = 'none';
        } else if (state === 'error') {
          statusEl.style.display = 'block';
          statusEl.style.background = 'rgba(160,30,30,.08)';
          statusEl.style.color = '#a01e1e';
          statusEl.textContent = message;
          submitBtn.disabled = false;
          submitBtn.style.opacity = '1';
          submitBtn.style.cursor = 'pointer';
        }
      },
      onSubmit: function(fn) { submitHandler = fn; },
      onCancel: function(fn) { cancelHandler = fn; },
      close: close,
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // v74k: payAmendment — inline Stripe Payment Element for amendment
  // delta-deposit charge (Build 2 inline version).
  // Mirrors payDeposit but:
  //   - Calls /api/amendment/create-intent (not /api/checkout/create-intent)
  //   - Sends amendmentId (not offerId)
  //   - On success calls /api/checkout/sync-payment (handles both flows)
  //   - Success callback decides where to navigate (caller passes onSuccess)
  // ────────────────────────────────────────────────────────────────────
  function payAmendment(config) {
    config = config || {};
    var amendmentId = config.amendmentId;
    var amendmentLabel = config.amendmentLabel || 'Booking change';
    var onSuccess = config.onSuccess || function() {};
    var onCancel  = config.onCancel  || function() {};
    var onError   = config.onError   || function(){};

    if (!amendmentId) {
      onError('Missing amendment reference. Please refresh and try again.');
      return;
    }

    var user = window.Clerk && window.Clerk.user;
    var email = user && user.primaryEmailAddress ? user.primaryEmailAddress.emailAddress : '';
    if (!email) {
      onError('Sign-in expired. Please refresh and sign in again.');
      return;
    }

    var modal = createModal(amendmentLabel);
    modal.setStatus('loading', 'Preparing secure payment\u2026');

    var intentPromise = fetch('/api/amendment/create-intent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amendmentId: amendmentId, requesterEmail: email }),
    }).then(function(r) {
      return r.json().then(function(j){ return { ok: r.ok, body: j }; });
    });

    Promise.all([intentPromise, loadStripeJs()])
      .then(function(results) {
        var intentRes = results[0];
        var Stripe = results[1];
        if (!intentRes.ok) {
          var msg = (intentRes.body && intentRes.body.error) || 'Could not start payment';
          modal.setStatus('error', msg);
          return;
        }
        var clientSecret = intentRes.body.client_secret;
        var publishableKey = intentRes.body.publishable_key;
        var amountCents = intentRes.body.amount;
        var currency = (intentRes.body.currency || 'usd').toUpperCase();

        if (!clientSecret || !publishableKey) {
          modal.setStatus('error', 'Stripe response missing required keys');
          return;
        }

        var stripe = Stripe(publishableKey);
        var elements = stripe.elements({
          clientSecret: clientSecret,
          appearance: {
            theme: 'stripe',
            variables: {
              colorPrimary: '#b05830',
              colorBackground: '#ffffff',
              colorText: '#1e1810',
              colorDanger: '#b91c1c',
              fontFamily: 'Geist, system-ui, sans-serif',
              borderRadius: '10px',
            }
          }
        });
        var paymentElement = elements.create('payment', {
          layout: { type: 'tabs', defaultCollapsed: false }
        });
        paymentElement.mount('#tb-pe-mount');

        modal.setStatus('ready', '', { amount: amountCents, currency: currency });

        modal.onSubmit(function() {
          modal.setStatus('processing', 'Processing your payment\u2026');
          stripe.confirmPayment({
            elements: elements,
            confirmParams: {
              return_url: window.location.origin + '/conversations.html?amendment=success',
              receipt_email: email,
            },
            redirect: 'if_required',
          }).then(function(result) {
            if (result.error) {
              modal.setStatus('error', result.error.message || 'Payment failed');
            } else if (result.paymentIntent && result.paymentIntent.status === 'succeeded') {
              modal.setStatus('processing', 'Confirming your booking change\u2026');
              fetch('/api/checkout/sync-payment', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  paymentIntentId: result.paymentIntent.id,
                  requesterEmail: email,
                }),
              })
                .then(function(r) { return r.json().then(function(j){ return { ok: r.ok, body: j }; }); })
                .then(function(syncRes) {
                  if (syncRes.ok && syncRes.body.status) {
                    modal.setStatus('success', 'Payment confirmed.');
                    setTimeout(function() {
                      modal.close();
                      onSuccess(result.paymentIntent);
                    }, 900);
                  } else {
                    console.error('[Stripe inline][amendment] sync failed:', syncRes);
                    modal.setStatus('error',
                      'Payment received but we could not finalise your booking change on our side. ' +
                      'Please contact us at admin@thebearing.io with reference ' +
                      result.paymentIntent.id + ' \u2014 your payment is safe.');
                  }
                })
                .catch(function(err) {
                  console.error('[Stripe inline][amendment] sync error:', err);
                  modal.setStatus('error',
                    'Payment received but we could not finalise your booking change on our side. ' +
                    'Please contact us at admin@thebearing.io with reference ' +
                    result.paymentIntent.id + ' \u2014 your payment is safe.');
                });
            }
          });
        });

        modal.onCancel(function() { onCancel(); });
      })
      .catch(function(err) {
        console.error('[Stripe inline][amendment] setup error:', err);
        modal.setStatus('error', 'Could not load payment form: ' + (err.message || 'unknown'));
      });
  }

  window.TBStripeInline = { payDeposit: payDeposit, payAmendment: payAmendment };
})();
