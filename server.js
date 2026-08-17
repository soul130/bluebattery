const express = require('express');
const cors = require('cors');
const axios = require('axios');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = 'BLUE_BATTERY_SECRET_KEY_2026';

// -------------------------------------------------------------
// 1. CORS 및 미들웨어 설정 (모든 요청 및 헤더 허용 - 버튼 먹통 방지)
// -------------------------------------------------------------
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// -------------------------------------------------------------
// 2. SQLite DB 설정 (WAL 모드 적용으로 동시성 락 완전히 차단)
// -------------------------------------------------------------
const db = new sqlite3.Database('./database.db', (err) => {
    if (err) {
        console.error("SQLite DB 연결 실패:", err.message);
    } else {
        console.log("SQLite DB 연결 성공");
        // DB 잠금(Lock) 및 타임아웃 멈춤 현상 해결 핵심 구문
        db.run("PRAGMA journal_mode = WAL;");
    }
});

// DB 테이블 생성 및 초기 데이터 설정
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
    )`, (err) => {
        if (err) console.error("users 테이블 생성 실패:", err.message);
    });

    // 예약 테이블
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
    )`, (err) => {
        if (err) console.error("reservations 테이블 생성 실패:", err.message);
    });

    // 최고 관리자 계정 생성 (admin@blue.com / admin123)
    db.run(`INSERT OR IGNORE INTO users (email, password, name, phone, role) 
            VALUES ('admin@blue.com', 'admin123', '최고관리자', '01000000000', 'admin')`);
});

// -------------------------------------------------------------
// 3. CODEF API 설정 (국토부 차량 실시간 조회용)
// -------------------------------------------------------------
const CODEF_CONFIG = {
    client_id: 'ef27cfaa-10c1-4470-adac-60ba476273f9',
    client_secret: '83160c33-9045-4915-86d8-809473cdf5c3',
    baseUrl: 'https://development.codef.io'
};

async function getAccessToken() {
    try {
        const authHeader = Buffer.from(`${CODEF_CONFIG.client_id}:${CODEF_CONFIG.client_secret}`).toString('base64');
        const response = await axios.post('https://oauth.codef.io/oauth/token', 'grant_type=client_credentials&scope=read', {
            headers: { 
                'Content-Type': 'application/x-www-form-urlencoded', 
                'Authorization': `Basic ${authHeader}` 
            }
        });
        return response.data.access_token;
    } catch (error) {
        console.error("CODEF 토큰 발급 실패:", error.message);
        throw error;
    }
}

// 배터리 차종별 매칭 DB
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
// 4. 기본 백엔드 상태 확인 API
// -------------------------------------------------------------
app.get('/', (req, res) => {
    res.send('BlueBattery 백엔드 서버가 정상 작동 중입니다.');
});

// -------------------------------------------------------------
// 5. Real 회원가입 API (전화번호 수집 및 JWT 발급)
// -------------------------------------------------------------
app.post('/api/register', (req, res) => {
    const { email, password, name, phone } = req.body;
    
    if (!email || !password || !name || !phone) {
        return res.status(400).json({ success: false, message: '모든 입력 항목을 채워주세요.' });
    }

    const query = `INSERT INTO users (email, password, name, phone, role) VALUES (?, ?, ?, ?, 'user')`;
    
    db.run(query, [email, password, name, phone], function(err) {
        if (err) {
            console.error("회원가입 DB 오류:", err.message);
            if (err.message.includes('UNIQUE')) {
                return res.status(400).json({ success: false, message: '이미 가입된 이메일 주소입니다.' });
            }
            return res.status(500).json({ success: false, message: '회원가입 처리 중 오류가 발생했습니다.' });
        }
        
        const token = jwt.sign({ email, name, role: 'user' }, JWT_SECRET, { expiresIn: '365d' });
        return res.status(200).json({ 
            success: true,
            message: '회원가입이 완료되었습니다.', 
            token, 
            user: { email, name, phone, role: 'user', hasCard: false } 
        });
    });
});

// -------------------------------------------------------------
// 6. Real 로그인 API
// -------------------------------------------------------------
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ success: false, message: '이메일과 비밀번호를 모두 입력해주세요.' });
    }

    db.get(`SELECT * FROM users WHERE email = ? AND password = ?`, [email, password], (err, row) => {
        if (err) {
            console.error("로그인 DB 오류:", err.message);
            return res.status(500).json({ success: false, message: '서버 오류가 발생했습니다.' });
        }
        if (!row) {
            return res.status(401).json({ success: false, message: '이메일 또는 비밀번호가 일치하지 않습니다.' });
        }

        const token = jwt.sign({ email: row.email, name: row.name, role: row.role }, JWT_SECRET, { expiresIn: '365d' });
        return res.status(200).json({ 
            success: true,
            message: '로그인 성공',
            token, 
            user: { email: row.email, name: row.name, phone: row.phone, role: row.role || 'user', hasCard: !!row.billing_key } 
        });
    });
});

// -------------------------------------------------------------
// 7. Real 카드 등록 API (포트원 빌링키 저장)
// -------------------------------------------------------------
app.post('/api/save-card', (req, res) => {
    const { email, billingKey } = req.body;
    
    if (!email || !billingKey) {
        return res.status(400).json({ success: false, message: '잘못된 카드 등록 요청입니다.' });
    }

    db.run(`UPDATE users SET billing_key = ? WHERE email = ?`, [billingKey, email], function(err) {
        if (err) {
            console.error("카드 저장 오류:", err.message);
            return res.status(500).json({ success: false, message: '카드 등록에 실패했습니다.' });
        }
        return res.status(200).json({ success: true, message: '자동결제 카드가 성공적으로 등록되었습니다.' });
    });
});

// -------------------------------------------------------------
// 8. Real 자동차 실시간 조회 API (국토부 CODEF 연동)
// -------------------------------------------------------------
app.post('/api/car-search', async (req, res) => {
    try {
        const { carNo, ownerName } = req.body;
        if (!carNo || !ownerName) {
            return res.status(400).json({ success: false, message: '차량번호와 소유자명을 입력해주세요.' });
        }

        const accessToken = await getAccessToken();
        const codefRes = await axios.post(`${CODEF_CONFIG.baseUrl}/v1/kr/public/lt/car-registration-issuance-second/issue`, {
            organization: '0020',
            resUserIdentifiNo: ownerName,
            resCarNo: carNo
        }, {
            headers: { 
                'Authorization': `Bearer ${accessToken}`, 
                'Content-Type': 'application/json' 
            }
        });

        const resData = codefRes.data;
        if (resData.result && resData.result.code !== '0000') {
            return res.status(400).json({ success: false, message: resData.result.message || '차량 정보를 찾을 수 없습니다.' });
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

        return res.status(200).json({ success: true, carNo, ownerName, carModel, recommendedBatteries });
    } catch (error) {
        console.error("차량 조회 오류:", error.message);
        return res.status(500).json({ success: false, message: '국토부/CODEF API 조회 중 오류가 발생했습니다.' });
    }
});

// -------------------------------------------------------------
// 9. Real 출장 예약 저장 API
// -------------------------------------------------------------
app.post('/api/reserve', (req, res) => {
    const { userEmail, paymentId, carNo, batteryName, phone, reserveDate, address } = req.body;

    if (!userEmail || !carNo || !batteryName || !phone) {
        return res.status(400).json({ success: false, message: '필수 예약 정보가 누락되었습니다.' });
    }

    const query = `INSERT INTO reservations (user_email, payment_id, car_no, battery_name, phone, reserve_date, address, status) VALUES (?, ?, ?, ?, ?, ?, ?, '접수완료')`;
    
    db.run(query, [userEmail, paymentId, carNo, batteryName, phone, reserveDate, address], function(err) {
        if (err) {
            console.error("예약 저장 오류:", err.message);
            return res.status(500).json({ success: false, message: '예약 저장에 실패했습니다.' });
        }
        return res.status(200).json({ success: true, message: '예약이 성공적으로 완료되었습니다.', id: this.lastID });
    });
});

// -------------------------------------------------------------
// 10. Real 관리자 전용 예약 목록 조회 및 상태 업데이트 API
// -------------------------------------------------------------
app.get('/api/admin/reservations', (req, res) => {
    db.all(`SELECT * FROM reservations ORDER BY id DESC`, [], (err, rows) => {
        if (err) {
            console.error("관리자 예약 조회 오류:", err.message);
            return res.status(500).json({ success: false, message: '예약 목록 조회 실패' });
        }
        return res.status(200).json({ success: true, reservations: rows });
    });
});

app.post('/api/admin/update-status', (req, res) => {
    const { id, status } = req.body;
    
    if (!id || !status) {
        return res.status(400).json({ success: false, message: '요청 정보가 부정확합니다.' });
    }

    db.run(`UPDATE reservations SET status = ? WHERE id = ?`, [status, id], function(err) {
        if (err) {
            console.error("상태 변경 오류:", err.message);
            return res.status(500).json({ success: false, message: '예약 상태 변경에 실패했습니다.' });
        }
        return res.status(200).json({ success: true, message: '예약 상태가 변경되었습니다.' });
    });
});

// -------------------------------------------------------------
// 11. 백엔드 서버 가동
// -------------------------------------------------------------
app.listen(PORT, () => {
    console.log(`BlueBattery 실운영 서버가 정상적으로 가동 중입니다. (포트: ${PORT})`);
});