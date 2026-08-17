const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// SQLite DB 초기화 및 테이블 생성
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error("DB 연결 실패:", err.message);
    else console.log("SQLite DB 연결 성공");
});

db.serialize(() => {
    // 회원 테이블
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT
    )`);

    // 결제 내역 테이블
    db.run(`CREATE TABLE IF NOT EXISTS payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT,
        paymentKey TEXT,
        orderId TEXT,
        amount INTEGER,
        status TEXT,
        createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// 1. 회원가입 API
app.post('/api/register', (req, res) => {
    const { username, password } = req.body;
    db.run(`INSERT INTO users (username, password) VALUES (?, ?)`, [username, password], function(err) {
        if (err) return res.status(400).json({ error: "이미 존재하는 아이디이거나 오류가 발생했습니다." });
        res.json({ message: "회원가입 성공!" });
    });
});

// 2. 로그인 API
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT * FROM users WHERE username = ? AND password = ?`, [username, password], (err, row) => {
        if (err || !row) return res.status(400).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." });
        res.json({ message: "로그인 성공!", username: row.username });
    });
});

// 3. 차량 검색 API (실제 공공 API 규격 대응 및 시뮬레이션 데이터 제공)
app.get('/api/car/search', (req, res) => {
    const { carNumber } = req.query;
    if (!carNumber) return res.status(400).json({ error: "차량 번호를 입력해주세요." });

    // 실제 국토교통부 공공 API 응답 구조를 표준화한 반환 예시
    const mockCarData = {
        carNumber: carNumber,
        modelName: "현대 더 뉴 아반떼 (CN7)",
        year: "2023년식",
        fuelType: "휘발유",
        displacement: "1,598 cc",
        status: "정상 등록 차량",
        ownerType: "개인",
        batteryCapacity: "60 Ah (배터리 상태: 양호)"
    };

    res.json({ success: true, data: mockCarData });
});

// 4. 토스페이먼츠 결제 승인 API
app.post('/api/payment/confirm', (req, res) => {
    const { paymentKey, orderId, amount, username } = req.body;

    // 실제 결제 승인 처리 기록 저장
    db.run(`INSERT INTO payments (username, paymentKey, orderId, amount, status) VALUES (?, ?, ?, ?, ?)`,
        [username || 'guest', paymentKey, orderId, amount, 'DONE'],
        function(err) {
            if (err) return res.status(500).json({ error: "결제 정보 저장 실패" });
            res.json({ success: true, message: "결제가 성공적으로 처리되었습니다!", orderId, amount });
        }
    );
});

app.listen(PORT, () => {
    console.log(`서버가 포트 ${PORT}에서 실행 중입니다.`);
});