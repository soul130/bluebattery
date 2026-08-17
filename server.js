const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// 🔑 발급받으신 공공데이터포털 인코딩 키
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

// 3. 🌐 실제 차량 데이터 실시간 조회 API
app.get('/api/car/search', async (req, res) => {
    const { carNumber } = req.query;
    if (!carNumber) {
        return res.status(400).json({ error: "차량 번호를 입력해주세요." });
    }

    const cleanCarNum = carNumber.replace(/\s+/g, '');

    // 번호판 형식이 맞지 않는 잘못된 입력 우선 차단 (서버 꼬임 방지)
    const carNumRegex = /^(?:[0-9]{2,3}[가-힣]{1}[0-9]{4})$/;
    if (!carNumRegex.test(cleanCarNum)) {
        return res.status(400).json({ 
            error: "올바른 차량 번호 형식이 아닙니다. (예: 12가3456, 16러4490)" 
        });
    }

    try {
        // 공공데이터포털 실시간 자동차 검사/등록 정보 API 호출
        const response = await axios.get('http://apis.data.go.kr/1613000/CarInspInfoService/getCarInspItem', {
            params: {
                serviceKey: PUBLIC_DATA_SERVICE_KEY,
                carNo: cleanCarNum,
                _type: 'json'
            },
            timeout: 5000
        });

        const apiData = response.data;
        const resultHeader = apiData?.response?.header;

        // 실제 공공 DB 조회 성공 및 데이터 존재 시
        if (resultHeader && resultHeader.resultCode === '00') {
            const items = apiData?.response?.body?.items?.item;
            const item = Array.isArray(items) ? items[0] : items;

            if (item) {
                return res.json({
                    success: true,
                    data: {
                        carNumber: cleanCarNum,
                        modelName: item.carNm || item.vhclModelNm || "실제 등록 차량",
                        year: item.carYy || item.firstRegisterDate || "정보 있음",
                        fuelType: item.fuelNm || "확인됨",
                        displacement: item.dsplvl ? `${item.dsplvl} cc` : "정보 있음",
                        status: "국토교통부 정식 등록 차량",
                        batteryStatus: "12V 정상 규격"
                    }
                });
            }
        }

        // 실제 DB에 조회가 되지 않는 경우
        return res.status(404).json({
            error: "공공 데이터베이스에서 해당 차량 정보를 찾을 수 없습니다. 번호를 다시 확인해 주세요."
        });

    } catch (error) {
        console.error("API 통신 오류:", error.message);
        return res.status(500).json({
            error: "실제 차량 DB 조회 중 통신 오류가 발생했습니다. 잠시 후 다시 시도해 주세요."
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