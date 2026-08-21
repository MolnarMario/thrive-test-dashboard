'use strict';

/**
 * The sign-in form. Lives in its own file rather than inline in login.html so
 * the page's Content-Security-Policy can be `script-src 'self'` — no inline
 * script anywhere means an injected `<script>` never runs, which is the whole
 * point of having a CSP at all.
 */

const form = document.querySelector('#loginForm');
const errorBox = document.querySelector('#loginError');
const btn = document.querySelector('#loginBtn');

/**
 * Where to land after signing in. The server appends ?next= when it
 * bounces a deep link (a report URL, say) so the round trip is invisible.
 * Only same-origin paths are honoured — an open redirect here would be a
 * gift to anyone phishing dashboard users.
 */
function nextUrl() {
  const raw = new URLSearchParams(location.search).get('next') || '/';
  return /^\/(?!\/)/.test(raw) ? raw : '/';
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.remove('hidden');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorBox.classList.add('hidden');
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: document.querySelector('#username').value,
        password: document.querySelector('#password').value,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    location.replace(nextUrl());
  } catch (err) {
    showError(err.message);
    btn.disabled = false;
    btn.textContent = 'Sign in';
    document.querySelector('#password').select();
  }
});
