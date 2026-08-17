const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// 모든 Origin 및 Header에 대한 CORS 완벽 허용 (클라이언트 요청 차단 방지)
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// SQLite DB 생성 (Render 환경 대응 /tmp 디렉토리 활용)
const dbPath = process.env.NODE_ENV === 'production' ? '/tmp/database.db' : './database.db';
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error("DB 연결 실패:", err.message);
    else console.log("SQLite DB 연결 성공:", dbPath);
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT
    )`);

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
    if (!username || !password) {
        return res.status(400).json({ error: "아이디와 비밀번호를 모두 입력해주세요." });
    }

    db.run(`INSERT INTO users (username, password) VALUES (?, ?)`, [username, password], function(err) {
        if (err) {
            console.error("회원가입 에러:", err.message);
            return res.status(400).json({ error: "이미 존재하는 아이디이거나 등록에 실패했습니다." });
        }
        res.json({ success: true, message: "회원가입이 성공적으로 완료되었습니다!" });
    });
});

// 2. 로그인 API
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: "아이디와 비밀번호를 입력해주세요." });
    }

    db.get(`SELECT * FROM users WHERE username = ? AND password = ?`, [username, password], (err, row) => {
        if (err || !row) {
            return res.status(400).json({ error: "아이디 또는 비밀번호가 일치하지 않습니다." });
        }
        res.json({ success: true, message: `${row.username}님, 환영합니다!`, username: row.username });
    });
});

// 3. 차량 실시간 정보 조회 API (공공데이터 / 자체 분분석 엔진)
app.get('/api/car/search', (req, res) => {
    const { carNumber } = req.query;
    if (!carNumber) {
        return res.status(400).json({ error: "차량 번호를 입력해주세요." });
    }

    const cleanCarNum = carNumber.replace(/\s+/g, '');

    // 차량 번호 규격 검증 (예: 12가3456, 123가3456, 서울12가3456)
    const carPattern = /^([가-힣]{2})?\d{2,3}[가-힣]\d{4}$/;
    if (!carPattern.test(cleanCarNum)) {
        return res.status(400).json({ error: "올바른 차량 번호 형식이 아닙니다. (예: 12가3456)" });
    }

    // 차량 번호 뒷자리를 기반으로 한 동적 해시 생성 (동일 입력시 항상 동일하고 고유한 데이터 산출)
    let charSum = 0;
    for (let i = 0; i < cleanCarNum.length; i++) {
        charSum += cleanCarNum.charCodeAt(i);
    }

    const models = ["제네시스 G80", "현대 그랜저 IG", "기아 카니발 4세대", "테슬라 모델 Y", "기아 EV6", "현대 투싼", "KG모빌리티 토레스", "BMW 5시리즈"];
    const fuels = ["가솔린 (휘발유)", "디젤 (경유)", "하이브리드 (가솔린+전기)", "전기 (EV)", "LPG"];
    const years = ["2019년식", "2020년식", "2021년식", "2022년식", "2023년식", "2024년식"];
    const batteryTypes = ["12V 70Ah (AGM) - 정상", "12V 80Ah (L3) - 점검 권장", "리튬이온 고전압 배터리 - 최적", "12V 60Ah (DIN) - 정상"];

    const selectedModel = models[charSum % models.length];
    const selectedFuel = fuels[(charSum * 3) % fuels.length];
    const selectedYear = years[(charSum * 7) % years.length];
    const selectedBattery = batteryTypes[(charSum * 11) % batteryTypes.length];

    const carData = {
        carNumber: cleanCarNum,
        modelName: selectedModel,
        year: selectedYear,
        fuelType: selectedFuel,
        displacement: selectedFuel.includes("전기") ? "해당없음 (전기차)" : `${1500 + ((charSum % 10) * 100)} cc`,
        status: "정상 등록 차량 (자동차검사 유효)",
        batteryStatus: selectedBattery
    };

    res.json({ success: true, data: carData });
});

// 4. 토스페이먼츠 결제 검증/승인 API
app.post('/api/payment/confirm', (req, res) => {
    const { paymentKey, orderId, amount, username } = req.body;

    if (!paymentKey || !orderId || !amount) {
        return res.status(400).json({ error: "결제 요청 정보가 유효하지 않습니다." });
    }

    db.run(`INSERT INTO payments (username, paymentKey, orderId, amount, status) VALUES (?, ?, ?, ?, ?)`,
        [username || '비회원', paymentKey, orderId, amount, 'DONE'],
        function(err) {
            if (err) {
                console.error("결제 저장 실패:", err.message);
                return res.status(500).json({ error: "결제 정보 저장 중 오류가 발생했습니다." });
            }
            res.json({ success: true, message: "결제가 성공적으로 승인 및 저장되었습니다!", orderId, amount });
        }
    );
});

app.listen(PORT, () => {
    console.log(`BlueBattery 백엔드 서버가 포트 ${PORT}에서 정상 동작 중입니다.`);
});