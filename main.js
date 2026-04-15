import React, { useState, useEffect } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, onSnapshot } from 'firebase/firestore';
import { 
  TrendingUp, TrendingDown, Minus, Wallet, Activity, Info, Bell, X, ShieldAlert
} from 'lucide-react';

// --- Firebase 초기화 (필수 규칙 적용) ---
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : {};
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = typeof __app_id !== 'undefined' ? __app_id : 'edustock-app';

// --- 초기 데이터 ---
const INITIAL_STOCKS = Array.from({ length: 10 }, (_, i) => ({
  id: i + 1,
  name: `1학년 ${i + 1}반`,
  price: 1000,
  previousPrice: 1000,
  status: 'ACTIVE',
}));

export default function App() {
  const [activeTab, setActiveTab] = useState('market');
  const [user, setUser] = useState(null);
  const [isAuthReady, setIsAuthReady] = useState(false);
  
  // 글로벌 게임 상태 (주식, 뉴스)
  const [gameState, setGameState] = useState({
    stocks: INITIAL_STOCKS,
    news: [{ id: 1, time: new Date().toLocaleTimeString('ko-KR', {hour: '2-digit', minute:'2-digit'}), text: '체육대회 개막! 에듀-스탁 정식 거래 시작', type: 'info' }]
  });

  // 유저 개인 자산 상태
  const [userData, setUserData] = useState({ tokens: 10000, portfolio: {} });

  // UI 상태
  const [tradeModal, setTradeModal] = useState({ isOpen: false, stockId: null, type: 'BUY', amount: 1 });
  const [adminMode, setAdminMode] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [showPinModal, setShowPinModal] = useState(false);
  const [adminAction, setAdminAction] = useState({ stockId: 1, action: 'up', amount: 50, newsText: '' });

  // 1. 모바일 앱 환경(PWA) Meta 태그 주입 및 인증
  useEffect(() => {
    // 스마트폰 바탕화면 추가 시 앱처럼 보이게 하는 메타 태그
    const metas = [
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { name: "theme-color", content: "#4f46e5" },
      { name: "viewport", content: "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" }
    ];

    metas.forEach(({ name, content }) => {
      let meta = document.querySelector(`meta[name="${name}"]`);
      if (!meta) {
        meta = document.createElement('meta');
        meta.name = name;
        document.head.appendChild(meta);
      }
      meta.content = content;
    });

    // Firebase 인증 초기화
    const initAuth = async () => {
      try {
        if (typeof __initial_auth_token !== 'undefined' && __initial_auth_token) {
          await signInWithCustomToken(auth, __initial_auth_token);
        } else {
          await signInAnonymously(auth);
        }
      } catch (err) {
        console.error("Auth Error:", err);
      }
    };
    initAuth();

    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser);
      setIsAuthReady(true);
    });
    return () => unsubscribe();
  }, []);

  // 2. 실시간 데이터베이스 연동 (시장 상태 & 내 자산)
  useEffect(() => {
    if (!user) return;

    // 공용 시장 데이터 구독
    const marketRef = doc(db, 'artifacts', appId, 'public', 'data', 'game', 'state');
    const unsubMarket = onSnapshot(marketRef, (snap) => {
      if (snap.exists()) {
        setGameState(snap.data());
      } else {
        // 최초 실행 시 기본 데이터 셋팅
        setDoc(marketRef, gameState);
      }
    }, (err) => console.error("Market Sync Error:", err));

    // 내 개인 자산 데이터 구독
    const userRef = doc(db, 'artifacts', appId, 'users', user.uid, 'profile', 'data');
    const unsubUser = onSnapshot(userRef, (snap) => {
      if (snap.exists()) {
        setUserData(snap.data());
      } else {
        // 첫 접속 시 10,000 토큰 지급
        setDoc(userRef, { tokens: 10000, portfolio: {} });
      }
    }, (err) => console.error("User Sync Error:", err));

    return () => {
      unsubMarket();
      unsubUser();
    };
  }, [user]);

  // --- 거래 로직 (Firebase 저장) ---
  const handleTrade = async () => {
    const stock = gameState.stocks.find(s => s.id === tradeModal.stockId);
    if (!stock || stock.status === 'HALTED') return;

    const { type, amount } = tradeModal;
    const totalCost = stock.price * amount;
    const currentPortfolio = { ...userData.portfolio };
    let newTokens = userData.tokens;

    if (type === 'BUY') {
      if (newTokens < totalCost) return;
      newTokens -= totalCost;
      const existing = currentPortfolio[stock.id] || { amount: 0, avgPrice: 0 };
      const newAmount = existing.amount + amount;
      const newAvgPrice = ((existing.avgPrice * existing.amount) + totalCost) / newAmount;
      currentPortfolio[stock.id] = { amount: newAmount, avgPrice: newAvgPrice };
    } else { // SELL
      const existing = currentPortfolio[stock.id];
      if (!existing || existing.amount < amount) return;
      newTokens += totalCost;
      const newAmount = existing.amount - amount;
      if (newAmount === 0) {
        delete currentPortfolio[stock.id];
      } else {
        currentPortfolio[stock.id] = { ...existing, amount: newAmount };
      }
    }
    
    // 내 자산 업데이트 (DB 전송)
    try {
      const userRef = doc(db, 'artifacts', appId, 'users', user.uid, 'profile', 'data');
      await setDoc(userRef, { tokens: newTokens, portfolio: currentPortfolio });
      setTradeModal({ ...tradeModal, isOpen: false });
    } catch (err) {
      console.error("Trade Error", err);
    }
  };

  // --- 관리자(운영자) 로직 ---
  const handleAdminLogin = () => {
    if (pinInput === '1234') {
      setAdminMode(true);
      setShowPinModal(false);
      setPinInput('');
    }
  };

  const executeAdminAction = async () => {
    const newStocks = gameState.stocks.map(stock => {
      if (stock.id === adminAction.stockId) {
        if (adminAction.action === 'halt') return { ...stock, status: 'HALTED' };
        if (adminAction.action === 'resume') return { ...stock, status: 'ACTIVE' };
        
        let newPrice = stock.price;
        if (adminAction.action === 'up') newPrice += Number(adminAction.amount);
        if (adminAction.action === 'down') newPrice -= Number(adminAction.amount);
        if (newPrice < 100) newPrice = 100;
        
        return { ...stock, previousPrice: stock.price, price: newPrice };
      }
      return stock;
    });

    let newNews = [...gameState.news];
    if (adminAction.newsText) {
      const timeString = new Date().toLocaleTimeString('ko-KR', {hour: '2-digit', minute:'2-digit', second:'2-digit'});
      newNews.unshift({
        id: Date.now(),
        time: timeString,
        text: adminAction.newsText,
        type: adminAction.action === 'down' ? 'down' : (adminAction.action === 'up' ? 'up' : 'info')
      });
      newNews = newNews.slice(0, 15); // 최근 15개 유지
    }

    try {
      const marketRef = doc(db, 'artifacts', appId, 'public', 'data', 'game', 'state');
      await setDoc(marketRef, { stocks: newStocks, news: newNews });
      setAdminAction({ ...adminAction, newsText: '' }); // 텍스트 초기화
    } catch (err) {
      console.error("Admin Action Error", err);
    }
  };

  // --- 유틸 ---
  const calculateTotalAssets = () => {
    let stockValue = 0;
    Object.entries(userData.portfolio).forEach(([id, data]) => {
      const stock = gameState.stocks.find(s => s.id === parseInt(id));
      if (stock) stockValue += stock.price * data.amount;
    });
    return userData.tokens + stockValue;
  };

  if (!isAuthReady) {
    return <div className="min-h-screen flex items-center justify-center bg-gray-50 text-indigo-600 font-bold">서버 접속 중...</div>;
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col font-sans max-w-md mx-auto shadow-xl relative pb-20 select-none">
      
      {/* 헤더 */}
      <header className="bg-indigo-600 text-white p-4 shadow-md sticky top-0 z-10 flex justify-between items-end">
        <div>
          {/* 타이틀 클릭 시 숨겨진 운영자 핀 입력창 표시 */}
          <h1 onClick={() => !adminMode && setShowPinModal(true)} className="text-2xl font-black tracking-tight cursor-pointer">
            에듀-스탁 {adminMode && <span className="text-xs bg-red-500 px-2 py-1 rounded ml-2">운영자</span>}
          </h1>
          <p className="text-xs text-indigo-200 mt-1">보는 체육대회에서 참여하는 체육대회로!</p>
        </div>
        <div className="text-right">
          <p className="text-xs text-indigo-200">내 자산</p>
          <p className="text-lg font-bold">{calculateTotalAssets().toLocaleString()} T</p>
        </div>
      </header>

      {/* 메인 콘텐츠 영역 */}
      <main className="flex-1 overflow-y-auto p-4">
        
        {/* 마켓 탭 */}
        {activeTab === 'market' && (
          <div className="space-y-4 animate-fadeIn">
            {/* 실시간 속보 */}
            <div className="bg-white p-3 rounded-xl shadow-sm border border-gray-100 flex items-center gap-3">
              <div className="bg-indigo-100 p-2 rounded-full text-indigo-600 shrink-0">
                <Bell className="w-5 h-5" />
              </div>
              <div className="flex-1 overflow-hidden">
                <p className="text-xs text-gray-500 font-medium">실시간 현장 속보</p>
                <p className="text-sm font-bold text-gray-800 truncate">
                  {gameState.news[0]?.text || "대기 중..."}
                </p>
              </div>
            </div>

            {/* 종목 리스트 */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-6">
              <div className="p-4 bg-gray-50 border-b flex justify-between text-xs font-bold text-gray-500">
                <span>학급 (상장기업)</span>
                <span>현재가</span>
              </div>
              <ul className="divide-y divide-gray-50">
                {gameState.stocks.map(stock => {
                  const isUp = stock.price > stock.previousPrice;
                  const isDown = stock.price < stock.previousPrice;
                  const colorClass = isUp ? 'text-red-500' : isDown ? 'text-blue-500' : 'text-gray-600';

                  return (
                    <li key={stock.id} className="p-4 flex items-center justify-between hover:bg-gray-50">
                      <div>
                        <h3 className="font-bold text-gray-800 flex items-center gap-2">
                          {stock.name}
                          {stock.status === 'HALTED' && (
                            <span className="text-[10px] bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded-sm font-bold">거래정지</span>
                          )}
                        </h3>
                      </div>
                      
                      <div className="flex items-center gap-3">
                        <div className="text-right flex items-center gap-1">
                          <span className={`font-bold ${colorClass}`}>{stock.price.toLocaleString()}</span>
                          {isUp ? <TrendingUp className="w-3 h-3 text-red-500" /> : isDown ? <TrendingDown className="w-3 h-3 text-blue-500" /> : <Minus className="w-3 h-3 text-gray-300" />}
                        </div>
                        <button 
                          onClick={() => setTradeModal({ isOpen: true, stockId: stock.id, type: 'BUY', amount: 1 })}
                          disabled={stock.status === 'HALTED'}
                          className={`px-3 py-1.5 rounded-lg text-sm font-bold transition-colors ${
                            stock.status === 'HALTED' ? 'bg-gray-100 text-gray-400' : 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100'
                          }`}
                        >
                          매매
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          </div>
        )}

        {/* 내 포트폴리오 탭 */}
        {activeTab === 'portfolio' && (
          <div className="space-y-4 animate-fadeIn">
            <div className="bg-indigo-600 text-white p-5 rounded-2xl shadow-lg relative overflow-hidden">
              <p className="text-sm text-indigo-200">총 평가 자산</p>
              <p className="text-3xl font-black mt-1 mb-4">{calculateTotalAssets().toLocaleString()} T</p>
              <div className="grid grid-cols-2 gap-4 border-t border-indigo-500/50 pt-4">
                <div>
                  <p className="text-xs text-indigo-200">보유 현금</p>
                  <p className="text-lg font-bold">{userData.tokens.toLocaleString()} T</p>
                </div>
                <div>
                  <p className="text-xs text-indigo-200">주식 가치</p>
                  <p className="text-lg font-bold">{(calculateTotalAssets() - userData.tokens).toLocaleString()} T</p>
                </div>
              </div>
            </div>

            <h2 className="font-bold text-gray-800 text-lg px-1 mt-6">내 종목</h2>
            {Object.keys(userData.portfolio).length === 0 ? (
              <div className="bg-white p-8 rounded-xl text-center border border-dashed border-gray-300 text-gray-400 text-sm">
                보유 주식이 없습니다.
              </div>
            ) : (
              <div className="space-y-3">
                {Object.entries(userData.portfolio).map(([id, data]) => {
                  const stock = gameState.stocks.find(s => s.id === parseInt(id));
                  if(!stock) return null;
                  const profit = (stock.price * data.amount) - (data.avgPrice * data.amount);
                  const profitPercent = ((profit / (data.avgPrice * data.amount)) * 100).toFixed(1);

                  return (
                    <div key={id} className="bg-white p-4 rounded-xl shadow-sm border border-gray-100">
                      <div className="flex justify-between items-center mb-3">
                        <h3 className="font-bold text-gray-800">{stock.name}</h3>
                        <div className="flex gap-2">
                          <button onClick={() => setTradeModal({ isOpen: true, stockId: stock.id, type: 'SELL', amount: 1 })} className="text-xs px-3 py-1 bg-gray-100 text-gray-700 rounded-md font-bold">매도</button>
                          <button onClick={() => setTradeModal({ isOpen: true, stockId: stock.id, type: 'BUY', amount: 1 })} className="text-xs px-3 py-1 bg-red-50 text-red-600 rounded-md font-bold">매수</button>
                        </div>
                      </div>
                      <div className="grid grid-cols-3 gap-2 text-sm bg-gray-50 p-2 rounded-lg">
                        <div><p className="text-[10px] text-gray-400">수량</p><p className="font-bold">{data.amount}</p></div>
                        <div><p className="text-[10px] text-gray-400">평단가</p><p className="font-bold">{Math.round(data.avgPrice)}</p></div>
                        <div className="text-right"><p className="text-[10px] text-gray-400">수익률</p><p className={`font-bold ${profit >= 0 ? 'text-red-500' : 'text-blue-500'}`}>{profit > 0 ? '+' : ''}{profitPercent}%</p></div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* 운영자 탭 (핀 번호 인증된 경우만 보임) */}
        {adminMode && activeTab === 'admin' && (
          <div className="space-y-4 animate-fadeIn pb-10">
            <div className="bg-red-50 border border-red-200 p-4 rounded-xl">
              <h2 className="font-bold text-red-600 flex items-center gap-2 mb-4"><ShieldAlert className="w-5 h-5"/> 게임 마스터 패널</h2>
              
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-bold text-gray-700 block mb-1">대상 학급 선택</label>
                  <select 
                    className="w-full p-2 rounded border border-gray-300 outline-none"
                    value={adminAction.stockId}
                    onChange={(e) => setAdminAction({...adminAction, stockId: Number(e.target.value)})}
                  >
                    {gameState.stocks.map(s => <option key={s.id} value={s.id}>{s.name} (현재가: {s.price})</option>)}
                  </select>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => setAdminAction({...adminAction, action: 'up'})} className={`p-2 rounded font-bold text-sm ${adminAction.action === 'up' ? 'bg-red-500 text-white' : 'bg-white border'}`}>호재 (주가상승)</button>
                  <button onClick={() => setAdminAction({...adminAction, action: 'down'})} className={`p-2 rounded font-bold text-sm ${adminAction.action === 'down' ? 'bg-blue-500 text-white' : 'bg-white border'}`}>악재 (주가하락)</button>
                  <button onClick={() => setAdminAction({...adminAction, action: 'halt'})} className={`p-2 rounded font-bold text-sm ${adminAction.action === 'halt' ? 'bg-yellow-500 text-white' : 'bg-white border'}`}>거래 정지</button>
                  <button onClick={() => setAdminAction({...adminAction, action: 'resume'})} className={`p-2 rounded font-bold text-sm ${adminAction.action === 'resume' ? 'bg-green-500 text-white' : 'bg-white border'}`}>거래 재개</button>
                </div>

                {(adminAction.action === 'up' || adminAction.action === 'down') && (
                  <div>
                    <label className="text-xs font-bold text-gray-700 block mb-1">변동 포인트 (금액)</label>
                    <input 
                      type="number" 
                      className="w-full p-2 rounded border border-gray-300 outline-none"
                      value={adminAction.amount}
                      onChange={(e) => setAdminAction({...adminAction, amount: e.target.value})}
                    />
                  </div>
                )}

                <div>
                  <label className="text-xs font-bold text-gray-700 block mb-1">현장 속보 전송 (모든 유저에게 알림)</label>
                  <input 
                    type="text" 
                    placeholder="예: 1반 계주 1등 통과!"
                    className="w-full p-2 rounded border border-gray-300 outline-none"
                    value={adminAction.newsText}
                    onChange={(e) => setAdminAction({...adminAction, newsText: e.target.value})}
                  />
                </div>

                <button 
                  onClick={executeAdminAction}
                  className="w-full py-3 bg-black text-white rounded-lg font-black mt-4 active:scale-95 transition-transform"
                >
                  명령 실행 (서버 전송)
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* 하단 탭 네비게이션 */}
      <nav className="fixed bottom-0 w-full max-w-md bg-white border-t border-gray-200 flex justify-around text-xs font-medium z-20 pb-[env(safe-area-inset-bottom)]">
        <button onClick={() => setActiveTab('market')} className={`flex-1 py-3 flex flex-col items-center gap-1 ${activeTab === 'market' ? 'text-indigo-600' : 'text-gray-400'}`}>
          <Activity className="w-5 h-5" /> 마켓
        </button>
        <button onClick={() => setActiveTab('portfolio')} className={`flex-1 py-3 flex flex-col items-center gap-1 ${activeTab === 'portfolio' ? 'text-indigo-600' : 'text-gray-400'}`}>
          <Wallet className="w-5 h-5" /> 내 자산
        </button>
        {adminMode && (
          <button onClick={() => setActiveTab('admin')} className={`flex-1 py-3 flex flex-col items-center gap-1 ${activeTab === 'admin' ? 'text-red-500' : 'text-gray-400'}`}>
            <ShieldAlert className="w-5 h-5" /> 운영
          </button>
        )}
      </nav>

      {/* 관리자 핀 번호 모달 */}
      {showPinModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl p-5 w-64 text-center">
            <h3 className="font-bold mb-3">운영자 인증</h3>
            <input 
              type="password" 
              maxLength={4}
              placeholder="PIN 번호 (1234)" 
              className="w-full border-b-2 border-indigo-500 text-center text-xl tracking-[0.5em] outline-none mb-4 py-2"
              value={pinInput}
              onChange={e => setPinInput(e.target.value)}
            />
            <div className="flex gap-2">
              <button onClick={() => setShowPinModal(false)} className="flex-1 p-2 bg-gray-100 rounded text-sm font-bold">취소</button>
              <button onClick={handleAdminLogin} className="flex-1 p-2 bg-indigo-600 text-white rounded text-sm font-bold">확인</button>
            </div>
          </div>
        </div>
      )}

      {/* 매매 모달 (기존과 로직은 동일하나 디자인 압축) */}
      {tradeModal.isOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm overflow-hidden shadow-2xl">
            <div className={`p-4 text-white flex justify-between items-center ${tradeModal.type === 'BUY' ? 'bg-red-500' : 'bg-blue-500'}`}>
              <h3 className="font-bold">{gameState.stocks.find(s => s.id === tradeModal.stockId)?.name} {tradeModal.type === 'BUY' ? '매수' : '매도'}</h3>
              <button onClick={() => setTradeModal({ ...tradeModal, isOpen: false })}><X className="w-5 h-5" /></button>
            </div>
            <div className="p-5 space-y-4">
              <div className="flex justify-between items-center text-sm"><span className="text-gray-500">현재가</span><span className="font-bold">{gameState.stocks.find(s => s.id === tradeModal.stockId)?.price.toLocaleString()} T</span></div>
              <div className="flex items-center gap-3 mt-4">
                <button onClick={() => setTradeModal(p => ({ ...p, amount: Math.max(1, p.amount - 1) }))} className="w-10 h-10 rounded-full bg-gray-100 font-bold">-</button>
                <input type="number" value={tradeModal.amount} readOnly className="flex-1 text-center font-bold text-xl border-b-2 border-gray-200 pb-1" />
                <button onClick={() => setTradeModal(p => ({ ...p, amount: p.amount + 1 }))} className="w-10 h-10 rounded-full bg-gray-100 font-bold">+</button>
              </div>
              <div className="border-t pt-4 mt-4 flex justify-between items-center"><span className="text-sm font-bold">총액</span><span className="text-xl font-black">{((gameState.stocks.find(s => s.id === tradeModal.stockId)?.price || 0) * tradeModal.amount).toLocaleString()} T</span></div>
              <button onClick={handleTrade} className={`w-full py-3 rounded-xl font-bold text-white mt-2 ${tradeModal.type === 'BUY' ? 'bg-red-500' : 'bg-blue-500'}`}>주문 확정</button>
            </div>
          </div>
        </div>
      )}

      <style dangerouslySetInnerHTML={{__html: `@keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } } .animate-fadeIn { animation: fadeIn 0.2s ease-out forwards; }`}} />
    </div>
  );
}
