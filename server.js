const express = require('express');
const axios = require('axios');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static('public'));

// CODEF API 설정 (정식 운영 및 샌드박스 겸용)
const CODEF_CONFIG = {
  client_id: 'ef27cfaa-10c1-4470-adac-60ba476273f9',
  client_secret: '83160c33-9045-4915-86d8-809473cdf5c3',
  // 정식 승인 후에는 아래 주소를 'https://api.codef.io'로 변경합니다.
  baseUrl: 'https://development.codef.io' 
};

// -------------------------------------------------------------
// [실제 배터리 규격 데이터베이스 (실제 차량 규격 기준)]
// -------------------------------------------------------------
const BATTERY_DATABASE = [
  { keywords: ['아반떼', 'AVANTE'], fuel: '가솔린', modelName: '로케트 DIN 60L / Delkor 56219', capacity: '12V 60Ah', price: 95000, desc: '아반떼 가솔린 표준 순정 규격' },
  { keywords: ['아반떼', 'AVANTE'], fuel: '디젤', modelName: '로케트 AGM 70L', capacity: '12V 70Ah', price: 125000, desc: 'ISG(스탑앤고) 대응 고성능 AGM' },
  { keywords: ['쏘나타', 'SONATA', 'K5'], fuel: '가솔린', modelName: '로케트 AGM 80L / Delkor AGM 80', capacity: '12V 80Ah', price: 135000, desc: '중형 가솔린/ISG 차량용 표준 AGM' },
  { keywords: ['그랜저', 'GRANDEUR', 'K7', 'K8'], fuel: '가솔린', modelName: '로케트 AGM 80L', capacity: '12V 80Ah', price: 135000, desc: '준대형 세단 표준 규격' },
  { keywords: ['카니발', 'CARNIVAL', '팰리세이드'], fuel: '디젤', modelName: '로케트 AGM 95L / Delkor AGM 95', capacity: '12V 95Ah', price: 155000, desc: '대형 RV/SUV 디젤 차량용 고용량 AGM' },
  { keywords: ['산타페', 'SANTAFE', '쏘렌토', 'SORENTO'], fuel: '디젤', modelName: '로케트 AGM 90L', capacity: '12V 90Ah', price: 145000, desc: '중형 SUV 디젤 전용 규격' },
  { keywords: ['모닝', 'MORNING', '레이', 'RAY'], fuel: '가솔린', modelName: '로케트 40AL / Delkor 40AL', capacity: '12V 40Ah', price: 65000, desc: '경차 전용 소형 규격' }
];

// 기본 배터리 (매칭 데이터가 없는 특수 차종용 예비)
const DEFAULT_BATTERY = {
  modelName: '로케트/델코 범용 맞춤 배터리 (80Ah)',
  capacity: '12V 80Ah',
  price: 120000,
  desc: '현장 확인 후 최적 규격으로 맞춤 설치'
};

// CODEF OAuth2 토큰 발급
async function getAccessToken() {
  const authHeader = Buffer.from(`${CODEF_CONFIG.client_id}:${CODEF_CONFIG.client_secret}`).toString('base64');
  const response = await axios.post('https://oauth.codef.io/oauth/token', 'grant_type=client_credentials&scope=read', {
    headers: { 
      'Content-Type': 'application/x-www-form-urlencoded', 
      'Authorization': `Basic ${authHeader}` 
    }
  });
  return response.data.access_token;
}

// 1. 차량 실시간 제원 조회 및 배터리 매칭 API
app.post('/api/car-info', async (req, res) => {
  try {
    const { ownerName, carNumber } = req.body;

    if (!ownerName || !carNumber) {
      return res.status(400).json({ success: false, message: '차량번호와 소유자명을 입력해주세요.' });
    }

    const accessToken = await getAccessToken();

    // CODEF 실제 자동차등록원부(을) 조회 API 호출
    const codefRes = await axios.post(`${CODEF_CONFIG.baseUrl}/v1/kr/public/lt/car-registration-issuance-second/issue`, {
      organization: '0020',          // 정부24 / 자동차민원 대국민포털
      resUserIdentifiNo: ownerName,    // 소유자명 또는 주민번호/사업자번호
      resCarNo: carNumber            // 차량번호
    }, {
      headers: { 
        'Authorization': `Bearer ${accessToken}`, 
        'Content-Type': 'application/json' 
      }
    });

    const resData = codefRes.data;

    // CODEF 응답 코드 확인 ('0000'이 성공)
    if (resData.result && resData.result.code !== '0000') {
      return res.json({ 
        success: false, 
        message: resData.result.message || '차량 정보를 찾을 수 없습니다. 입력 정보를 확인해 주세요.' 
      });
    }

    // 실제 CODEF API가 반환한 데이터 추출
    const carDetails = resData.data || {};
    const carName = carDetails.resCarName || carDetails.resCarModel || '미확인 차종'; // 실제 차종명
    const carYear = carDetails.resCarYear || carDetails.resMakeYear || '';            // 연식
    const fuelType = carDetails.resFuel || carDetails.resEngineType || '';           // 연료 (가솔린/디젤 등)

    // 실제 DB 매칭 로직
    let matchedBattery = BATTERY_DATABASE.find(item => {
      const matchName = item.keywords.some(kw => carName.includes(kw));
      const matchFuel = !fuelType || item.fuel === '' || fuelType.includes(item.fuel);
      return matchName && matchFuel;
    });

    if (!matchedBattery) {
      matchedBattery = DEFAULT_BATTERY;
    }

    res.json({
      success: true,
      carInfo: {
        carNumber: carNumber,
        carName: carName,
        carYear: carYear,
        fuelType: fuelType
      },
      battery: matchedBattery
    });

  } catch (error) {
    console.error('CODEF API 통신 오류:', error.response ? error.response.data : error.message);
    res.status(500).json({ 
      success: false, 
      message: '국토교통부/CODEF API 조회 중 오류가 발생했습니다.' 
    });
  }
});

// 2. 실제 구매 및 예약 접수 API
app.post('/api/reservation', (req, res) => {
  const { carNumber, carName, batteryName, serviceType, date, address, phone } = req.body;

  if (!phone || !date || !address) {
    return res.status(400).json({ success: false, message: '필수 정보를 모두 입력해 주세요.' });
  }

  // 데이터베이스(MySQL, MongoDB 등)에 실제 예약 정보를 저장하는 구간
  console.log('====================================');
  console.log('[실제 교체/구매 예약 접수]');
  console.log(`차량번호 : ${carNumber} (${carName})`);
  console.log(`선택배터리: ${batteryName}`);
  console.log(`서비스방식: ${serviceType}`);
  console.log(`예약일시 : ${date}`);
  console.log(`방문주소 : ${address}`);
  console.log(`고객연락처: ${phone}`);
  console.log('====================================');

  res.json({ 
    success: true, 
    message: '성공적으로 배터리 구매 및 교체 예약이 접수되었습니다.' 
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`BlueBattery 실운영 서버 가동 중: http://localhost:${PORT}`));