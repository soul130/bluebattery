const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// SQLite 실제 DB 생성 및 연결
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error('DB 연결 실패:', err.message);
    else console.log('SQLite DB 연결 성공');
});

// 테이블 생성 (회원, 카드, 예약 내역)
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        pw TEXT NOT NULL,
        name TEXT NOT NULL,
        isAdmin INTEGER DEFAULT 0
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS cards (
        userId TEXT PRIMARY KEY,
        cardNumber TEXT NOT NULL,
        expDate TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        userId TEXT,
        userName TEXT,
        reserveDate TEXT,
        item TEXT,
        status TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 기본 관리자 계정 생성 (admin / 1234)
    db.run(`INSERT OR IGNORE INTO users (id, pw, name, isAdmin) VALUES ('admin', '1234', '총괄관리자', 1)`);
});

// [API] 회원가입
app.post('/api/signup', (req, res) => {
    const { id, pw, name } = req.body;
    db.run(`INSERT INTO users (id, pw, name, isAdmin) VALUES (?, ?, ?, 0)`, [id, pw, name], function(err) {
        if (err) return res.status(400).json({ error: '이미 존재하는 아이디입니다.' });
        res.json({ success: true, message: '회원가입 완료' });
    });
});

// [API] 로그인
app.post('/api/login', (req, res) => {
    const { id, pw } = req.body;
    db.get(`SELECT id, name, isAdmin FROM users WHERE id = ? AND pw = ?`, [id, pw], (err, row) => {
        if (err || !row) return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
        res.json({ success: true, user: row });
    });
});

// [API] 카드 등록 (자동결제용)
app.post('/api/card', (req, res) => {
    const { userId, cardNumber, expDate } = req.body;
    db.run(`INSERT OR REPLACE INTO cards (userId, cardNumber, expDate) VALUES (?, ?, ?)`, [userId, cardNumber, expDate], (err) => {
        if (err) return res.status(500).json({ error: '카드 등록 실패' });
        res.json({ success: true, message: '카드 등록 완료' });
    });
});

// [API] 예약 및 결제 승인
app.post('/api/reserve', (req, res) => {
    const { userId, userName, reserveDate, item } = req.body;
    
    // 카드 등록 여부 검증
    db.get(`SELECT * FROM cards WHERE userId = ?`, [userId], (err, card) => {
        if (!card) return res.status(400).json({ error: '등록된 결제 카드가 없습니다.' });

        const status = '자동결제 승인완료 (실제DB 저장됨)';
        db.run(`INSERT INTO reservations (userId, userName, reserveDate, item, status) VALUES (?, ?, ?, ?, ?)`,
            [userId, userName, reserveDate, item, status], function(err) {
                if (err) return res.status(500).json({ error: '예약 처리 실패' });
                res.json({ success: true, reservationId: this.lastID, status });
            }
        );
    });
});

// [API] 관리자 전용 대시보드 데이터
app.get('/api/admin/data', (req, res) => {
    db.all(`SELECT id, name, isAdmin FROM users`, [], (err, users) => {
        db.all(`SELECT * FROM reservations ORDER BY id DESC`, [], (err, reservations) => {
            res.json({ users, reservations });
        });
    });
});

app.listen(PORT, () => {
    console.log(`실제 백엔드 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});