// First-run setup in the browser (/setup). Whoever installed the server
// connects the organization and its sign-in here, once. Nobody should need a
// terminal to get from "installed" to "signed in".
//
// The setup code is CONTROL_TOKEN, which the installer already has:
// install.sh wrote it to .env.
//
// The form never echoes a secret back. On a refusal it keeps what was public
// (names, addresses, URLs) and empties the code, the certificate and the
// client secret.

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export const SETUP_REASONS = {
  code: 'That setup code is not right. It is CONTROL_TOKEN in this server’s .env file.',
  'too-many': 'Too many wrong setup codes. Wait a few minutes and try again.',
  'already-live': 'This server is already set up.',
  orgName: 'Enter the organization’s name.',
  contactName: 'Enter your name.',
  contactEmail: 'Enter your work email address.',
  method: 'Choose how people sign in.',
  saml: 'Company SAML needs both the identity provider’s sign-in URL and its certificate.',
  samlUrl: 'The SAML sign-in URL must be an https:// address.',
  oidc: 'OpenID Connect needs the issuer URL, the client ID and the client secret.',
  oidcIssuer: 'The issuer URL must be an https:// address.',
  fulfill: 'The organization could not be created. Check the details and try again.',
  shape: 'That submission could not be read.',
}

function page(title, inner) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 16px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #1c1917; background: #f6ecd9; margin: 0; }
  main { max-width: 40rem; margin: 0 auto; padding: 2.5rem 1rem 4rem; }
  .card { background: #fffaf2; border-radius: 18px; padding: 1.75rem; box-shadow: 0 10px 30px rgba(60, 40, 10, .08); }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.05rem; margin: 1.75rem 0 .25rem; }
  p { margin: .5rem 0; }
  .muted { color: #57534e; }
  label { display: block; font-weight: 600; margin-top: 1rem; }
  .hint { display: block; font-weight: 400; color: #57534e; font-size: .9rem; }
  input, textarea, select { width: 100%; box-sizing: border-box; margin-top: .3rem; padding: .6rem .7rem; font: inherit; border: 1px solid #d6cfc4; border-radius: 10px; background: #fff; }
  textarea { min-height: 7rem; font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  fieldset { border: 1px solid #e7dfd2; border-radius: 14px; padding: .5rem 1rem 1rem; margin: 1rem 0 0; }
  legend { font-weight: 700; padding: 0 .4rem; }
  .choice { display: flex; gap: .75rem; flex-wrap: wrap; margin-top: .5rem; }
  .choice label { display: flex; align-items: center; gap: .5rem; margin: 0; font-weight: 600; border: 1px solid #d6cfc4; border-radius: 10px; padding: .55rem .8rem; background: #fff; cursor: pointer; }
  .choice input { width: auto; margin: 0; }
  .copy { font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; background: #f1ead9; border-radius: 8px; padding: .35rem .5rem; display: inline-block; word-break: break-all; }
  .error { background: #fde8e8; color: #7f1d1d; border-radius: 10px; padding: .7rem .9rem; margin: 1rem 0 0; }
  button, .button { display: inline-block; margin-top: 1.5rem; padding: .75rem 1.2rem; font: 600 1rem system-ui, sans-serif; color: #fff; background: #2f6f62; border: 0; border-radius: 999px; cursor: pointer; text-decoration: none; }
  label.tick { display: grid; grid-template-columns: auto 1fr; gap: .2rem .6rem; align-items: start; font-weight: 600; }
  label.tick input { width: auto; margin-top: .3rem; }
  label.tick .hint { grid-column: 2; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<main><div class="card">
${inner}
</div></main>
</body>
</html>`
}

const value = (v) => `value="${escapeHtml(v || '')}"`

/**
 * @param {object} o
 * @param {string} o.origin  this server's address, for the values the
 *   identity provider needs
 * @param {object} [o.values] public values to keep after a refusal
 * @param {string} [o.reason]
 */
export function renderSetupForm({ origin, values = {}, reason = '' }) {
  const method = values.method === 'oidc' ? 'oidc' : values.method === 'saml' ? 'saml' : ''
  const error = reason
    ? `<p class="error" role="alert">${escapeHtml(SETUP_REASONS[reason] || 'The setup did not finish.')}</p>`
    : ''
  const checked = (m) => (method === m ? ' checked' : '')
  return page(
    'Set up Cult Fit SMS',
    `<h1>Set up Cult Fit SMS</h1>
<p class="muted">Connect your organization and its sign-in. This is done once, by whoever installed this server, and takes a few minutes.</p>
${error}
<form method="post" action="/setup" autocomplete="off">
<label for="code">Setup code
<span class="hint">Filled in when you come from the Installer. Otherwise: CONTROL_TOKEN in this server’s settings (.env, or .env.cloudflare for the Cloudflare deployment).</span>
<input id="code" name="code" type="password" required spellcheck="false">
</label>

<h2>Your organization</h2>
<label for="orgName">Organization name
<input id="orgName" name="orgName" required maxlength="120" ${value(values.orgName)}>
</label>
<label for="address">Address <span class="hint">Optional.</span>
<input id="address" name="address" maxlength="200" ${value(values.address)}>
</label>
<label for="contactName">Your name
<input id="contactName" name="contactName" required maxlength="120" ${value(values.contactName)}>
</label>
<label for="contactEmail">Your work email
<span class="hint">You become the administrator. Sign in with this address.</span>
<input id="contactEmail" name="contactEmail" type="email" required maxlength="254" ${value(values.contactEmail)}>
</label>

<h2>How people sign in</h2>
<p class="muted">With your company’s identity provider. Cult Fit SMS keeps no passwords.</p>
<div class="choice" role="radiogroup" aria-label="Sign-in method">
<label><input type="radio" name="method" value="saml" required${checked('saml')}> SAML</label>
<label><input type="radio" name="method" value="oidc"${checked('oidc')}> OpenID Connect (Microsoft Entra, Okta, Google…)</label>
</div>

<fieldset id="saml-fields"${method === 'oidc' ? ' hidden' : ''}>
<legend>SAML</legend>
<p class="hint">Register this application in your identity provider with:<br>
Reply (ACS) URL <span class="copy">${escapeHtml(origin)}/auth/saml</span><br>
Entity ID / audience <span class="copy">${escapeHtml(origin)}</span><br>
Sign-on URL (for the app’s tile in your portal) <span class="copy">${escapeHtml(origin)}/auth/start</span></p>
<label for="samlEntryPoint">Identity provider sign-in URL
<input id="samlEntryPoint" name="samlEntryPoint" type="url" placeholder="https://…" ${value(values.samlEntryPoint)}>
</label>
<label for="samlIdpCert">Identity provider certificate
<span class="hint">The signing certificate, pasted as text. It is public; never paste a private key.</span>
<textarea id="samlIdpCert" name="samlIdpCert" spellcheck="false" placeholder="-----BEGIN CERTIFICATE-----"></textarea>
</label>
</fieldset>

<fieldset id="oidc-fields"${method === 'oidc' ? '' : ' hidden'}>
<legend>OpenID Connect</legend>
<p class="hint">Register this application in your identity provider with redirect URI
<span class="copy">${escapeHtml(origin)}/auth/callback</span><br>
and, for the app’s tile in your portal, home page / sign-in URL
<span class="copy">${escapeHtml(origin)}/auth/start</span></p>
<label for="authIssuer">Issuer URL
<input id="authIssuer" name="authIssuer" type="url" placeholder="https://login.microsoftonline.com/TENANT-ID/v2.0" ${value(values.authIssuer)}>
</label>
<label for="authClientId">Client ID
<input id="authClientId" name="authClientId" ${value(values.authClientId)}>
</label>
<label for="oidcClientSecret">Client secret
<input id="oidcClientSecret" name="oidcClientSecret" type="password" spellcheck="false">
</label>
<label class="tick"><input type="checkbox" name="entraSingleTenant"${values.entraSingleTenant ? ' checked' : ''}> This is Microsoft Entra ID, registered for my organization only (single tenant)
<span class="hint">Entra does not say whether an email address is verified. Tick this only for a single-tenant registration, where your own admins set every address; a multi-tenant one would let accounts from other organizations in.</span>
</label>
</fieldset>

<button type="submit">Set up and go live</button>
</form>
<script>
  // Arriving from the WEEHS Installer: the setup code is in the #fragment,
  // which the browser never sends to a server. Fill it in, and take it out of
  // the address bar and the history.
  const fromInstaller = new URLSearchParams(location.hash.slice(1)).get('code')
  if (fromInstaller) {
    document.getElementById('code').value = fromInstaller
    history.replaceState(null, '', location.pathname)
  }
  // Show only the section for the chosen method. Without script both stay
  // usable: the server reads only the one chosen.
  for (const radio of document.querySelectorAll('input[name=method]')) {
    radio.addEventListener('change', () => {
      document.getElementById('saml-fields').hidden = radio.value !== 'saml'
      document.getElementById('oidc-fields').hidden = radio.value !== 'oidc'
    })
  }
</script>`
  )
}

export function renderSetupDone({ orgName, origin, email }) {
  return page(
    'Cult Fit SMS is live',
    `<h1>${escapeHtml(orgName)} is live</h1>
<p>Sign in with your company account (<b>${escapeHtml(email)}</b>). You are the administrator: invite everyone else from <b>Employees</b>, and add your <b>Sites</b>.</p>
<a class="button" href="${escapeHtml(origin)}/login">Go to sign in</a>`
  )
}

export function renderSetupClosed({ origin }) {
  return page(
    'Already set up',
    `<h1>Already set up</h1>
<p>This server is connected to its organization. Sign in with your company account.</p>
<a class="button" href="${escapeHtml(origin)}/login">Go to sign in</a>`
  )
}
