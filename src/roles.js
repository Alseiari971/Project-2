// Who runs the site. Accounts are 'user' unless they're an admin; admins see
// the Admin Panel (users, the Arabic pack catalog, requests, the installer) and
// can publish Arabic packs.
//
// The first admins come from ADMIN_USERS (usernames, comma separated;
// ARABIC_ADMINS, its older name, works too): those accounts become admins when
// the server starts and when they're registered. After that, admins promote
// and demote others in the Admin Panel.
const ROLES = ['user', 'admin'];

function adminNames(env = process.env) {
  return [env.ADMIN_USERS, env.ARABIC_ADMINS].join(',').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** Makes the ADMIN_USERS accounts admins. Returns how many accounts changed. */
function bootstrapAdmins(db, env = process.env) {
  const names = adminNames(env);
  if (!names.length) return 0;
  const promote = db.prepare("UPDATE users SET role = 'admin' WHERE username = ? COLLATE NOCASE AND role <> 'admin'");
  return names.reduce((n, name) => n + Number(promote.run(name).changes), 0);
}

module.exports = { ROLES, adminNames, bootstrapAdmins };
