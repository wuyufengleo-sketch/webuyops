const crypto = require('crypto');

const SECRET = process.env.JWT_SECRET || 'webuy-ops-secret-change-me-2024';

// Default users — override via USERS_JSON env var in Vercel dashboard
// Format: [{"username":"...","password":"...","role":"...","name":"..."}]
const DEFAULT_USERS = [
  { username: 'leo',        password: 'Leo@Webuy2024',        role: 'admin',     name: 'Leo' },
  { username: 'ops',        password: 'Ops@Webuy2024',        role: 'ops',       name: 'OPS Team' },
  { username: 'visa',       password: 'Visa@Webuy2024',       role: 'visa',      name: 'Visa Team' },
  { username: 'ticketing',  password: 'Tkt@Webuy2024',        role: 'ticketing', name: 'Ticketing Team' },
  { username: 'cs',         password: 'CS@Webuy2024',         role: 'cs',        name: 'CS Team' },
  { username: 'sales',      password: 'Sales@Webuy2024',      role: 'sales',     name: 'Sales Team' },
];

function getUsers() {
  try {
    const extra = JSON.parse(process.env.USERS_JSON || '[]');
    return [...DEFAULT_USERS, ...extra];
  } catch {
    return DEFAULT_USERS;
  }
}

function signToken(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

  const users = getUsers();
  const user = users.find(u => u.username === username.trim() && u.password === password);

  if (!user) {
    // Delay to prevent brute force
    await new Promise(r => setTimeout(r, 800));
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = signToken({
    username: user.username,
    role: user.role,
    name: user.name,
    exp: Date.now() + 10 * 60 * 60 * 1000, // 10 hours
  });

  return res.status(200).json({ token, role: user.role, name: user.name });
};
