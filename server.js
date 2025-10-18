// server.js
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const fs = require("fs");
const initSqlJs = require("sql.js");
const bodyParser = require("body-parser");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(bodyParser.json());
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

let db;
let SQL; // sql.js instance

const DB_FILE = path.join(__dirname, "mhyasi.db");
const SECRET = "mhyasi-secret-change-this";

(async () => {
  SQL = await initSqlJs();
  if (fs.existsSync(DB_FILE)) {
    const filebuffer = fs.readFileSync(DB_FILE);
    db = new SQL.Database(filebuffer);
    console.log("Loaded existing DB.");
  } else {
    db = new SQL.Database();
    console.log("Creating new DB...");
    db.run(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        role TEXT DEFAULT 'user',
        shop_name TEXT,
        shop_address TEXT,
        logo_path TEXT,
        unlock_until INTEGER
      );
    `);
    db.run(`
      CREATE TABLE products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        name TEXT,
        price REAL,
        qty INTEGER
      );
    `);
    db.run(`
      CREATE TABLE invoices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        invoice_id TEXT,
        items TEXT,
        total REAL,
        created_at INTEGER
      );
    `);
    db.run(`
      CREATE TABLE requests (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        amount REAL,
        details TEXT
      );
    `);
    db.run(`
      CREATE TABLE codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        for_user INTEGER,
        code TEXT,
        until INTEGER
      );
    `);

    // create uploads folder
    if (!fs.existsSync(path.join(__dirname, "uploads"))) fs.mkdirSync(path.join(__dirname, "uploads"));

    // create default admin
    const adminUser = "admin";
    const adminPass = "admin123";
    const hash = bcrypt.hashSync(adminPass, 8);
    db.run(
      "INSERT INTO users (username,password,role,shop_name,shop_address) VALUES (?,?,?,?,?)",
      [adminUser, hash, "admin", "Admin Store", "HQ"]
    );

    saveDb();
    console.log("DB created and admin user inserted (admin/admin123).");
  }
})();

function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_FILE, Buffer.from(data));
}

/* helper auth middleware */
function auth(req, res, next) {
  const h = req.headers["authorization"];
  if (!h) return res.status(401).json({ ok: false, error: "No token" });
  try {
    const token = h.split(" ")[1];
    req.user = jwt.verify(token, SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }
}

/* ========= AUTH API ========== */
app.post("/api/register", (req, res) => {
  const { username, password, shop_name, shop_address } = req.body;
  if (!username || !password) return res.json({ ok: false, error: "missing fields" });
  const hash = bcrypt.hashSync(password, 8);
  try {
    db.run(
      "INSERT INTO users (username, password, shop_name, shop_address) VALUES (?,?,?,?)",
      [username, hash, shop_name || "", shop_address || ""]
    );
    saveDb();
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: false, error: "username exists" });
  }
});

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const r = db.exec("SELECT id, username, password, role, shop_name, shop_address, logo_path FROM users WHERE username = '" + username.replace(/'/g,"''") + "'");
  if (!r[0]) return res.json({ ok: false, error: "User not found" });
  const u = r[0].values[0];
  if (!bcrypt.compareSync(password, u[2])) return res.json({ ok: false, error: "Wrong pass" });
  const token = jwt.sign({ id: u[0], username: u[1], role: u[3] }, SECRET);
  res.json({
    ok: true,
    token,
    user: {
      id: u[0],
      username: u[1],
      role: u[3],
      shop_name: u[4],
      shop_address: u[5],
      logo_path: u[6],
    },
  });
});

app.get("/api/me", auth, (req, res) => {
  const r = db.exec("SELECT id, username, role, shop_name, shop_address, logo_path FROM users WHERE id = " + Number(req.user.id));
  if (!r[0]) return res.json({ ok: false });
  const u = r[0].values[0];
  res.json({ ok: true, user: { id: u[0], username: u[1], role: u[2], shop_name: u[3], shop_address: u[4], logo_path: u[5] } });
});

/* profile update */
app.post("/api/profile", auth, (req, res) => {
  const { shop_name, shop_address } = req.body;
  db.run("UPDATE users SET shop_name=?, shop_address=? WHERE id=?", [shop_name || "", shop_address || "", req.user.id]);
  saveDb();
  res.json({ ok: true });
});

/* upload logo */
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, path.join(__dirname, "uploads"));
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname.replace(/\s+/g, "_"));
  }
});
const upload = multer({ storage });

app.post("/api/profile/logo", auth, upload.single("logo"), (req, res) => {
  const p = "/uploads/" + req.file.filename;
  db.run("UPDATE users SET logo_path=? WHERE id=?", [p, req.user.id]);
  saveDb();
  res.json({ ok: true, logo_path: p });
});

/* ========== PRODUCTS ========== */
app.get("/api/products", auth, (req, res) => {
  const r = db.exec("SELECT id, user_id, name, price, qty FROM products WHERE user_id = " + Number(req.user.id));
  const arr = r[0] ? r[0].values.map(v => ({ id: v[0], user_id: v[1], name: v[2], price: v[3], qty: v[4] })) : [];
  res.json({ ok: true, products: arr });
});

app.post("/api/products", auth, (req, res) => {
  const { name, price, qty } = req.body;
  db.run("INSERT INTO products (user_id, name, price, qty) VALUES (?,?,?,?)", [req.user.id, name, price || 0, qty || 0]);
  saveDb();
  res.json({ ok: true });
});

app.put("/api/products/:id", auth, (req, res) => {
  const id = Number(req.params.id);
  const { name, price, qty } = req.body;
  db.run("UPDATE products SET name=?, price=?, qty=? WHERE id=? AND user_id=?", [name, price || 0, qty || 0, id, req.user.id]);
  saveDb();
  res.json({ ok: true });
});

app.delete("/api/products/:id", auth, (req, res) => {
  const id = Number(req.params.id);
  db.run("DELETE FROM products WHERE id=? AND user_id=?", [id, req.user.id]);
  saveDb();
  res.json({ ok: true });
});

/* ========== INVOICES (create & auto reduce stock) ========== */
app.post("/api/invoices", auth, (req, res) => {
  try {
    const { invoice_id, items, total } = req.body;
    const now = Math.floor(Date.now() / 1000);
    db.run("INSERT INTO invoices (user_id, invoice_id, items, total, created_at) VALUES (?,?,?,?,?)", [req.user.id, invoice_id, JSON.stringify(items), total || 0, now]);
    // reduce products qty atomically per item
    items.forEach(it => {
      // ensure qty doesn't go below zero on DB
      db.run("UPDATE products SET qty = CASE WHEN qty - ? >= 0 THEN qty - ? ELSE 0 END WHERE id = ? AND user_id = ?", [it.qty, it.qty, it.id, req.user.id]);
    });
    saveDb();
    res.json({ ok: true });
  } catch (e) {
    console.error("err invoice", e);
    res.json({ ok: false, error: "server error" });
  }
});

app.get("/api/invoices", auth, (req, res) => {
  const r = db.exec("SELECT id, user_id, invoice_id, items, total, created_at FROM invoices WHERE user_id = " + Number(req.user.id));
  const arr = r[0] ? r[0].values.map(v => ({ id: v[0], user_id: v[1], invoice_id: v[2], items: v[3], total: v[4], created_at: v[5] })) : [];
  res.json({ ok: true, invoices: arr });
});

/* ========== REQUESTS & CODES (simple) ========== */
app.post("/api/request", auth, (req, res) => {
  const { amount, details } = req.body;
  db.run("INSERT INTO requests (user_id, amount, details) VALUES (?,?,?)", [req.user.id, amount || 0, details || ""]);
  saveDb();
  res.json({ ok: true });
});

app.get("/api/requests", auth, (req, res) => {
  // only admin sees all
  if (req.user.role !== "admin") return res.json({ ok: false, error: "admin only" });
  const r = db.exec("SELECT r.id, r.user_id, r.amount, r.details, u.username FROM requests r LEFT JOIN users u ON r.user_id = u.id ORDER BY r.id DESC");
  const arr = r[0] ? r[0].values.map(v => ({ id: v[0], user_id: v[1], amount: v[2], details: v[3], username: v[4] })) : [];
  res.json({ ok: true, requests: arr });
});

app.post("/api/approve", auth, (req, res) => {
  if (req.user.role !== "admin") return res.json({ ok: false, error: "admin only" });
  const { requestId, duration = 30 } = req.body;
  // find request
  const r = db.exec("SELECT user_id FROM requests WHERE id = " + Number(requestId));
  if (!r[0]) return res.json({ ok: false, error: "request not found" });
  const uid = r[0].values[0][0];
  const code = "CODE-" + Math.random().toString(36).slice(2,8).toUpperCase();
  const until = Math.floor(Date.now() / 1000) + duration * 24 * 3600;
  db.run("INSERT INTO codes (for_user, code, until) VALUES (?,?,?)", [uid, code, until]);
  saveDb();
  res.json({ ok: true, code, until });
});

app.get("/api/codes", auth, (req, res) => {
  if (req.user.role !== "admin") return res.json({ ok: false, error: "admin only" });
  const r = db.exec("SELECT c.id, c.for_user, c.code, c.until, u.username as for_username FROM codes c LEFT JOIN users u ON c.for_user = u.id ORDER BY c.id DESC");
  const arr = r[0] ? r[0].values.map(v => ({ id: v[0], for_user: v[1], code: v[2], until: v[3], for_username: v[4] })) : [];
  res.json({ ok: true, codes: arr });
});

app.post("/api/redeem", auth, (req, res) => {
  const { code } = req.body;
  const r = db.exec("SELECT id, for_user, until FROM codes WHERE code = '" + String(code).replace(/'/g,"''") + "' LIMIT 1");
  if (!r[0]) return res.json({ ok: false, error: "invalid code" });
  const row = r[0].values[0];
  const until = Number(row[2]) || 0;
  if (Math.floor(Date.now() / 1000) > until) return res.json({ ok: false, error: "code expired" });
  // set unlock_until for user
  const userId = Number(row[1]);
  db.run("UPDATE users SET unlock_until = ? WHERE id = ?", [until, userId]);
  saveDb();
  res.json({ ok: true, msg: "redeemed" });
});

/* health */
app.get("/", (req, res) => {
  res.json({ ok: true, msg: "Mhyasi Store API" });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`✅ Mhyasi Store running on port ${PORT}`));

