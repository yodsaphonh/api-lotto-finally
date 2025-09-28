const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const os = require("os");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// connect db
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT) || 4016,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  keepAliveInitialDelay: 10000,
  enableKeepAlive: true,
  connectTimeout: 20000,
  ssl: { rejectUnauthorized: true, servername: process.env.DB_HOST }
});
// test route
app.get("/", (req, res) => {
  res.send("API is running 🚀");
});

// DELETE /users/:id  — ลบ orders ของ user ก่อน แล้วค่อยลบ user (ถ้าไม่ใช่ admin)
app.delete("/users/:id", async (req, res) => {
  const uid = Number(req.params.id);
  if (!Number.isInteger(uid) || uid <= 0) {
    return res.status(400).json({ error: "invalid user_id" });
  }

  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    // 1) ลบ orders ที่อ้าง user นี้ก่อน (กัน FK ติด)
    const [delOrders] = await conn.query(
      "DELETE FROM orders WHERE user_id = ?",
      [uid]
    );

    // 2) ค่อยลบจาก users แต่ห้ามลบ admin
    const [delUser] = await conn.query(
      "DELETE FROM users WHERE user_id = ? AND LOWER(role) <> 'admin'",
      [uid]
    );

    if (delUser.affectedRows === 0) {
      // ไม่มี user นี้ หรือเป็น admin → ยกเลิกและแจ้ง
      await conn.rollback();
      return res.status(404).json({
        message: "ไม่พบผู้ใช้ หรือผู้ใช้นั้นเป็น admin (จึงไม่ลบ)",
        deleted: { orders: delOrders.affectedRows || 0, users: 0 }
      });
    }

    await conn.commit();
    return res.json({
      message: "✅ ลบผู้ใช้สำเร็จ",
      deleted: {
        orders: delOrders.affectedRows || 0,
        users: delUser.affectedRows || 0
      }
    });
  } catch (err) {
    if (conn) { try { await conn.rollback(); } catch {} }
    return res.status(500).json({ error: err.message });
  } finally {
    if (conn) conn.release();
  }
});


// health check DB
app.get("/db-check", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT NOW() now, DATABASE() db");
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.code || e.message });
  }
});

//test select all users
app.get("/users", async (req, res) => {
  try {
    const [results] = await db.query("SELECT * FROM users");
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET: ดึงรางวัลงวดล่าสุด (รางวัลที่ 1, 2, 3, เลขท้าย 3 ตัว, เลขท้าย 2 ตัว)
app.get("/reward/latest", async (req, res) => {
  try {
    // 1) หางวดล่าสุด
    const [latest] = await db.query("SELECT MAX(reward_id) AS rid FROM reward");
    const rewardId = latest[0]?.rid;

    if (!rewardId) {
      return res.status(404).json({ message: "ยังไม่มีงวดในระบบ" });
    }

    // 2) ดึง reward_data ของงวดล่าสุด
    const [rows] = await db.query(
      "SELECT reward_id, CAST(reward_data AS CHAR) AS reward_data, date FROM reward WHERE reward_id = ?",
      [rewardId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "ไม่พบ reward_data" });
    }

    let rewardData;
    try {
      rewardData = JSON.parse(rows[0].reward_data);
    } catch (err) {
      return res.status(500).json({ error: "reward_data format invalid" });
    }

    // 3) กรองเอาเฉพาะ tier 1-5
    const filtered = rewardData
      .filter(r => [1, 2, 3, 4, 5].includes(r.tier))
      .map(r => ({
        name: r.name,
        tier: r.tier,
        amount: r.amount,
        winning: r.winning
      }));

    // 4) ส่งออก
    res.json({
      message: "✅ ดึงข้อมูลรางวัลงวดล่าสุดสำเร็จ",
      reward_id: rows[0].reward_id,
      date: rows[0].date,
      rewards: filtered
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


//==================================================================
//                        ADMIN ROUTE
//==================================================================
// insert lotto (ที่ละ 1 ใบ)
app.post("/lotto", async (req, res) => {
  const { id, number } = req.body;
  const status = "ยังไม่ถูกซื้อ";
  const price = 80;

  if (!id || !number) {
    return res.status(400).json({ error: "กรุณาระบุ id และ number" });
  }

  try {
    // 0) ตรวจ role ของ user
    const [users] = await db.query("SELECT role FROM users WHERE user_id = ?", [id]);
    if (users.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    if (String(users[0].role).toLowerCase() !== "admin") {
      return res.status(403).json({ error: "Only admin can insert lotto" });
    }

    // 1) หางวดล่าสุด
    const [latest] = await db.query("SELECT MAX(reward_id) AS rid FROM reward");
    const reward_id = latest[0]?.rid;
    if (!reward_id) {
      return res.status(400).json({ message: "No reward found (ยังไม่มีงวด)" });
    }

    // 2) ตรวจสอบว่า งวดล่าสุดมีการออกรางวัลไปแล้วหรือยัง
    const [rewardRows] = await db.query(
      "SELECT CAST(reward_data AS CHAR) AS reward_data FROM reward WHERE reward_id = ?",
      [reward_id]
    );

    if (!rewardRows.length) {
      return res.status(404).json({ error: "ไม่พบข้อมูล reward" });
    }

    let rewardData;
    try {
      rewardData = JSON.parse(rewardRows[0].reward_data);
    } catch (err) {
      return res.status(500).json({ error: "reward_data format invalid" });
    }

    const alreadyDrawn = rewardData.some(
      (r) => r.winning !== null && r.winning !== undefined && String(r.winning).trim() !== ""
    );

    if (alreadyDrawn) {
      return res.status(400).json({ error: "งวดนี้มีการออกรางวัลแล้ว ไม่สามารถเพิ่มเลขใหม่ได้" });
    }

    // 3) ตรวจว่าเลขนี้มีอยู่แล้วในงวดล่าสุดหรือไม่
    const [check] = await db.query(
      "SELECT * FROM lotto WHERE reward_id = ? AND number = ?",
      [reward_id, number]
    );
    if (check.length > 0) {
      return res.status(400).json({ message: "This number already exists in this reward" });
    }

    // 4) Insert เข้า lotto (งวดล่าสุด)
    const [results] = await db.query(
      "INSERT INTO lotto (reward_id, number, price, status) VALUES (?, ?, ?, ?)",
      [reward_id, number, price, status]
    );

    res.json({
      message: "✅ Lotto inserted successfully",
      lotto_id: results.insertId,
      reward_id,
      data: { number, price, status }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ADMIN: RANDOM LOTTO (หลายใบ - งวดล่าสุดเท่านั้น)
function generateRandomNumber() { // ฟังก์ชันสุ่มเลข 6 หลัก
  return String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
}

app.post("/lotto/random", async (req, res) => {
  const { id, randomCount } = req.body;
  const price = 80;
  const lotto_status = "ยังไม่ถูกซื้อ";

  if (!id) {
    return res.status(400).json({ error: "กรุณาระบุ id" });
  }
  if (!randomCount || randomCount <= 0) {
    return res.status(400).json({ error: "กรุณาระบุจำนวน randomCount > 0" });
  }

  try {
    // 0) ตรวจสอบ role ของ user
    const [users] = await db.query("SELECT role FROM users WHERE user_id = ?", [id]);
    if (users.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    if (String(users[0].role).toLowerCase() !== "admin") {
      return res.status(403).json({ error: "Only admin can random lotto" });
    }

    // 1) หางวดล่าสุด
    const [latest] = await db.query("SELECT MAX(reward_id) AS rid FROM reward");
    const reward_id = latest[0]?.rid;
    if (!reward_id) {
      return res.status(400).json({ message: "No reward found (ยังไม่มีงวด)" });
    }

    // 2) ตรวจสอบว่า งวดล่าสุดมีการออกรางวัลไปแล้วหรือยัง
    const [rewardRows] = await db.query(
      "SELECT CAST(reward_data AS CHAR) AS reward_data FROM reward WHERE reward_id = ?",
      [reward_id]
    );

    if (!rewardRows.length) {
      return res.status(404).json({ error: "ไม่พบข้อมูล reward" });
    }

    let rewardData;
    try {
      rewardData = JSON.parse(rewardRows[0].reward_data);
    } catch (err) {
      return res.status(500).json({ error: "reward_data format invalid" });
    }

    const alreadyDrawn = rewardData.some(
      (r) => r.winning !== null && r.winning !== undefined && String(r.winning).trim() !== ""
    );

    if (alreadyDrawn) {
      return res.status(400).json({ error: "งวดนี้มีการออกรางวัลแล้ว ไม่สามารถสุ่มเพิ่มได้" });
    }

    // 3) ดึงเลขที่มีแล้วในงวดล่าสุด
    const [existing] = await db.query("SELECT number FROM lotto WHERE reward_id = ?", [reward_id]);
    const existingNumbers = new Set(existing.map((row) => row.number));

    // 4) วนสุ่มและ insert
    const inserted = [];
    while (inserted.length < randomCount) {
      const num = generateRandomNumber();
      if (!existingNumbers.has(num)) {
        await db.query(
          "INSERT INTO lotto (reward_id, number, price, status) VALUES (?, ?, ?, ?)",
          [reward_id, num, price, lotto_status]
        );
        existingNumbers.add(num);
        inserted.push(num);
      }
    }

    // 5) ส่งผลลัพธ์
    res.json({
      message: "✅ Random lotto inserted successfully",
      reward_id,
      total: inserted.length,
      numbers: inserted,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// สุ่มรางวัล
app.post("/reward/draw", async (req, res) => {
  const { id, statusType: rawStatusType } = req.body;

  if (!id) {
    return res.status(400).json({ error: "กรุณาระบุ id" });
  }

  try {
    // 0) ตรวจสอบ role ของ user
    const [users] = await db.query("SELECT role FROM users WHERE user_id = ?", [id]);
    if (users.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    if (String(users[0].role).toLowerCase() !== "admin") {
      return res.status(403).json({ error: "Only admin can draw reward" });
    }

    // กำหนด statusType
    let statusType = String(rawStatusType || "sold").toLowerCase();
    if (!["sold", "all", "purchased", "ซื้อแล้ว"].includes(statusType)) statusType = "sold";
    if (statusType === "purchased" || statusType === "ซื้อแล้ว") statusType = "sold";

    const LIMIT = 4;

    // 1) หางวดล่าสุด
    const [rows1] = await db.query("SELECT MAX(reward_id) AS rid FROM reward");
    const latestId = rows1?.[0]?.rid;
    if (!latestId) return res.status(404).json({ message: "ยังไม่มีงวดในตาราง reward" });

    // 2) โหลด reward_data
    const [rows2] = await db.query(
      "SELECT reward_id, CAST(reward_data AS CHAR) AS reward_data FROM reward WHERE reward_id = ?",
      [latestId]
    );
    if (!rows2?.length) return res.status(404).json({ message: "ไม่พบรายละเอียดงวดล่าสุด" });

    const raw = rows2[0].reward_data;
    let data;
    try {
      if (raw == null) data = [];
      else if (typeof raw === "string") data = JSON.parse(raw);
      else if (Buffer.isBuffer(raw)) data = JSON.parse(raw.toString());
      else if (typeof raw === "object") data = raw;
      else data = [];
    } catch (e) {
      return res.status(500).json({
        error: "reward_data ไม่ใช่ JSON ที่ถูกต้อง",
        detail: String(e.message),
        sample: String(raw).slice(0, 200),
      });
    }

    // 3) เช็คว่ามีการประกาศผลแล้วหรือยัง
    const conflicts = (Array.isArray(data) ? data : [])
      .filter((o) => o && typeof o === "object")
      .filter((o) => o.winning !== null && o.winning !== undefined && String(o.winning) !== "")
      .map((o) => ({ tier: o.tier ?? null, winning: o.winning }));

    if (conflicts.length > 0) {
      return res.status(409).json({
        message: "❌ สุ่มเลขและอัปเดตไม่สำเร็จ",
        reason: "พบ winning ที่ไม่ใช่ null ในงวดนี้ (มีการประกาศผลแล้วบางส่วน)",
        conflicts,
      });
    }

    // 4) สุ่มเลขที่ถูกซื้อแล้ว (หรือทั้งหมด ตาม mode)
    const qPick = `
      SELECT DISTINCT number
      FROM lotto
      ${statusType === "sold" ? "WHERE TRIM(status) IN ('ถูกซื้อแล้ว','sold')" : ""}
      ORDER BY RAND()
      LIMIT ?
    `;
    const [rows3] = await db.query(qPick, [LIMIT]);
    if (!rows3?.length) {
      return res.status(404).json({
        message: statusType === "sold" ? "ยังไม่มีเลขที่ถูกซื้อแล้วในตาราง lotto" : "ยังไม่มีเลขในตาราง lotto",
      });
    }

    const picked = rows3.map((r) => String(r.number));
    while (picked.length < 4) picked.push(picked[picked.length - 1] || picked[0]);

    const byTier = new Map();
    data.forEach((obj) => byTier.set(Number(obj?.tier), obj));

    const pick1 = picked[0] || null;
    const pick2 = picked[1] || picked[0] || null;
    const pick3 = picked[2] || picked[1] || picked[0] || null;
    const pick4 = picked[3] || picked[2] || picked[1] || picked[0] || null;

    // ✅ อัปเดตเลขรางวัล
    if (byTier.get(1)) byTier.get(1).winning = pick1;
    if (byTier.get(2)) byTier.get(2).winning = pick2;
    if (byTier.get(3)) byTier.get(3).winning = pick3;
    if (byTier.get(4)) byTier.get(4).winning = (pick1 || "").slice(-3).padStart(3, "0"); // เลขท้าย 3 ตัว มาจากรางวัลที่ 1
    if (byTier.get(5)) byTier.get(5).winning = (pick4 || "").slice(-2).padStart(2, "0"); // เลขท้าย 2 ตัว ใช้ pick4

    // 5) update reward_data
    const payload = JSON.stringify(data);
    await db.query("UPDATE reward SET reward_data = ? WHERE reward_id = ?", [payload, latestId]);

    res.json({
      message: "✅ สุ่มเลขและอัปเดตสำเร็จ",
      mode: statusType,
      reward_id: latestId,
      picked,
      reward_data: data
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
//==================================================================
//                       END ADMIN ROUTE
//==================================================================





//==================================================================
//                          USER ROUTE
//==================================================================


// select one user
app.get("/users/:id", async (req, res) => {
  const userId = req.params.id;
  try {
    const [results] = await db.query("SELECT * FROM users WHERE user_id = ?", [userId]);
    if (results.length === 0) return res.status(404).json({ message: "User not found" });
    res.json(results[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// user login
app.post("/users/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required" });
  }

  try {
    const [results] = await db.query("SELECT * FROM users WHERE email = ? AND password = ?", [email, password]);
    if (results.length === 0) {
      return res.status(401).json({ error: "Invalid email or password" });
    }
    const userData = { ...results[0] };
    delete userData.password;
    res.json({ message: "Login successful", user: userData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// register
app.post("/register", async (req, res) => {
  const { email, password, name, role, phone, birthday, wallet } = req.body;
  try {
    const [results] = await db.query(
      "INSERT INTO users (email, password, name, role, phone, birthday, wallet) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [email, password, name, role, phone, birthday, wallet]
    );
    res.json({ message: "✅ User created successfully", id: results.insertId });
  } catch (err) {
    res.status(500).json({ error: "Failed to create user" });
  }
});



// profile

app.get("/profile/:id", async (req, res) => {
  const userId = req.params.id;
  try {
    const [results] = await db.query("SELECT name, birthday, email, phone FROM users WHERE user_id = ?", [userId]);
    if (results.length === 0) return res.status(404).json({ message: "User not found" });
    res.json(results[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ฝากเงิน
app.post("/deposit/:id", async (req, res) => {
  const userId = req.params.id;
  const { amount } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: "จำนวนเงินฝากต้องมากกว่า 0" });
  }

  try {
    // อัปเดต wallet
    const [result] = await db.query(
      "UPDATE users SET wallet = wallet + ? WHERE user_id = ?",
      [amount, userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "ไม่พบผู้ใช้งาน" });
    }

    // ดึง wallet ล่าสุด
    const [rows] = await db.query("SELECT user_id, name, wallet FROM users WHERE user_id = ?", [userId]);

    res.json({
      message: "ฝากเงินสำเร็จ",
      user: rows[0],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



//ถอนเงิน
app.post("/withdraw/:id", async (req, res) => {
  const userId = req.params.id;
  const { amount } = req.body;

  if (!amount || amount <= 0) {
    return res.status(400).json({ error: "จำนวนเงินถอนต้องมากกว่า 0" });
  }

  try {
    // 1) ดึง wallet ปัจจุบัน
    const [users] = await db.query("SELECT wallet FROM users WHERE user_id = ?", [userId]);
    if (users.length === 0) {
      return res.status(404).json({ message: "ไม่พบผู้ใช้งาน" });
    }

    const currentWallet = parseFloat(users[0].wallet);
    if (currentWallet < amount) {
      return res.status(400).json({ error: "ยอดเงินไม่เพียงพอ" });
    }

    // 2) อัปเดต wallet
    const [result] = await db.query(
      "UPDATE users SET wallet = wallet - ? WHERE user_id = ?",
      [amount, userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: "ไม่สามารถถอนเงินได้" });
    }

    // 3) ดึง wallet ล่าสุด
    const [rows] = await db.query("SELECT user_id, name, wallet FROM users WHERE user_id = ?", [userId]);

    res.json({
      message: "ถอนเงินสำเร็จ",
      user: rows[0],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



//my order lotto
app.get("/mylotto/:id", async (req, res) => {
  const userId = req.params.id;

  try {
    const [rows] = await db.query(
      `
      SELECT 
        o.order_id,
        o.date,
        o.status AS order_status,
        l.lotto_id,
        l.number,
        l.price,
        l.status AS lotto_status,
        r.reward_id,
        r.date AS reward_date
      FROM orders o
      JOIN lotto l ON o.lotto_id = l.lotto_id
      JOIN reward r ON o.reward_id = r.reward_id
      WHERE o.user_id = ?
      ORDER BY o.date DESC
      `,
      [userId]
    );

    if (rows.length === 0) {
      return res.json({ message: "คุณยังไม่มีการซื้อลอตเตอรี่", orders: [] });
    }

    res.json({
      message: "ดึงข้อมูลลอตเตอรี่สำเร็จ",
      total: rows.length,
      orders: rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



//แสดง lotto ทั้งหมด ตอนจะซื้อ lotto
app.get("/lotto", async (req, res) => {
  try {
    // 1) หา reward_id ล่าสุด
    const [latest] = await db.query("SELECT MAX(reward_id) AS rid FROM reward");
    const latestRewardId = latest[0]?.rid;

    if (!latestRewardId) {
      return res.status(404).json({ message: "ยังไม่มีงวดในระบบ" });
    }

    // 2) ดึงเฉพาะที่ยังไม่ถูกซื้อในงวดล่าสุด
    const [results] = await db.query(
      "SELECT * FROM lotto WHERE reward_id = ?",
      [latestRewardId]
    );

    res.json({
      message: "ดึงลอตเตอรี่สำเร็จ",
      reward_id: latestRewardId,
      total: results.length,
      lotto: results,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



//search lotto
app.post("/search/lotto", async (req, res) => {
  const { number } = req.body;

  if (!number || number.trim() === "") {
    return res.status(400).json({ error: "กรุณาระบุเลขที่ต้องการค้นหา" });
  }

  try {
    // 1) หางวดล่าสุด
    const [latest] = await db.query("SELECT MAX(reward_id) AS rid FROM reward");
    const latestRewardId = latest[0]?.rid;
    if (!latestRewardId) {
      return res.status(404).json({ message: "ยังไม่มีงวดในระบบ" });
    }

    // 2) ค้นหาเลขในงวดล่าสุด + เฉพาะที่ยังไม่ถูกซื้อ
    const searchPattern = `%${number}%`;
    const [rows] = await db.query(
      `
      SELECT 
        l.lotto_id,
        l.number,
        l.price,
        l.status,
        r.reward_id,
        r.date AS reward_date
      FROM lotto l
      JOIN reward r ON l.reward_id = r.reward_id
      WHERE l.reward_id = ? 
        AND l.status = 'ยังไม่ถูกซื้อ'
        AND l.number LIKE ?
      ORDER BY l.number ASC
      `,
      [latestRewardId, searchPattern]
    );

    if (rows.length === 0) {
      return res.json({ message: "ไม่พบหมายเลขลอตเตอรี่ที่ค้นหา", results: [] });
    }

    res.json({
      message: "พบลอตเตอรี่",
      total: rows.length,
      results: rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// RANDOM ONE LOTTO
app.get("/lotto/randomOne", async (req, res) => {
  try {
    // 1) หางวดล่าสุด
    const [latest] = await db.query("SELECT MAX(reward_id) AS rid FROM reward");
    const latestRewardId = latest[0]?.rid;
    if (!latestRewardId) {
      return res.status(404).json({ message: "ยังไม่มีงวดในระบบ" });
    }

    // 2) สุ่มเลขที่ยังไม่ถูกซื้อในงวดนั้น
    const [rows] = await db.query(
      `
      SELECT lotto_id, number, price, status, reward_id
      FROM lotto
      WHERE reward_id = ? AND status = 'ยังไม่ถูกซื้อ'
      ORDER BY RAND()
      LIMIT 1
      `,
      [latestRewardId]
    );

    if (rows.length === 0) {
      return res.status(404).json({ message: "งวดนี้ไม่มีลอตเตอรี่ที่เหลืออยู่แล้ว" });
    }

    res.json({
      message: "สุ่มลอตเตอรี่สำเร็จ",
      lotto: rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// ซื้อ lotto
app.post("/orders", async (req, res) => {
  const { user_id, lotto_id } = req.body;

  if (!user_id || !lotto_id) {
    return res.status(400).json({ error: "กรุณาระบุ user_id และ lotto_id" });
  }

  try {
    // 0) ตรวจสอบ role ของ user
    const [users] = await db.query("SELECT role FROM users WHERE user_id = ?", [user_id]);
    if (users.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    if (String(users[0].role).toLowerCase() !== "user") {
      return res.status(403).json({ error: "Only user can buy lotto" });
    }

    // 1) หางวดล่าสุด
    const [latest] = await db.query("SELECT MAX(reward_id) AS rid FROM reward");
    const reward_id = latest[0]?.rid;
    if (!reward_id) {
      return res.status(400).json({ error: "No reward found (ยังไม่มีงวด)" });
    }

    // 2) ตรวจสอบว่า reward งวดล่าสุดได้ออกรางวัลแล้วหรือยัง
    const [rewardRows] = await db.query(
      "SELECT CAST(reward_data AS CHAR) AS reward_data FROM reward WHERE reward_id = ?",
      [reward_id]
    );
    if (!rewardRows.length) {
      return res.status(404).json({ error: "ไม่พบข้อมูล reward" });
    }

    let rewardData = [];
    try {
      rewardData = JSON.parse(rewardRows[0].reward_data);
    } catch (err) {
      return res.status(500).json({ error: "reward_data format is invalid" });
    }

    // ถ้าใน reward_data มี winning ที่ไม่เป็น null หรือว่าง แสดงว่าออกรางวัลแล้ว
    const alreadyDrawn = rewardData.some(
      (r) => r.winning !== null && r.winning !== undefined && String(r.winning).trim() !== ""
    );
    if (alreadyDrawn) {
      return res.status(400).json({ error: "งวดนี้ได้ออกรางวัลแล้ว ไม่สามารถซื้อได้" });
    }

    // 3) ตรวจสอบว่า lotto_id นี้อยู่ในงวดล่าสุด และยังไม่ถูกซื้อ
    const [lotto] = await db.query(
      "SELECT * FROM lotto WHERE lotto_id = ? AND reward_id = ? AND status = 'ยังไม่ถูกซื้อ'",
      [lotto_id, reward_id]
    );
    if (lotto.length === 0) {
      return res.status(400).json({ error: "Lotto not available (งวดนี้ไม่มี หรือถูกซื้อแล้ว)" });
    }

    // 4) update lotto เป็นถูกซื้อแล้ว
    await db.query("UPDATE lotto SET status = 'ถูกซื้อแล้ว' WHERE lotto_id = ?", [lotto_id]);

    // 5) insert ลง orders
    const [result] = await db.query(
      "INSERT INTO orders (lotto_id, user_id, reward_id, date, status) VALUES (?, ?, ?, CURDATE(), ?)",
      [lotto_id, user_id, reward_id, "ยังไม่ขึ้นรางวัล"]
    );

    res.json({
      message: "ซื้อ Lotto สำเร็จ",
      order_id: result.insertId,
      data: {
        lotto_id,
        reward_id,
        user_id,
        status: "ซื้อสำเร็จ (เปลี่ยนเป็น ถูกซื้อแล้ว)"
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// user chack reward
app.get("/orders/check/:order_id", async (req, res) => {
  const { order_id } = req.params;

  try {
    // 1) หา order + lotto
    const [orders] = await db.query(
      `SELECT o.order_id, o.user_id, o.lotto_id, l.number, l.reward_id
       FROM orders o
       JOIN lotto l ON o.lotto_id = l.lotto_id
       WHERE o.order_id = ?`,
      [order_id]
    );
    if (!orders.length) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = orders[0];
    const lottoNumber = String(order.number);
    const reward_id = order.reward_id;

    // 2) ดึง reward_data ของงวดนี้
    const [rewardRows] = await db.query(
      "SELECT CAST(reward_data AS CHAR) AS reward_data FROM reward WHERE reward_id = ?",
      [reward_id]
    );
    if (!rewardRows.length) {
      return res.status(404).json({ error: "Reward not found" });
    }

    let rewardData = [];
    try {
      rewardData = JSON.parse(rewardRows[0].reward_data);
    } catch (err) {
      return res.status(500).json({ error: "reward_data format invalid" });
    }

    // 3) ถ้ายังไม่ออกรางวัล (winning ยัง null) → หยุด
    const isDrawn = rewardData.some(
      (r) => r.winning !== null && r.winning !== undefined && String(r.winning).trim() !== ""
    );
    if (!isDrawn) {
      return res.json({ message: "⏳ ยังไม่ออกรางวัล", order_id });
    }

    // 4) ตรวจว่าถูกรางวัลหรือไม่
    let result = { win: false, tier: null, prize: 0 };

    for (const r of rewardData) {
      if (!r.winning) continue;
      const winNum = String(r.winning);

      if (r.tier === 1 || r.tier === 2 || r.tier === 3) {
        // ต้องตรงทั้ง 6 หลัก
        if (lottoNumber === winNum) {
          result = { win: true, tier: r.tier, prize: r.amount };
          break;
        }
      } else if (r.tier === 4) {
        // เลขท้าย 3 ตัว
        if (lottoNumber.slice(-3) === winNum) {
          result = { win: true, tier: r.tier, prize: r.amount };
          break;
        }
      } else if (r.tier === 5) {
        // เลขท้าย 2 ตัว
        if (lottoNumber.slice(-2) === winNum) {
          result = { win: true, tier: r.tier, prize: r.amount };
          break;
        }
      }
    }

    // 5) ส่งผลลัพธ์กลับ
    if (result.win) {
      res.json({
        message: "ยินดีด้วย! คุณถูกรางวัล",
        order_id,
        lottoNumber,
        tier: result.tier,
        prize: result.prize
      });
    } else {
      res.json({
        message: "เสียใจด้วย คุณไม่ถูกรางวัล",
        order_id,
        lottoNumber
      });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



//ขึ้นรางวัล
app.post("/orders/redeem", async (req, res) => {
  const { order_id } = req.body;

  try {
    // 1) หา order + lotto
    const [orders] = await db.query(
      `SELECT o.order_id, o.user_id, o.lotto_id, o.status, l.number, l.reward_id, u.wallet
       FROM orders o
       JOIN lotto l ON o.lotto_id = l.lotto_id
       JOIN users u ON o.user_id = u.user_id
       WHERE o.order_id = ?`,
      [order_id]
    );
    if (!orders.length) {
      return res.status(404).json({ error: "Order not found" });
    }

    const order = orders[0];
    const lottoNumber = String(order.number);
    const reward_id = order.reward_id;

    // ป้องกันกดซ้ำ
    if (order.status === "รับรางวัลแล้ว") {
      return res.status(400).json({ error: "คุณได้ขึ้นรางวัลไปแล้ว" });
    }

    // 2) ดึง reward_data ของงวดนี้
    const [rewardRows] = await db.query(
      "SELECT CAST(reward_data AS CHAR) AS reward_data FROM reward WHERE reward_id = ?",
      [reward_id]
    );
    if (!rewardRows.length) {
      return res.status(404).json({ error: "Reward not found" });
    }

    let rewardData = [];
    try {
      rewardData = JSON.parse(rewardRows[0].reward_data);
    } catch (err) {
      return res.status(500).json({ error: "reward_data format invalid" });
    }

    // 3) ตรวจว่าถูกรางวัลหรือไม่
    let prize = 0;
    let tier = null;

    for (const r of rewardData) {
      if (!r.winning) continue;
      const winNum = String(r.winning);

      if ([1, 2, 3].includes(r.tier)) {
        if (lottoNumber === winNum) {
          prize = r.amount;
          tier = r.tier;
          break;
        }
      } else if (r.tier === 4) {
        if (lottoNumber.slice(-3) === winNum) {
          prize = r.amount;
          tier = r.tier;
          break;
        }
      } else if (r.tier === 5) {
        if (lottoNumber.slice(-2) === winNum) {
          prize = r.amount;
          tier = r.tier;
          break;
        }
      }
    }

    if (prize <= 0) {
      return res.status(400).json({ error: "คุณไม่ถูกรางวัล" });
    }

    // 4) update wallet
    const newWallet = parseFloat(order.wallet) + prize;
    await db.query("UPDATE users SET wallet = ? WHERE user_id = ?", [newWallet, order.user_id]);

    // 5) update order เป็น "รับรางวัลแล้ว"
    await db.query("UPDATE orders SET status = 'รับรางวัลแล้ว' WHERE order_id = ?", [order_id]);

    res.json({
      message: "🎉 รับรางวัลสำเร็จ",
      order_id,
      lottoNumber,
      tier,
      prize,
      newWallet
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



//ขึ้นงวดใหม่ (admin เท่านั้น)
app.post("/reward/reset", async (req, res) => {
  const { id } = req.body;

  if (!id) {
    return res.status(400).json({ error: "กรุณาระบุ user id" });
  }

  let conn;
  try {
    // 0) ตรวจสอบ role ของผู้เรียก
    const [users] = await db.query(
      "SELECT role FROM users WHERE user_id = ?",
      [id]
    );
    if (!users.length) {
      return res.status(404).json({ error: "ไม่เจอผู้ใช้" });
    }
    if (String(users[0].role).toLowerCase() !== "admin") {
      return res.status(403).json({ error: "แอดมินเท่านั้นที่จะสร้างงวดใหม่ได้" });
    }

    // ใช้ทรานแซกชัน
    conn = await db.getConnection();
    await conn.beginTransaction();

    // 1) ลบข้อมูลทั้งหมดใน orders
    const [delOrders] = await conn.query("DELETE FROM orders");

    // 2) ลบข้อมูลทั้งหมดใน lotto
    const [delLotto] = await conn.query("DELETE FROM lotto");

    // 3) ลบ users ที่ role = 'user' ให้เหลือเฉพาะ admin
    const [delUsers] = await conn.query(
      "DELETE FROM users WHERE LOWER(role) = 'user'"
    );

    // 4) template reward_data
    const template = [
      { name: "รางวัลที่ 1", tier: 1, amount: 6000000, winning: null },
      { name: "รางวัลที่ 2", tier: 2, amount: 200000, winning: null },
      { name: "รางวัลที่ 3", tier: 3, amount: 80000, winning: null },
      { name: "เลขท้าย 3 ตัว", tier: 4, amount: 4000, winning: null },
      { name: "เลขท้าย 2 ตัว", tier: 5, amount: 2000, winning: null }
    ];

    // 5) วันที่วันนี้ (ฟอร์แมต YYYY-MM-DD)
    let newDate = new Date();
    newDate.setHours(0, 0, 0, 0);
    let dateStr = newDate.toISOString().split("T")[0];

    // 6) กัน date ซ้ำ
    let isDuplicate = true;
    while (isDuplicate) {
      const [check] = await conn.query("SELECT 1 FROM reward WHERE date = ?", [dateStr]);
      if (check.length > 0) {
        newDate.setDate(newDate.getDate() + 1);
        dateStr = newDate.toISOString().split("T")[0];
      } else {
        isDuplicate = false;
      }
    }

    // 7) insert งวดใหม่
    const [result] = await conn.query(
      "INSERT INTO reward (reward_data, date) VALUES (?, ?)",
      [JSON.stringify(template), dateStr]
    );

    await conn.commit();

    res.json({
      message: "งวดใหม่ถูกสร้างเรียบร้อยแล้ว (ล้าง orders, lotto และลบ users ที่ role = 'user')",
      new_reward_id: result.insertId,
      date: dateStr,
      reward_data: template,
      deleted: {
        orders: delOrders.affectedRows || 0,
        lotto: delLotto.affectedRows || 0,
        users_role_user: delUsers.affectedRows || 0
      }
    });
  } catch (err) {
    if (conn) {
      try { await conn.rollback(); } catch {}
    }
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) conn.release();
  }
});






//==================================================================
//                          START SERVER
//==================================================================
// Start
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Server listening on port ${PORT}`);
});

// Global handlers
process.on("unhandledRejection", (r) => console.error("Unhandled Rejection:", r));
process.on("uncaughtException", (e) => { console.error("Uncaught Exception:", e); process.exit(1); });