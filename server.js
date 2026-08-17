const express = require('express');
const cors = require('cors');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'BLUE_BATTERY_SECRET_KEY_2026';

app.use(cors({ origin: '*' }));
app.use(express.json());

// -------------------------------------------------------------
// 1. SQLite DB 안전 초기화 (테이블 자동 생성 및 기본 관리자 등록)
// -------------------------------------------------------------
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) console.error("DB 연결 실패:", err);
    else console.log("SQLite DB 연결 성공");
});

db.serialize(() => {
    // 회원 테이블
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE,
        password TEXT,
        name TEXT,
        phone TEXT,
        role TEXT DEFAULT 'user',
        billing_key TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 예약 내역 테이블
    db.run(`CREATE TABLE IF NOT EXISTS reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_email TEXT,
        payment_id TEXT,
        car_no TEXT,
        battery_name TEXT,
        phone TEXT,
        reserve_date TEXT,
        address TEXT,
        status TEXT DEFAULT '접수완료',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 최고관리자 계정 기본 생성 (admin@blue.com / admin123)
    db.run(`INSERT OR IGNORE INTO users (email, password, name, phone, role) 
            VALUES ('admin@blue.com', 'admin123', '최고관리자', '01000000000', 'admin')`);
});

// CODEF API 설정
const CODEF_CONFIG = {
    client_id: 'ef27cfaa-10c1-4470-adac-60ba476273f9',
    client_secret: '83160c33-9045-4915-86d8-809473cdf5c3',
    baseUrl: 'https://development.codef.io'
};

async function getAccessToken() {
    const authHeader = Buffer.from(`${CODEF_CONFIG.client_id}:${CODEF_CONFIG.client_secret}`).toString('base64');
    const response = await axios.post('https://oauth.codef.io/oauth/token', 'grant_type=client_credentials&scope=read', {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${authHeader}` }
    });
    return response.data.access_token;
}

const BATTERY_DATABASE = [
    { keywords: ['아반떼', 'AVANTE'], fuel: '가솔린', modelName: '로케트 DIN 60L / Delkor 56219', price: 95000 },
    { keywords: ['아반떼', 'AVANTE'], fuel: '디젤', modelName: '로케트 AGM 70L', price: 125000 },
    { keywords: ['쏘나타', 'SONATA', 'K5'], fuel: '가솔린', modelName: '로케트 AGM 80L / Delkor AGM 80', price: 135000 },
    { keywords: ['그랜저', 'GRANDEUR', 'K7', 'K8'], fuel: '가솔린', modelName: '로케트 AGM 80L', price: 135000 },
    { keywords: ['카니발', 'CARNIVAL', '팰리세이드'], fuel: '디젤', modelName: '로케트 AGM 95L / Delkor AGM 95', price: 155000 },
    { keywords: ['산타페', 'SANTAFE', '쏘렌토', 'SORENTO'], fuel: '디젤', modelName: '로케트 AGM 90L', price: 145000 },
    { keywords: ['모닝', 'MORNING', '레이', 'RAY'], fuel: '가솔린', modelName: '로케트 40AL / Delkor 40AL', price: 65000 }
];

// -------------------------------------------------------------
// 2. 인증 (회원가입 / 로그인) API
// -------------------------------------------------------------
app.post('/api/register', (req, res) => {
    const { email, password, name, phone } = req.body;
    
    if (!email || !password || !name || !phone) {
        return res.status(400).json({ message: '모든 입력 항목을 채워주세요.' });
    }

    const query = `INSERT INTO users (email, password, name, phone, role) VALUES (?, ?, ?, ?, 'user')`;
    
    db.run(query, [email, password, name, phone], function(err) {
        if (err) {
            console.error("회원가입 DB 오류:", err.message);
            if (err.message.includes('UNIQUE')) {
                return res.status(400).json({ message: '이미 가입된 이메일 주소입니다.' });
            }
            return res.status(500).json({ message: '회원가입 중 서버 오류가 발생했습니다.' });
        }
        
        const token = jwt.sign({ email, name, role: 'user' }, JWT_SECRET, { expiresIn: '365d' });
        res.json({ 
            message: '회원가입 성공', 
            token, 
            user: { email, name, phone, role: 'user', hasCard: false } 
        });
    });
});

app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    db.get(`SELECT * FROM users WHERE email = ? AND password = ?`, [email, password], (err, row) => {
        if (err || !row) return res.status(401).json({ message: '이메일 또는 비밀번호가 일치하지 않습니다.' });
        const token = jwt.sign({ email: row.email, name: row.name, role: row.role }, JWT_SECRET, { expiresIn: '365d' });
        res.json({ 
            token, 
            user: { email: row.email, name: row.name, phone: row.phone, role: row.role || 'user', hasCard: !!row.billing_key } 
        });
    });
});

// -------------------------------------------------------------
// 3. 카드 등록 및 조회 API
// -------------------------------------------------------------
app.post('/api/save-card', (req, res) => {
    const { email, billingKey } = req.body;
    db.run(`UPDATE users SET billing_key = ? WHERE email = ?`, [billingKey, email], function(err) {
        if (err) return res.status(500).json({ message: '카드 등록 실패' });
        res.json({ message: '자동결제 카드가 성공적으로 등록되었습니다.' });
    });
});

// -------------------------------------------------------------
// 4. 차량 실시간 조회 API
// -------------------------------------------------------------
app.post('/api/car-search', async (req, res) => {
    try {
        const { carNo, ownerName } = req.body;
        if (!carNo || !ownerName) return res.status(400).json({ message: '차량번호와 소유자명을 입력해주세요.' });

        const accessToken = await getAccessToken();
        const codefRes = await axios.post(`${CODEF_CONFIG.baseUrl}/v1/kr/public/lt/car-registration-issuance-second/issue`, {
            organization: '0020',
            resUserIdentifiNo: ownerName,
            resCarNo: carNo
        }, {
            headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
        });

        const resData = codefRes.data;
        if (resData.result && resData.result.code !== '0000') {
            return res.status(400).json({ message: resData.result.message || '차량 정보를 찾을 수 없습니다.' });
        }

        const carDetails = resData.data || {};
        const carModel = carDetails.resCarName || carDetails.resCarModel || '조회 완료 차량';

        let matched = BATTERY_DATABASE.find(item => item.keywords.some(kw => carModel.includes(kw)));
        const recommendedBatteries = matched ? [
            { name: matched.modelName, price: matched.price },
            { name: `${matched.modelName} (AGM 프리미엄)`, price: matched.price + 30000 }
        ] : [
            { name: '로케트/델코 범용 맞춤 배터리 (80Ah)', price: 120000 },
            { name: '로케트 AGM80 (스탑앤고 고성능)', price: 145000 }
        ];

        res.json({ carNo, ownerName, carModel, recommendedBatteries });
    } catch (error) {
        res.status(500).json({ message: '국토부/CODEF API 조회 중 오류가 발생했습니다.' });
    }
});

// -------------------------------------------------------------
// 5. 예약 등록 및 관리자 전용 API
// -------------------------------------------------------------
app.post('/api/reserve', (req, res) => {
    const { userEmail, paymentId, carNo, batteryName, phone, reserveDate, address } = req.body;
    const query = `INSERT INTO reservations (user_email, payment_id, car_no, battery_name, phone, reserve_date, address, status) VALUES (?, ?, ?, ?, ?, ?, ?, '접수완료')`;
    
    db.run(query, [userEmail, paymentId, carNo, batteryName, phone, reserveDate, address], function(err) {
        if (err) return res.status(500).json({ message: '예약 저장 실패' });
        res.json({ message: '예약이 성공적으로 완료되었습니다.', id: this.lastID });
    });
});

app.get('/api/admin/reservations', (req, res) => {
    db.all(`SELECT * FROM reservations ORDER BY id DESC`, [], (err, rows) => {
        if (err) return res.status(500).json({ message: '조회 실패' });
        res.json(rows);
    });
});

app.post('/api/admin/update-status', (req, res) => {
    const { id, status } = req.body;
    db.run(`UPDATE reservations SET status = ? WHERE id = ?`, [id, status], function(err) {
        if (err) return res.status(500).json({ message: '상태 변경 실패' });
        res.json({ message: '예약 상태가 변경되었습니다.' });
    });
});

app.listen(PORT, () => {
    console.log(`BlueBattery 실운영 서버 가동 중 (포트: ${PORT})`);
});