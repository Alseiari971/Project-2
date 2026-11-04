// GameShelf's emails: a code email in GameShelf's look (dark, the lime accent,
// the code in big digit boxes), English and then Arabic, right to left, plus
// a plain-text copy for mail apps that don't show designs.
//
// Mail apps ignore stylesheets and block outside images by default, so it's
// built the old way: tables and inline styles, no pictures, no scripts.

const COLORS = { bg: '#0b0c0e', card: '#15161a', raised: '#25272d', border: '#26282e', text: '#f2f3f5', dim: '#a3a6ad', faint: '#7c7f87', accent: '#e7ff0c' };
const FONT = "'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif";
const FONT_AR = "'Segoe UI', Tahoma, 'Geeza Pro', 'Noto Naskh Arabic', Arial, sans-serif";

// Gmail's apps turn emails light in dark mode by inverting their colors. They
// leave background images alone, so each background is also a one-color
// gradient, and the text sits inside two blended layers (the gmail-screen and
// gmail-difference styles below, which only Gmail applies) that undo the
// inversion. That gives white and greys back exactly but shifts other colors
// (lime turns lavender), so in Gmail lime text becomes white (gs-lime) and the
// lime is only in solid shapes; borders are inverted too, so there are none.
// Other mail apps show the colors as they are.
const bg = (color) => `background-color:${color};background-image:linear-gradient(${color},${color});`;
const GMAIL_FIX = `<style>
  u + .body .gmail-screen { background:#000; mix-blend-mode:screen; }
  u + .body .gmail-difference { background:#000; mix-blend-mode:difference; }
  u + .body .gs-lime { color:#ffffff !important; }
</style>`;
const keepColors = (inner) => `<div class="gmail-screen"><div class="gmail-difference">${inner}</div></div>`;

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const COPY = {
  verify: {
    subject: 'Your GameShelf email code: {code}',
    preheader: 'Your code is {code}. It works for 10 minutes.',
    title: 'Confirm your email',
    lead: 'Enter this code on GameShelf to confirm this email address is yours.',
    note: "If you didn't make a GameShelf account, you can ignore this email.",
    titleAr: 'أكّد بريدك الإلكتروني',
    leadAr: 'أدخل هذا الرمز في GameShelf لتأكيد أن هذا البريد لك.',
    noteAr: 'إذا لم تنشئ حسابًا في GameShelf، يمكنك تجاهل هذه الرسالة.',
  },
  login: {
    subject: 'Your GameShelf Guard code: {code}',
    preheader: 'Someone signed in with your password. Your Guard code is {code}.',
    title: 'Your GameShelf Guard code',
    lead: 'Someone (hopefully you) just signed in to GameShelf with your password from a new browser or PC. Enter this code to finish signing in.',
    note: "If this wasn't you, change your password now. Your account stays safe: nobody can sign in without this code.",
    titleAr: 'رمز حارس GameShelf',
    leadAr: 'سجّل أحدهم (نأمل أنه أنت) الدخول إلى GameShelf بكلمة مرورك من متصفح أو جهاز جديد. أدخل هذا الرمز لإكمال تسجيل الدخول.',
    noteAr: 'إذا لم تكن أنت، غيّر كلمة مرورك الآن. حسابك آمن: لا أحد يستطيع الدخول بدون هذا الرمز.',
  },
  reset: {
    subject: 'Reset your GameShelf password: {code}',
    preheader: 'Your password reset code is {code}. It works for 10 minutes.',
    title: 'Reset your password',
    lead: 'Someone asked to reset the password of your GameShelf account. Enter this code on GameShelf, then choose a new password.',
    note: "If you didn't ask for this, ignore this email: your password stays the same, and nobody can change it without this code.",
    titleAr: 'إعادة تعيين كلمة المرور',
    leadAr: 'طلب أحدهم إعادة تعيين كلمة مرور حسابك في GameShelf. أدخل هذا الرمز في GameShelf، ثم اختر كلمة مرور جديدة.',
    noteAr: 'إذا لم تطلب هذا، تجاهل الرسالة: كلمة مرورك لن تتغير، ولا أحد يستطيع تغييرها بدون هذا الرمز.',
  },
  enable: {
    subject: 'Turn on GameShelf Guard: {code}',
    preheader: 'Your code to turn on Email Guard is {code}.',
    title: 'Turn on GameShelf Guard',
    lead: 'Enter this code on GameShelf to turn on Guard by email. After that, new browsers and PCs need a code from your inbox to sign in.',
    note: "If you didn't ask for this, someone may know your password. Change it now.",
    titleAr: 'تفعيل حارس GameShelf',
    leadAr: 'أدخل هذا الرمز في GameShelf لتفعيل الحارس عبر البريد. بعدها ستحتاج المتصفحات والأجهزة الجديدة رمزًا من بريدك لتسجيل الدخول.',
    noteAr: 'إذا لم تطلب هذا، فقد يعرف أحدهم كلمة مرورك. غيّرها الآن.',
  },
};

const fill = (text, code) => text.replace('{code}', code);

/** The digits, each in its own box, reading left to right in both languages. */
function codeBoxes(code) {
  const cells = [...code].map((d) => `<td style="padding:0 4px;"><div style="width:44px;height:56px;line-height:56px;border-radius:10px;${bg(COLORS.raised)}color:${COLORS.text};font:700 28px/56px ${FONT};text-align:center;">${keepColors(escape(d))}</div></td>`).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center" dir="ltr" style="margin:0 auto;"><tr>${cells}</tr></table>`;
}

const linkTo = (site) => (site ? `<a href="${escape(site)}" style="color:${COLORS.dim};text-decoration:underline;">${escape(site.replace(/^https?:\/\//, ''))}</a>` : 'GameShelf');

/** A button: white text on a raised pill (it survives Gmail's dark mode), with a lime edge. */
const button = (href, label, arrow = '&rarr;') => `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td style="border-radius:999px;${bg(COLORS.raised)}">
  <a href="${escape(href)}" style="display:inline-block;padding:12px 24px;font:700 15px/1 ${FONT};color:${COLORS.text};text-decoration:none;">${keepColors(`${escape(label)} <span class="gs-lime" style="color:${COLORS.accent};">${arrow}</span>`)}</a>
</td></tr></table>`;

/**
 * The page every email shares: the logo, a card with the English and then
 * the Arabic, and a footer. `middle` is HTML placed under the English lead
 * (the code boxes, a button), `middleAr` the same under the Arabic.
 */
function layout({ subject, preheader, title, lead, middle = '', note = '', titleAr, leadAr, middleAr = '', noteAr = '', footer }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${escape(subject)}</title>
${GMAIL_FIX}
</head>
<body class="body" style="margin:0;padding:0;${bg(COLORS.bg)}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${COLORS.bg};">${escape(preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${bg(COLORS.bg)}">
<tr><td align="center" style="padding:32px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
    <tr><td style="padding:0 8px 24px;font:800 24px/1 ${FONT};letter-spacing:-0.5px;color:${COLORS.text};"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
      <td valign="top" style="vertical-align:top;font:800 24px/1 ${FONT};letter-spacing:-0.5px;color:${COLORS.text};">${keepColors('Game')}</td>
      <td valign="top" style="vertical-align:top;font:800 24px/1 ${FONT};letter-spacing:-0.5px;">${keepColors(`<span class="gs-lime" style="color:${COLORS.accent};">Shelf</span>`)}<div style="height:4px;margin-top:4px;border-radius:2px;${bg(COLORS.accent)}font-size:0;line-height:0;">&nbsp;</div></td>
    </tr></table></td></tr>
    <tr><td style="${bg(COLORS.card)}border-radius:16px;overflow:hidden;">
      <div style="height:4px;${bg(COLORS.accent)}font-size:0;line-height:0;">&nbsp;</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td style="padding:32px 32px 8px;">
          ${keepColors(`<h1 style="margin:0 0 12px;font:800 24px/1.25 ${FONT};color:${COLORS.text};">${escape(title)}</h1>
          <p style="margin:0;font:400 15px/1.6 ${FONT};color:${COLORS.dim};white-space:pre-line;">${escape(lead)}</p>`)}
        </td></tr>
        ${middle}
        ${note ? `<tr><td style="padding:0 32px 28px;font:400 13px/1.6 ${FONT};color:${COLORS.faint};">${keepColors(escape(note))}</td></tr>` : '<tr><td style="padding:0 0 20px;"></td></tr>'}
        <tr><td style="padding:0 32px;"><div style="height:1px;${bg(COLORS.border)}font-size:0;line-height:0;">&nbsp;</div></td></tr>
        <tr><td dir="rtl" lang="ar" style="padding:28px 32px 32px;text-align:right;font-family:${FONT_AR};">
          ${keepColors(`<h2 style="margin:0 0 8px;font:700 19px/1.5 ${FONT_AR};color:${COLORS.text};">${escape(titleAr)}</h2>
          <p style="margin:0 0 12px;font:400 15px/1.8 ${FONT_AR};color:${COLORS.dim};">${escape(leadAr)}</p>
          ${middleAr}
          ${noteAr ? `<p style="margin:0;font:400 13px/1.8 ${FONT_AR};color:${COLORS.faint};">${escape(noteAr)}</p>` : ''}`)}
        </td></tr>
      </table>
    </td></tr>
    <tr><td align="center" style="padding:24px 8px 0;font:400 12px/1.6 ${FONT};color:${COLORS.faint};">${keepColors(footer)}</td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;
}

/** { subject, text, html } for a six-digit code email. `site` is the site's address, for the footer link. */
function codeEmail(purpose, code, { site = null } = {}) {
  const c = COPY[purpose] || COPY.verify;
  const subject = fill(c.subject, code);
  const text = [
    c.title, '', c.lead, '', `    ${code}`, '', 'It works for 10 minutes and only once.', c.note, '',
    '—', c.titleAr, c.leadAr, `الرمز: ${code}`, 'يعمل لمدة 10 دقائق ولمرة واحدة.', c.noteAr, '',
    site ? `GameShelf · ${site}` : 'GameShelf',
  ].join('\n');
  const html = layout({
    subject,
    preheader: fill(c.preheader, code),
    title: c.title,
    lead: c.lead,
    middle: `<tr><td style="padding:24px 24px 8px;" align="center">${codeBoxes(code)}</td></tr>
        <tr><td align="center" style="padding:8px 32px 24px;font:600 13px/1.5 ${FONT};color:${COLORS.faint};">${keepColors('Works for 10 minutes, once.')}</td></tr>`,
    note: c.note,
    titleAr: c.titleAr,
    leadAr: c.leadAr,
    middleAr: `<p style="margin:0 0 8px;font:600 15px/1.8 ${FONT_AR};color:${COLORS.text};">الرمز: <span dir="ltr" class="gs-lime" style="color:${COLORS.accent};letter-spacing:3px;font-weight:800;font-family:${FONT};">${escape(code)}</span> · يعمل لمدة 10 دقائق ولمرة واحدة.</p>`,
    noteAr: c.noteAr,
    footer: `Sent by ${linkTo(site)} because a code was asked for on your account.<br>GameShelf will never ask you for this code by message or phone.`,
  });
  return { subject, text, html };
}

// Security alerts: something important changed on the account. They go to
// the account's address (for a new address, to the old one), so the owner
// hears about it even when someone else did it.
const NOTICES = {
  password: {
    subject: 'Your GameShelf password was changed',
    title: 'Your password was changed',
    lead: 'The password of your GameShelf account @{username} was just changed, and every other place it was signed in was signed out.',
    note: "If this was you, there's nothing to do. If it wasn't, reset your password now and turn on GameShelf Guard.",
    titleAr: 'تم تغيير كلمة مرورك',
    leadAr: 'تم للتو تغيير كلمة مرور حسابك ‎@{username} في GameShelf، وسُجّل الخروج من كل مكان آخر.',
    noteAr: 'إذا كنت أنت، فلا شيء عليك. وإن لم تكن أنت، أعد تعيين كلمة المرور الآن وفعّل حارس GameShelf.',
    action: { path: '/#/forgot', label: 'Reset password', labelAr: 'إعادة تعيين كلمة المرور' },
  },
  'guard-off': {
    subject: 'GameShelf Guard was turned off',
    title: 'GameShelf Guard is off',
    lead: 'Two-step sign-in was just turned off for your GameShelf account @{username}. Now your password alone signs in.',
    note: "If this wasn't you, change your password now and turn Guard back on in Security settings.",
    titleAr: 'تم إيقاف حارس GameShelf',
    leadAr: 'تم للتو إيقاف التحقق بخطوتين لحسابك ‎@{username} في GameShelf. الآن تكفي كلمة المرور وحدها لتسجيل الدخول.',
    noteAr: 'إذا لم تكن أنت، غيّر كلمة مرورك الآن وأعد تفعيل الحارس من إعدادات الأمان.',
    action: { path: '/#/settings/security', label: 'Security settings', labelAr: 'إعدادات الأمان' },
  },
  'email-changed': {
    subject: 'Your GameShelf email address was changed',
    title: 'Your email address was changed',
    lead: 'The email address of your GameShelf account @{username} was just changed to {email}. GameShelf emails will go there from now on.',
    note: "If this wasn't you, sign in and change your password right away, then contact GameShelf Support.",
    titleAr: 'تم تغيير بريدك الإلكتروني',
    leadAr: 'تم للتو تغيير البريد الإلكتروني لحسابك ‎@{username} في GameShelf إلى {email}. ستصل رسائل GameShelf إليه من الآن.',
    noteAr: 'إذا لم تكن أنت، سجّل الدخول وغيّر كلمة مرورك فورًا، ثم تواصل مع دعم GameShelf.',
    action: { path: '/#/support', label: 'Contact Support', labelAr: 'تواصل مع الدعم' },
  },
  'support-reply': {
    subject: 'GameShelf Support replied: {subject}',
    title: 'Support replied to your ticket',
    lead: 'GameShelf Support answered your ticket “{subject}”:\n\n{message}',
    titleAr: 'ردّ الدعم على تذكرتك',
    leadAr: 'ردّ فريق دعم GameShelf على تذكرتك «{subject}». افتح التذكرة لقراءة الرد والرد عليه.',
    action: { path: '/#/support/{ticket}', label: 'Open the ticket', labelAr: 'افتح التذكرة' },
  },
};

const fillAll = (text, vars) => text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));

/** { subject, text, html } for a security alert or a support reply. `vars` fills {username}, {email}, {subject}, {message}, {ticket}. */
function noticeEmail(kind, vars = {}, { site = null } = {}) {
  const n = NOTICES[kind];
  const f = (text) => (text ? fillAll(text, vars) : '');
  const subject = f(n.subject).slice(0, 180);
  const href = n.action && site ? site.replace(/\/+$/, '') + fillAll(n.action.path, vars) : null;
  const text = [
    f(n.title), '', f(n.lead), '', href ? `${n.action.label}: ${href}` : '', f(n.note), '',
    '—', f(n.titleAr), f(n.leadAr), f(n.noteAr), '', site ? `GameShelf · ${site}` : 'GameShelf',
  ].filter((line, i, all) => line || all[i - 1]).join('\n');
  const html = layout({
    subject,
    preheader: f(n.lead).slice(0, 140),
    title: f(n.title),
    lead: f(n.lead),
    middle: href ? `<tr><td style="padding:24px 32px 24px;">${button(href, n.action.label)}</td></tr>` : '',
    note: f(n.note),
    titleAr: f(n.titleAr),
    leadAr: f(n.leadAr),
    middleAr: href ? `<div style="margin:4px 0 12px;">${button(href, n.action.labelAr, '&larr;')}</div>` : '',
    noteAr: f(n.noteAr),
    footer: `Sent by ${linkTo(site)} about your account.<br>GameShelf will never ask for your password or codes by email.`,
  });
  return { subject, text, html };
}

module.exports = { codeEmail, noticeEmail };
