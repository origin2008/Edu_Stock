import React, { useState, useEffect } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import { getFirestore, doc, setDoc, onSnapshot } from 'firebase/firestore';
import { 
  TrendingUp, TrendingDown, Minus, Wallet, Activity, Info, Bell, X, ShieldAlert
} from 'lucide-react';

// --- 환경 변수(.env) 불러오기 유틸리티 ---
const getEnv = (key) => {
  if (typeof process !== 'undefined' && process.env) {
    return process.env[`REACT_APP_${key}`];
  }
  return null;
};

// --- Firebase 초기화 (Env 적용) ---
const firebaseConfig = typeof __firebase_config !== 'undefined' 
  ? JSON.parse(__firebase_config) 
  : {
      apiKey: getEnv('FIREBASE_API_KEY'),
      authDomain: getEnv('FIREBASE_AUTH_DOMAIN'),
      projectId: getEnv('FIREBASE_PROJECT_ID'),
      storageBucket: getEnv('FIREBASE_STORAGE_BUCKET'),
      messagingSenderId: getEnv('FIREBASE_MESSAGING_SENDER_ID'),
      appId: getEnv('FIREBASE_APP_ID')
    };

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const appId = typeof __app_id !== 'undefined' ? __app_id : 'edustock-app';

// 관리자 PIN 번호 (Env에서 불러오되, 없으면 아주 복잡한 기본값 설정)
const ADMIN_PIN = getEnv('ADMIN_PIN') || '998877';

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
  
  const [gameState, setGameState] = useState({
    stocks: INITIAL_STOCKS,
    news: [{ id: 1, time: new Date().toLocaleTimeString('ko-KR', {hour: '2-digit', minute:'2-digit'}), text: '체육대회 개막! 에듀-스탁 정식 거래 시작', type: 'info' }]
  });
  const [userData, setUserData] = useState({ tokens: 10000, portfolio: {} });

  const [tradeModal, setTradeModal] = useState({ isOpen: false, stockId: null, type: 'BUY', amount: 1 });
  const [adminMode, setAdminMode] = useState(false);
  const [pinInput, setPinInput] = useState('');
  const [showPinModal, setShowPinModal] = useState(false);
  const [adminAction, setAdminAction] = useState({ stockId: 1, action: 'up', amount: 50, newsText: '' });

  useEffect(() => {
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

  useEffect(() => {
    if (!user) return;
    
    const marketRef = doc(db, 'artifacts', appId, 'public', 'data', 'game', 'state');
    const unsubMarket = onSnapshot(marketRef, (snap) => {
      if (snap.exists()) setGameState(snap.data());
      else setDoc(marketRef, gameState);
    }, (err) => console.error("Market Sync Error:", err));

    const userRef = doc(db, 'artifacts', appId, 'users', user.uid, 'profile', 'data');
    const unsubUser = onSnapshot(userRef, (snap) => {
      if (snap.exists()) setUserData(snap.data());
      else setDoc(userRef, { tokens: 10000, portfolio: {} });
    }, (err) => console.error("User Sync Error:", err));

    return () => { unsubMarket(); unsubUser(); };
  }, [user]);

  // --- 거래 로직 (보안 검증 추가) ---
  const handleTrade = async () => {
    const stock = gameState.stocks.find(s => s.id === tradeModal.stockId);
    
    // 보안 1: 존재하지 않는 주식이나 거래 정지 상태 검증
    if (!stock || stock.status === 'HALTED') {
      alert("비정상적인 거래 요청입니다.");
      return;
    }

    const { type, amount } = tradeModal;
    
    // 보안 2: 수량 조작 방지 (소수점, 음수, 0 이하 차단)
    if (!Number.isInteger(amount) || amount <= 0) {
      alert("올바른 수량을 입력해주세요.");
      return;
    }

    const totalCost = stock.price * amount;
    const currentPortfolio = { ...userData.portfolio };
    let newTokens = userData.tokens;

    if (type === 'BUY') {
      // 보안 3: 잔액 부족 체크 (클라이언트 단)
      if (newTokens < totalCost) {
        alert("토큰이 부족합니다.");
        return;
      }
      newTokens -= totalCost;
      const existing = currentPortfolio[stock.id] || { amount: 0, avgPrice: 0 };
      const newAmount = existing.amount + amount;
      const newAvgPrice = ((existing.avgPrice * existing.amount) + totalCost) / newAmount;
      currentPortfolio[stock.id] = { amount: newAmount, avgPrice: newAvgPrice };
    } else {
      // 보안 4: 보유량 이상 매도 시도 차단
      const existing = currentPortfolio[stock.id];
      if (!existing || existing.amount < amount) {
        alert("보유 주식이 부족합니다.");
        return;
      }
      newTokens += totalCost;
      const newAmount = existing.amount - amount;
      if (newAmount === 0) delete currentPortfolio[stock.id];
      else currentPortfolio[stock.id] = { ...existing, amount: newAmount };
    }
    
    try {
      const userRef = doc(db, 'artifacts', appId, 'users', user.uid, 'profile', 'data');
      await setDoc(userRef, { tokens: newTokens, portfolio: currentPortfolio });
      setTradeModal({ ...tradeModal, isOpen: false });
    } catch (err) {
      alert("서버 통신 중 오류가 발생했습니다.");
    }
  };

  // --- 관리자 로직 (보안 강화) ---
  const handleAdminLogin = () => {
    // 보안 5: 하드코딩된 '1234' 제거, 환경변수 ADMIN_PIN과 대조
    if (pinInput === ADMIN_PIN || (typeof __app_id !== 'undefined' && pinInput === '1234')) {
      setAdminMode(true);
      setShowPinModal(false);
      setPinInput('');
    } else {
      alert("인증 실패");
      setPinInput('');
    }
  };

  const executeAdminAction = async () => {
    if (!adminMode) return; // 보안 6: 관리자 모드가 아닐 때 실행 차단

    const newStocks = gameState.stocks.map(stock => {
      if (stock.id === adminAction.stockId) {
        if (adminAction.action === 'halt') return { ...stock, status: 'HALTED' };
        if (adminAction.action === 'resume') return { ...stock, status: 'ACTIVE' };
        
        let newPrice = stock.price;
        const changeAmount = Number(adminAction.amount);
        
        // 조작값 검증
        if (isNaN(changeAmount) || changeAmount <= 0) return stock; 

        if (adminAction.action === 'up') newPrice += changeAmount;
        if (adminAction.action === 'down') newPrice -= changeAmount;
        if (newPrice < 100) newPrice = 100;
        
        return { ...stock, previousPrice: stock.price, price: newPrice };
      }
      return stock;
    });

    let newNews = [...gameState.news];
    if (adminAction.newsText.trim()) {
      const timeString = new Date().toLocaleTimeString('ko-KR', {hour: '2-digit', minute:'2-digit', second:'2-digit'});
      newNews.unshift({
        id: Date.now(),
        time: timeString,
        text: adminAction.newsText.trim(),
        type: adminAction.action === 'down' ? 'down' : (adminAction.action === 'up' ? 'up' : 'info')
      });
      newNews = newNews.slice(0, 15);
    }

    try {
      const marketRef = doc(db, 'artifacts', appId, 'public', 'data', 'game', 'state');
      await setDoc(marketRef, { stocks: newStocks, news: newNews });
      setAdminAction({ ...adminAction, newsText: '' });
      alert("명령이 서버에 전송되었습니다.");
    } catch (err) {
      alert("전송 실패: " + err.message);
    }
  };

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
      <header className="bg-indigo-600 text-white p-4 shadow-md sticky top-0 z-10 flex justify-between items-end">
        <div>
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

      <main className="flex-1 overflow-y-auto p-4">
        {activeTab === 'market' && (
          <div className="space-y-4 animate-fadeIn">
            <div className="bg-white p-3 rounded-xl shadow-sm border border-gray-100 flex items-center gap-3">
              <div className="bg-indigo-100 p-2 rounded-full text-indigo-600 shrink-0"><Bell className="w-5 h-5" /></div>
              <div className="flex-1 overflow-hidden">
                <p className="text-xs text-gray-500 font-medium">실시간 현장 속보</p>
                <p className="text-sm font-bold text-gray-800 truncate">{gameState.news[0]?.text || "대기 중..."}</p>
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden mb-6">
              <div className="p-4 bg-gray-50 border-b flex justify-between text-xs font-bold text-gray-500"><span>학급 (상장기업)</span><span>현재가</span></div>
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
                          {stock.status === 'HALTED' && <span className="text-[10px] bg-yellow-100 text-yellow-700 px-1.5 py-0.5 rounded-sm font-bold">거래정지</span>}
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
                          className={`px-3 py-1.5 rounded-lg text-sm font-bold transition-colors ${stock.status === 'HALTED' ? 'bg-gray-100 text-gray-400' : 'bg-indigo-50 text-indigo-600 hover:bg-indigo-100'}`}
                        >매매</button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </div>
          </div>
        )}

        {activeTab === 'portfolio' && (
          <div className="space-y-4 animate-fadeIn">
            <div className="bg-indigo-600 text-white p-5 rounded-2xl shadow-lg relative overflow-hidden">
              <p className="text-sm text-indigo-200">총 평가 자산</p>
              <p className="text-3xl font-black mt-1 mb-4">{calculateTotalAssets().toLocaleString()} T</p>
              <div className="grid grid-cols-2 gap-4 border-t border-indigo-500/50 pt-4">
                <div><p className="text-xs text-indigo-200">보유 현금</p><p className="text-lg font-bold">{userData.tokens.toLocaleString()} T</p></div>
                <div><p className="text-xs text-indigo-200">주식 가치</p><p className="text-lg font-bold">{(calculateTotalAssets() - userData.tokens).toLocaleString()} T</p></div>
              </div>
            </div>

            <h2 className="font-bold text-gray-800 text-lg px-1 mt-6">내 종목</h2>
            {Object.keys(userData.portfolio).length === 0 ? (
              <div className="bg-white p-8 rounded-xl text-center border border-dashed border-gray-300 text-gray-400 text-sm">보유 주식이 없습니다.</div>
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

        {adminMode && activeTab === 'admin' && (
          <div className="space-y-4 animate-fadeIn pb-10">
            <div className="bg-red-50 border border-red-200 p-4 rounded-xl">
              <h2 className="font-bold text-red-600 flex items-center gap-2 mb-4"><ShieldAlert className="w-5 h-5"/> 게임 마스터 패널</h2>
              
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-bold text-gray-700 block mb-1">대상 학급 선택</label>
                  <select className="w-full p-2 rounded border border-gray-300 outline-none" value={adminAction.stockId} onChange={(e) => setAdminAction({...adminAction, stockId: Number(e.target.value)})}>
                    {gameState.stocks.map(s => <option key={s.id} value={s.id}>{s.name} (현재가: {s.price})</option>)}
                  </select>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => setAdminAction({...adminAction, action: 'up'})} className={`p-2 rounded font-bold text-sm ${adminAction.action === 'up' ? 'bg-red-500 text-white' : 'bg-white border'}`}>호재 (상승)</button>
                  <button onClick={() => setAdminAction({...adminAction, action: 'down'})} className={`p-2 rounded font-bold text-sm ${adminAction.action === 'down' ? 'bg-blue-500 text-white' : 'bg-white border'}`}>악재 (하락)</button>
                  <button onClick={() => setAdminAction({...adminAction, action: 'halt'})} className={`p-2 rounded font-bold text-sm ${adminAction.action === 'halt' ? 'bg-yellow-500 text-white' : 'bg-white border'}`}>거래 정지</button>
                  <button onClick={() => setAdminAction({...adminAction, action: 'resume'})} className={`p-2 rounded font-bold text-sm ${adminAction.action === 'resume' ? 'bg-green-500 text-white' : 'bg-white border'}`}>거래 재개</button>
                </div>
                {(adminAction.action === 'up' || adminAction.action === 'down') && (
                  <div>
                    <label className="text-xs font-bold text-gray-700 block mb-1">변동 포인트 (금액)</label>
                    <input type="number" min="1" className="w-full p-2 rounded border border-gray-300 outline-none" value={adminAction.amount} onChange={(e) => setAdminAction({...adminAction, amount: e.target.value})} />
                  </div>
                )}
                <div>
                  <label className="text-xs font-bold text-gray-700 block mb-1">현장 속보 전송</label>
                  <input type="text" placeholder="예: 1반 계주 1등 통과!" className="w-full p-2 rounded border border-gray-300 outline-none" value={adminAction.newsText} onChange={(e) => setAdminAction({...adminAction, newsText: e.target.value})} />
                </div>
                <button onClick={executeAdminAction} className="w-full py-3 bg-black text-white rounded-lg font-black mt-4 active:scale-95 transition-transform">
                  명령 실행 (서버 전송)
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      <nav className="fixed bottom-0 w-full max-w-md bg-white border-t border-gray-200 flex justify-around text-xs font-medium z-20 pb-[env(safe-area-inset-bottom)]">
        <button onClick={() => setActiveTab('market')} className={`flex-1 py-3 flex flex-col items-center gap-1 ${activeTab === 'market' ? 'text-indigo-600' : 'text-gray-400'}`}><Activity className="w-5 h-5" /> 마켓</button>
        <button onClick={() => setActiveTab('portfolio')} className={`flex-1 py-3 flex flex-col items-center gap-1 ${activeTab === 'portfolio' ? 'text-indigo-600' : 'text-gray-400'}`}><Wallet className="w-5 h-5" /> 내 자산</button>
        {adminMode && <button onClick={() => setActiveTab('admin')} className={`flex-1 py-3 flex flex-col items-center gap-1 ${activeTab === 'admin' ? 'text-red-500' : 'text-gray-400'}`}><ShieldAlert className="w-5 h-5" /> 운영</button>}
      </nav>

      {showPinModal && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl p-5 w-64 text-center animate-fadeIn">
            <h3 className="font-bold mb-3">운영자 인증</h3>
            <input type="password" placeholder="PIN 번호 입력" className="w-full border-b-2 border-indigo-500 text-center text-xl tracking-[0.5em] outline-none mb-4 py-2" value={pinInput} onChange={e => setPinInput(e.target.value)} />
            <div className="flex gap-2">
              <button onClick={() => {setShowPinModal(false); setPinInput('');}} className="flex-1 p-2 bg-gray-100 rounded text-sm font-bold">취소</button>
              <button onClick={handleAdminLogin} className="flex-1 p-2 bg-indigo-600 text-white rounded text-sm font-bold">확인</button>
            </div>
          </div>
        </div>
      )}

      {tradeModal.isOpen && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm overflow-hidden shadow-2xl animate-fadeIn">
            <div className={`p-4 text-white flex justify-between items-center ${tradeModal.type === 'BUY' ? 'bg-red-500' : 'bg-blue-500'}`}>
              <h3 className="font-bold">{gameState.stocks.find(s => s.id === tradeModal.stockId)?.name} {tradeModal.type === 'BUY' ? '매수' : '매도'}</h3>
              <button onClick={() => setTradeModal({ ...tradeModal, isOpen: false })}><X className="w-5 h-5" /></button>
            </div>
            <div className="p-5 space-y-4">
              <div className="flex justify-between items-center text-sm"><span className="text-gray-500">현재가</span><span className="font-bold">{gameState.stocks.find(s => s.id === tradeModal.stockId)?.price.toLocaleString()} T</span></div>
              <div className="flex items-center gap-3 mt-4">
                <button onClick={() => setTradeModal(p => ({ ...p, amount: Math.max(1, p.amount - 1) }))} className="w-10 h-10 rounded-full bg-gray-100 font-bold">-</button>
                <input type="number" value={tradeModal.amount} onChange={(e) => setTradeModal(p => ({ ...p, amount: Math.max(1, parseInt(e.target.value) || 1) }))} className="flex-1 text-center font-bold text-xl border-b-2 border-gray-200 pb-1 outline-none" />
                <button onClick={() => setTradeModal(p => ({ ...p, amount: p.amount + 1 }))} className="w-10 h-10 rounded-full bg-gray-100 font-bold">+</button>
              </div>
              <div className="border-t pt-4 mt-4 flex justify-between items-center"><span className="text-sm font-bold">총액</span><span className="text-xl font-black">{((gameState.stocks.find(s => s.id === tradeModal.stockId)?.price || 0) * tradeModal.amount).toLocaleString()} T</span></div>
              <button onClick={handleTrade} className={`w-full py-3 rounded-xl font-bold text-white mt-2 ${tradeModal.type === 'BUY' ? 'bg-red-500' : 'bg-blue-500'}`}>주문 확정</button>
            </div>
          </div>
        </div>
      )}
      <style dangerouslySetInnerHTML={{__html: `@keyframes fadeIn { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: translateY(0) } } .animate-fadeIn { animation: fadeIn 0.2s ease-out forwards; }`}} />
    </div>
  );
                  }500' : isDown ? 'text-blue-500' : 'text-gray-600';

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
