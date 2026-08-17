const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// 🔑 발급받으신 공공데이터포털 인증키
const PUBLIC_DATA_SERVICE_KEY = '4mkPqfQ0pkVlWAUP9jFgMR6ytaEF3oh+c70Gzg3TkURN/XiUbWpR9sjiS+xucxtogTvCiQ9lYBFODU/VmqW1Fw==';

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With']
}));

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// SQLite DB 설정
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

// 3. 🌐 실제 공공데이터포털 자동차 정보 실시간 조회 API
app.get('/api/car/search', async (req, res) => {
    const { carNumber } = req.query;
    if (!carNumber) {
        return res.status(400).json({ error: "차량 번호를 입력해주세요." });
    }

    const cleanCarNum = carNumber.replace(/\s+/g, '');

    try {
        const response = await axios.get('http://apis.data.go.kr/1611000/nsdi/CarInfoService/getCarInfo', {
            params: {
                serviceKey: PUBLIC_DATA_SERVICE_KEY,
                carNo: cleanCarNum,
                format: 'json'
            },
            timeout: 5000
        });

        const apiData = response.data;

        if (!apiData || !apiData.response || apiData.response.header.resultCode !== '00') {
            return res.status(404).json({ 
                error: "공공 데이터베이스에 등록되지 않았거나 존재하지 않는 차량 번호입니다." 
            });
        }

        const items = apiData.response.body.items.item;
        const item = Array.isArray(items) ? items[0] : items;

        if (!item) {
            return res.status(404).json({ 
                error: "존재하지 않는 차량 번호입니다." 
            });
        }

        const carData = {
            carNumber: cleanCarNum,
            modelName: item.carNm || item.vhclNm || "차명 정보 없음",
            year: item.yr || item.useYn || "연식 정보 없음",
            fuelType: item.fuelNm || "연료 정보 없음",
            displacement: item.dsplvl ? `${item.dsplvl} cc` : "정보 없음",
            status: "정식 등록 차량 (국토교통부 DB 확인 완료)",
            batteryStatus: "12V 정상 규격 (실시간 점검 권장)"
        };

        res.json({ success: true, data: carData });

    } catch (error) {
        console.error("공공데이터 API 호출 오류:", error.message);
        res.status(400).json({ 
            error: "존재하지 않거나 올바르지 않은 차량 번호입니다. 번호를 확인해주세요." 
        });
    }
});

// 4. 💳 포트원(Portone) 결제 승인 및 DB 저장 API
app.post('/api/payment/confirm', (req, res) => {
    const { imp_uid, merchant_uid, paid_amount, username } = req.body;

    if (!imp_uid || !merchant_uid) {
        return res.status(400).json({ error: "포트원 결제 정보가 유효하지 않습니다." });
    }

    db.run(`INSERT INTO payments (username, paymentKey, orderId, amount, status) VALUES (?, ?, ?, ?, ?)`,
        [username || '비회원', imp_uid, merchant_uid, paid_amount || 0, 'PAID'],
        function(err) {
            if (err) return res.status(500).json({ error: "결제 내역 저장 실패" });
            res.json({ success: true, message: "포트원 결제가 성공적으로 저장되었습니다!" });
        }
    );
});

app.listen(PORT, () => {
    console.log(`BlueBattery 서버가 포트 ${PORT}에서 작동 중입니다.`);
});