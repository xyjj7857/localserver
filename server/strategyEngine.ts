import { AppSettings, Position, Order, LogEntry } from "../src/shared/types";
import { BinanceService } from "./binance";
import { BinanceWS } from "./websocket";
import { StorageService } from "./storage";
import { EmailService } from "./email";
import axios from 'axios';

export class StrategyEngine {
  private settings: AppSettings;
  private binance: BinanceService;
  private ws: BinanceWS;
  private masterSwitch: boolean = false;

  // State
  private stage0Results: string[] = [];
  private stage0PResults: string[] = [];
  private stage0PReasons: Map<string, string> = new Map();
  private stage1Results: string[] = [];
  private stage2Results: any[] = [];
  private stage2Failed: any[] = [];
  private cooldowns: Map<string, number> = new Map();
  private activePosition: Position | null = null;
  private activeOrders: Order[] = [];
  private accountInfo: any = null;
  private btcData: any = null;
  private stage2Data: Map<string, any> = new Map();
  private stage2Data15m: Map<string, any> = new Map();
  private stage2Data15mClosed: Map<string, any> = new Map();
  private bestSymbol: any = null;
  private pendingSecondaryOrders: {
    symbol: string;
    entryPrice: number;
    quantity: string;
    targetOpenTime: number;
    triggerTime: number;
    kClosedPeriod: string;
  } | null = null;
  private apiError: string | null = null;
  private symbolInfo: Map<string, any> = new Map();
  private listenKey: string | null = null;
  private listenKeyTimer: NodeJS.Timeout | null = null;
  private currentSubscriptions: Set<string> = new Set();
  private isStopped: boolean = false;
  private isExecutingMarketClose: boolean = false;

  // Email Notification State
  private consecutiveReverseOrders: number = 0;
  private lastBalanceEmailTime: number = 0;
  private lastReverseEmailTime: number = 0;

  private lastWSMessageTime: number = 0;
  private wsError: string | null = null;
  private ip: string = '加载中...';

  // Timing info for UI
  private scanTimes = {
    stage0Duration: 0,
    stage0PDuration: 0,
    stage1Duration: 0,
    stage2Duration: 0,
    stage0LastStart: 0,
    stage0PLastStart: 0,
    stage1LastStart: 0,
    stage2LastStart: 0,
    stage0NextStart: 0,
    stage0PNextStart: 0,
    stage1NextStart: 0,
    stage2NextStart: 0,
    stage0Countdown: 0,
    stage0PCountdown: 0,
    stage1Countdown: 0,
    stage2Countdown: 0,
    orderNext: 0,
    bestSelectionTime: 0
  };

  // Timers/Intervals
  private mainLoopInterval: NodeJS.Timeout | null = null;
  private refreshInterval: NodeJS.Timeout | null = null;

  // Callbacks for UI updates
  private onUpdate: (state: any) => void;

  constructor(settings: AppSettings, onUpdate: (state: any) => void) {
    this.settings = settings;
    this.onUpdate = onUpdate;
    this.binance = new BinanceService(
      settings.binance.apiKey,
      settings.binance.secretKey,
      settings.binance.baseUrl
    );
    this.ws = new BinanceWS(settings.binance.wsUrl, this.handleWSMessage.bind(this));
    this.masterSwitch = settings.masterSwitch;

    // Restore state from SQLite
    const savedState = StorageService.getState();
    if (savedState) {
      this.stage0Results = savedState.stage0Results || [];
      this.stage0PResults = savedState.stage0PResults || [];
      this.stage1Results = savedState.stage1Results || [];
      this.cooldowns = new Map(Object.entries(savedState.cooldowns || {}));
      this.consecutiveReverseOrders = savedState.consecutiveReverseOrders || 0;
      if (savedState.activePosition) {
        this.activePosition = savedState.activePosition;
      }
    }
  }

  async start() {
    if (this.mainLoopInterval || this.isStopped) return;
    
    console.log('[Server StrategyEngine] Starting...');
    
    // Fetch initial IP
    this.refreshIP();

    this.startTimers();

    if (this.masterSwitch) {
      this.initializeStrategy();
    }
  }

  private async refreshIP() {
    try {
      const response = await axios.get('https://api.ipify.org?format=json', { timeout: 5000 });
      this.ip = response.data.ip;
      this.notifyUI();
    } catch (e) {
      console.error('[Server StrategyEngine] Failed to fetch IP:', e);
    }
  }

  private async initializeStrategy(retryCount = 0) {
    if (!this.masterSwitch || this.isStopped) return;
    
    try {
      console.log(`[Server StrategyEngine] Initializing strategy (Attempt ${retryCount + 1})...`);
      
      await this.binance.syncTime();
      if (this.isStopped) return;
      
      await this.refreshExchangeInfo();
      if (this.isStopped) return;

      await this.setupUserDataStream();
      if (this.isStopped) return;

      this.ws.connect(
        () => {
          this.wsError = null;
          this.notifyUI();
          this.updateSubscriptions();
        },
        () => {
          this.notifyUI();
        },
        (err) => {
          this.wsError = 'WebSocket 连接失败';
          this.notifyUI();
        }
      );
      
      this.refreshAccountInfo();
      this.runStage0();
      
    } catch (e: any) {
      console.error(`[Server StrategyEngine] Initialization failed:`, e);
      if (retryCount < 5 && !this.isStopped) {
        const delay = Math.min(Math.pow(2, retryCount) * 2000, 30000);
        setTimeout(() => this.initializeStrategy(retryCount + 1), delay);
      } else {
        StorageService.addLog({ module: 'System', type: 'error', message: `策略初始化多次失败: ${e.message}` });
      }
    }
  }

  private async setupUserDataStream() {
    if (!this.masterSwitch || this.isStopped) return;
    try {
      const res = await this.binance.createListenKey();
      if (this.isStopped) return;
      if (res && res.listenKey) {
        this.listenKey = res.listenKey;
        this.ws.setListenKey(this.listenKey);
        
        if (this.listenKeyTimer) clearInterval(this.listenKeyTimer);
        this.listenKeyTimer = setInterval(() => {
          if (this.isStopped || !this.masterSwitch) return;
          this.binance.keepAliveListenKey().catch(console.error);
        }, 30 * 60 * 1000);
      }
    } catch (e: any) {
      console.error('[Server StrategyEngine] Failed to create listenKey', e);
      this.apiError = e.message;
      this.notifyUI();
    }
  }

  public stop() {
    this.isStopped = true;
    if (this.mainLoopInterval) clearInterval(this.mainLoopInterval);
    if (this.refreshInterval) clearInterval(this.refreshInterval);
    if (this.listenKeyTimer) clearInterval(this.listenKeyTimer);
    this.ws.close();
  }

  private updateSubscriptions() {
    const needed = new Set<string>();
    
    if (this.masterSwitch) {
      needed.add('btcusdt@kline_15m');

      if (this.activePosition) {
        needed.add(`${this.activePosition.symbol.toLowerCase()}@kline_5m`);
      }

      this.stage1Results.forEach(s => {
        const sym = s.toLowerCase();
        needed.add(`${sym}@kline_5m`);
        needed.add(`${sym}@kline_15m`);
        if (this.settings.scanner.stage2Period !== '5m' && this.settings.scanner.stage2Period !== '15m') {
          needed.add(`${sym}@kline_${this.settings.scanner.stage2Period}`);
        }
      });
    }

    const toUnsubscribe = Array.from(this.currentSubscriptions).filter(s => !needed.has(s));
    const toSubscribe = Array.from(needed).filter(s => !this.currentSubscriptions.has(s));

    if (toUnsubscribe.length > 0) this.ws.unsubscribe(toUnsubscribe);
    if (toSubscribe.length > 0) this.ws.subscribe(toSubscribe);

    this.currentSubscriptions = needed;
  }

  private async refreshExchangeInfo() {
    if (!this.masterSwitch) return;
    try {
      const info = await this.binance.getExchangeInfo();
      info.symbols.forEach((s: any) => {
        this.symbolInfo.set(s.symbol, s);
      });
    } catch (e) {
      console.error('[Server StrategyEngine] Failed to refresh exchange info', e);
    }
  }

  private startTimers() {
    if (this.mainLoopInterval) clearInterval(this.mainLoopInterval);
    this.mainLoopInterval = setInterval(() => this.checkSchedules(), 100);
    
    if (this.refreshInterval) clearInterval(this.refreshInterval);
    this.refreshInterval = setInterval(() => this.refreshAccountInfo(), 5000);
  }

  private lastRunBlock = {
    stage0: -1,
    stage0P: -1,
    stage1: -1,
    stage2: -1,
    order: -1
  };

  private isScanning = {
    stage0: false,
    stage0P: false,
    stage1: false,
    stage2: false,
    stage0Progress: 0,
    stage0PProgress: 0,
    stage1Progress: 0,
    stage2Progress: 0
  };

  private parsePeriod(period: string): number {
    const val = parseInt(period);
    if (period.endsWith('h')) return val * 3600;
    if (period.endsWith('m')) return val * 60;
    if (period.endsWith('s')) return val;
    return 900;
  }

  private parseOffset(offset: string): number {
    const parts = offset.split(':').map(parseFloat);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return 0;
  }

  private checkSchedules() {
    const serverTime = Date.now() + this.binance.getTimeOffset();
    const serverSeconds = serverTime / 1000;

    // Stage 0
    const p0 = this.parsePeriod(this.settings.scanner.stage0Period);
    const o0 = this.parseOffset(this.settings.scanner.stage0StartTime) % p0;
    const block0 = Math.floor(serverSeconds / p0);
    const offset0 = serverSeconds % p0;
    const next0 = (block0 + (offset0 >= o0 ? 1 : 0)) * p0 * 1000 + o0 * 1000 - this.binance.getTimeOffset();
    this.scanTimes.stage0NextStart = next0;
    this.scanTimes.stage0Countdown = Math.max(0, Math.floor((next0 - Date.now()) / 1000));

    // Stage 0P
    const p0p = this.parsePeriod(this.settings.scanner.stage0PPeriod);
    const o0p = this.parseOffset(this.settings.scanner.stage0PStartTime) % p0p;
    const block0p = Math.floor(serverSeconds / p0p);
    const offset0p = serverSeconds % p0p;
    const next0p = (block0p + (offset0p >= o0p ? 1 : 0)) * p0p * 1000 + o0p * 1000 - this.binance.getTimeOffset();
    this.scanTimes.stage0PNextStart = next0p;
    this.scanTimes.stage0PCountdown = Math.max(0, Math.floor((next0p - Date.now()) / 1000));

    // Stage 1
    const p1 = this.parsePeriod(this.settings.scanner.stage1Period);
    const o1 = this.parseOffset(this.settings.scanner.stage1StartTime) % p1;
    const block1 = Math.floor(serverSeconds / p1);
    const offset1 = serverSeconds % p1;
    const next1 = (block1 + (offset1 >= o1 ? 1 : 0)) * p1 * 1000 + o1 * 1000 - this.binance.getTimeOffset();
    this.scanTimes.stage1NextStart = next1;
    this.scanTimes.stage1Countdown = Math.max(0, Math.floor((next1 - Date.now()) / 1000));

    // Stage 2
    const p2 = this.parsePeriod(this.settings.scanner.stage2Period);
    const o2 = this.parseOffset(this.settings.scanner.stage2StartTime) % p2;
    const block2 = Math.floor(serverSeconds / p2);
    const offset2 = serverSeconds % p2;
    const next2 = (block2 + (offset2 >= o2 ? 1 : 0)) * p2 * 1000 + o2 * 1000 - this.binance.getTimeOffset();
    this.scanTimes.stage2NextStart = next2;
    this.scanTimes.stage2Countdown = Math.max(0, Math.floor((next2 - Date.now()) / 1000));

    // Order
    const po = this.parsePeriod(this.settings.order.period);
    const oo = this.parseOffset(this.settings.order.startTime) % po;
    const blocko = Math.floor(serverSeconds / po);
    const offseto = serverSeconds % po;
    const nexto = (blocko + (offseto >= oo ? 1 : 0)) * po * 1000 + oo * 1000 - this.binance.getTimeOffset();
    this.scanTimes.orderNext = nexto;

    if (this.masterSwitch) {
      if (offset0 >= o0 && this.lastRunBlock.stage0 !== block0) {
        this.lastRunBlock.stage0 = block0;
        StorageService.addLog({ module: 'Scanner', type: 'scanner', message: '倒计时归零，执行强制扫零' });
        this.runStage0();
      }
      
      if (offset0p >= o0p && this.lastRunBlock.stage0P !== block0p) {
        this.lastRunBlock.stage0P = block0p;
        StorageService.addLog({ module: 'Scanner', type: 'scanner', message: '倒计时归零，执行第0阶段扫描' });
        this.runStage0P();
      }

      if (offset1 >= o1 && this.lastRunBlock.stage1 !== block1) {
        this.lastRunBlock.stage1 = block1;
        StorageService.addLog({ module: 'Scanner', type: 'scanner', message: '倒计时归零，执行强制扫一' });
        this.runStage1();
      }

      if (offset2 >= o2 && this.lastRunBlock.stage2 !== block2) {
        this.lastRunBlock.stage2 = block2;
        setTimeout(() => {
          StorageService.addLog({ module: 'Scanner', type: 'scanner', message: '倒计时归零，执行强制扫二' });
          this.runStage2();
        }, 2000);
      }

      if (this.bestSymbol && !this.bestSymbol.isProcessed && !this.activePosition) {
        const windowEnd = oo + this.settings.order.forwardOrderWindow;
        const symbolBlock = Math.floor((this.scanTimes.bestSelectionTime + this.binance.getTimeOffset()) / 1000 / po);
        
        if (symbolBlock === blocko) {
          if (offseto >= oo && offseto <= windowEnd) {
            if (this.lastRunBlock.order !== blocko) {
              this.lastRunBlock.order = blocko;
              StorageService.addLog({ 
                module: 'Order', 
                type: 'order', 
                message: `到达下单窗口期，执行下单: ${this.bestSymbol.symbol}` 
              });
              this.executeTrade(this.bestSymbol);
              this.bestSymbol.isProcessed = true;
              this.bestSymbol.processStatus = 'ordered';
            }
          } else if (offseto > windowEnd) {
            this.bestSymbol.isProcessed = true;
            this.bestSymbol.processStatus = 'missed';
          }
        } else if (symbolBlock < blocko) {
          this.bestSymbol.isProcessed = true;
          this.bestSymbol.processStatus = 'stale';
        }
      }
    }
    
    if (this.pendingSecondaryOrders && this.masterSwitch) {
      if (serverTime >= this.pendingSecondaryOrders.triggerTime) {
        const offsetClosed = serverSeconds % this.parsePeriod(this.settings.order.kClosedPeriod);
        if (offsetClosed >= this.settings.order.kClosedWindowStart && offsetClosed <= this.settings.order.kClosedWindowEnd) {
          const pending = this.pendingSecondaryOrders;
          this.pendingSecondaryOrders = null;
          this.placeSecondaryOrders(pending);
        }
      }
    }
    
    this.notifyUI();
  }

  private async refreshAccountInfo() {
    if (!this.masterSwitch) return;
    try {
      const info = await this.binance.getAccountInfo();
      if (!info) return;
      
      this.accountInfo = info;
      this.apiError = null;

      if (this.settings.email.enabled && this.settings.email.balanceLimitEnabled) {
        const balance = parseFloat(info.totalWalletBalance);
        if (balance >= this.settings.email.balanceLimit) {
          if (Date.now() - this.lastBalanceEmailTime > 3600000) {
            EmailService.sendNotification(this.settings).catch(console.error);
            this.lastBalanceEmailTime = Date.now();
          }
        }
      }
      
      const [orders, algoOrders] = await Promise.all([
        this.binance.getOpenOrders(),
        this.binance.getOpenAlgoOrders()
      ]);

      const active = info.positions.find((p: any) => parseFloat(p.positionAmt) !== 0);
      const prevActive = this.activePosition;

      if (active) {
        this.activePosition = {
          symbol: active.symbol,
          side: parseFloat(active.positionAmt) > 0 ? 'BUY' : 'SELL',
          amount: Math.abs(parseFloat(active.positionAmt)),
          leverage: parseInt(active.leverage),
          entryPrice: parseFloat(active.entryPrice),
          markPrice: parseFloat(active.markPrice),
          unrealizedProfit: parseFloat(active.unRealizedProfit),
          updateTime: Date.now(),
          entryTime: active.updateTime,
        };

        if (this.settings.order.maxHoldTime > 0) {
          const holdTimeMs = Date.now() - this.activePosition.entryTime;
          if (holdTimeMs > this.settings.order.maxHoldTime * 60000) {
            this.executeMarketClose();
          }
        }
      } else {
        if (prevActive) {
          await this.binance.cancelAllOrders(prevActive.symbol);
          await this.cancelAllAlgoOrders(prevActive.symbol);
          if (prevActive.unrealizedProfit < 0) {
            this.consecutiveReverseOrders++;
          } else {
            this.consecutiveReverseOrders = 0;
          }
        } else {
          const currentAlgoOrders = Array.isArray(algoOrders) ? algoOrders : (algoOrders?.orders || []);
          if (currentAlgoOrders.length > 0) {
            for (const o of currentAlgoOrders) {
              try { await this.binance.cancelAlgoOrder(o.algoId); } catch (e) {}
            }
          }
        }
        this.activePosition = null;
      }

      const standardOrders = orders.map((o: any) => ({
        symbol: o.symbol,
        orderId: o.orderId,
        side: o.side,
        type: o.type,
        amount: parseFloat(o.origQty),
        price: parseFloat(o.price || o.stopPrice || '0'),
        time: o.time,
      }));

      const algoOrdersList = Array.isArray(algoOrders) ? algoOrders : (algoOrders?.orders || []);
      const processedAlgoOrders = algoOrdersList.map((o: any) => ({
        symbol: o.symbol,
        orderId: o.algoId,
        side: o.side,
        type: `ALGO_${o.algoType}_${o.type}`,
        amount: parseFloat(o.quantity),
        price: parseFloat(o.stopPrice || o.triggerPrice || '0'),
        time: o.time,
      }));

      this.activeOrders = [...standardOrders, ...processedAlgoOrders];
      this.notifyUI();
      this.saveState();
    } catch (e: any) {
      console.error('[Server StrategyEngine] Failed to refresh account info', e.message);
      this.apiError = e.message;
      this.notifyUI();
    }
  }

  private async handleWSMessage(data: any) {
    this.lastWSMessageTime = Date.now();

    if (data.e === 'ACCOUNT_UPDATE' || data.e === 'ORDER_TRADE_UPDATE') {
      await this.refreshAccountInfo();
    }

    if (data.e === 'kline') {
      const symbol = data.s.toLowerCase();
      const k = data.k;
      
      if (symbol === 'btcusdt' && k.i === '15m') {
        this.btcData = k;
      }
      
      if (k.i === '5m') {
        if (k.x || !this.stage2Data.has(symbol)) {
          this.stage2Data.set(symbol, k);
        }
      } else if (k.i === '15m') {
        const prev = this.stage2Data15m.get(symbol);
        if (prev && prev.t !== k.t) {
          this.stage2Data15mClosed.set(symbol, prev);
        }
        this.stage2Data15m.set(symbol, k);
        if (k.x) {
          this.stage2Data15mClosed.set(symbol, k);
        }
      }

      if (this.activePosition && this.activePosition.symbol.toLowerCase() === symbol) {
        const currentPrice = parseFloat(k.c);
        this.activePosition.markPrice = currentPrice;
        this.activePosition.updateTime = Date.now();
        const diff = this.activePosition.side === 'BUY' 
          ? (currentPrice - this.activePosition.entryPrice) 
          : (this.activePosition.entryPrice - currentPrice);
        this.activePosition.unrealizedProfit = diff * this.activePosition.amount;
      }
      
      this.notifyUI();
    }
  }

  private async executeMarketClose() {
    if (!this.activePosition || this.isExecutingMarketClose) return;
    this.isExecutingMarketClose = true;
    const symbol = this.activePosition.symbol;
    const amount = this.activePosition.amount;
    const leverage = this.activePosition.leverage;

    try {
      await this.binance.setLeverage(symbol, leverage);
      await this.binance.createOrder({
        symbol,
        side: 'SELL',
        type: 'MARKET',
        quantity: this.formatQuantity(symbol, amount),
        positionSide: 'BOTH'
      });
      await this.binance.cancelAllOrders(symbol);
      await this.cancelAllAlgoOrders(symbol);
      this.activePosition = null;
      this.isExecutingMarketClose = false;
      this.refreshAccountInfo();
    } catch (e: any) {
      this.isExecutingMarketClose = false;
      StorageService.addLog({ module: 'Order', type: 'error', message: `市价平仓执行失败: ${e.message}` });
    }
  }

  private async cancelAllAlgoOrders(symbol: string) {
    try {
      const algoOrders = await this.binance.getOpenAlgoOrders(symbol);
      const orders = Array.isArray(algoOrders) ? algoOrders : (algoOrders.orders || []);
      for (const order of orders) {
        await this.binance.cancelAlgoOrder(order.algoId);
      }
    } catch (e: any) {}
  }

  private formatPrice(symbol: string, price: number): string {
    const info = this.symbolInfo.get(symbol);
    if (!info) return (price || 0).toString();
    const filter = info.filters?.find((f: any) => f.filterType === 'PRICE_FILTER');
    if (filter && filter.tickSize) {
      const tickSize = parseFloat(filter.tickSize);
      const precision = filter.tickSize.indexOf('.') > -1 ? filter.tickSize.split('.')[1].length : 0;
      const rounded = Math.round(price / tickSize) * tickSize;
      return rounded?.toFixed(precision);
    }
    return price?.toFixed(info.pricePrecision || 8);
  }

  private formatQuantity(symbol: string, qty: number): string {
    const info = this.symbolInfo.get(symbol);
    if (!info) return (qty || 0).toString();
    const filter = info.filters?.find((f: any) => f.filterType === 'LOT_SIZE');
    if (filter && filter.stepSize) {
      const stepSize = parseFloat(filter.stepSize);
      const precision = filter.stepSize.indexOf('.') > -1 ? filter.stepSize.split('.')[1].length : 0;
      const rounded = Math.floor(qty / stepSize + 0.0000001) * stepSize;
      return rounded?.toFixed(precision);
    }
    return qty?.toFixed(info.quantityPrecision || 8);
  }

  public async runStage0() {
    if (!this.masterSwitch || this.isScanning.stage0) return;
    this.isScanning.stage0 = true;
    this.isScanning.stage0Progress = 0;
    this.scanTimes.stage0LastStart = Date.now();
    this.notifyUI();

    try {
      const exchangeInfo = await this.binance.getExchangeInfo();
      this.isScanning.stage0Progress = 50;
      const serverTime = Date.now() + this.binance.getTimeOffset();
      const results: string[] = [];
      const customMinutes = this.settings.scanner.stage0CustomMinutes || 15;
      const intervalMs = customMinutes * 60 * 1000;

      exchangeInfo.symbols.forEach((s: any) => {
        if (s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL' && s.status === 'TRADING') {
          const onboardDate = s.onboardDate;
          if (onboardDate && onboardDate > 0) {
            const kCount = Math.floor((serverTime - onboardDate) / intervalMs);
            if (kCount >= this.settings.scanner.stage0KCountMin && kCount <= this.settings.scanner.stage0KCountMax) {
              results.push(s.symbol);
            }
          } else {
            results.push(s.symbol);
          }
        }
      });

      results.sort();
      this.stage0Results = results;
      this.scanTimes.stage0Duration = Date.now() - this.scanTimes.stage0LastStart;
      this.saveState();
      if (!this.settings.scanner.stage0PEnabled) {
        this.stage0PResults = [...results];
        this.stage0PReasons.clear();
      }
    } catch (e: any) {
      StorageService.addLog({ module: 'Scanner', type: 'error', message: `全市场扫描失败: ${e.message}` });
    } finally {
      this.isScanning.stage0 = false;
      this.isScanning.stage0Progress = 100;
      this.notifyUI();
    }
  }

  public async runStage0P() {
    if (!this.masterSwitch || this.isScanning.stage0P) return;
    if (!this.settings.scanner.stage0PEnabled) {
      this.stage0PResults = [...this.stage0Results];
      this.stage0PReasons.clear();
      this.notifyUI();
      return;
    }
    this.isScanning.stage0P = true;
    this.isScanning.stage0PProgress = 0;
    this.scanTimes.stage0PLastStart = Date.now();
    this.notifyUI();

    try {
      const targets = [...this.stage0Results];
      const results: string[] = [];
      const reasons: Map<string, string> = new Map();
      const total = targets.length;
      for (let i = 0; i < targets.length; i += 20) {
        const batch = targets.slice(i, i + 20);
        await Promise.all(batch.map(async (symbol) => {
          try {
            let isOk = true;
            let reason = '';
            if (this.settings.scanner.stage0P15mEnabled) {
              const klines = await this.binance.getKLines(symbol, '15m', this.settings.scanner.stage0P15mCount + 1);
              for (const k of klines.slice(0, -1)) {
                const change = Math.abs(((parseFloat(k[4]) - parseFloat(k[1])) / parseFloat(k[1])) * 100);
                if (change >= this.settings.scanner.stage0P15mRef) { isOk = false; reason = `15m涨跌幅 ${change.toFixed(2)}%`; break; }
              }
            }
            if (isOk && this.settings.scanner.stage0P1hEnabled) {
              const klines = await this.binance.getKLines(symbol, '1h', this.settings.scanner.stage0P1hCount + 1);
              for (const k of klines.slice(0, -1)) {
                const change = Math.abs(((parseFloat(k[4]) - parseFloat(k[1])) / parseFloat(k[1])) * 100);
                if (change >= this.settings.scanner.stage0P1hRef) { isOk = false; reason = `1h涨跌幅 ${change.toFixed(2)}%`; break; }
              }
            }
            if (isOk) results.push(symbol); else reasons.set(symbol, reason);
          } catch (e) {}
        }));
        this.isScanning.stage0PProgress = Math.min(100, ((i + 20) / total) * 100);
        this.notifyUI();
      }
      results.sort();
      this.stage0PResults = results;
      this.stage0PReasons = reasons;
      this.scanTimes.stage0PDuration = Date.now() - this.scanTimes.stage0PLastStart;
      this.saveState();
    } catch (e: any) {
      StorageService.addLog({ module: 'Scanner', type: 'error', message: `第0阶段扫描失败: ${e.message}` });
    } finally {
      this.isScanning.stage0P = false;
      this.isScanning.stage0PProgress = 100;
      this.notifyUI();
    }
  }

  public async runStage1() {
    if (!this.masterSwitch || this.isScanning.stage1) return;
    this.bestSymbol = null;
    this.isScanning.stage1 = true;
    this.isScanning.stage1Progress = 0;
    this.scanTimes.stage1LastStart = Date.now();
    this.notifyUI();

    try {
      const whitelist = this.settings.scanner.whitelist.split(' ').filter(s => s);
      const blacklist = this.settings.scanner.blacklist.split(' ').filter(s => s);
      let targets = [...this.stage0PResults];
      if (whitelist.length > 0) targets = [...new Set([...targets, ...whitelist])];
      targets = targets.filter(s => !blacklist.includes(s));
      const results: string[] = [];
      const total = targets.length;
      for (let i = 0; i < targets.length; i += 20) {
        const batch = targets.slice(i, i + 20);
        await Promise.all(batch.map(async (symbol: string) => {
          try {
            const klines = await this.binance.getKLines(symbol, this.settings.scanner.stage1Period, 1);
            if (klines.length > 0) {
              const [time, open, high, low, close, volume, closeTime, quoteVolume] = klines[0];
              const km1 = parseFloat(quoteVolume);
              const k1 = ((parseFloat(close) - parseFloat(open)) / parseFloat(open)) * 100;
              let match = true;
              if (this.settings.scanner.stage1Cond1Enabled && km1 < this.settings.scanner.stage1MinVolume) match = false;
              if (this.settings.scanner.stage1Cond2Enabled && (k1 < this.settings.scanner.stage1KLineMin || k1 > this.settings.scanner.stage1KLineMax)) match = false;
              if (match) results.push(symbol);
            }
          } catch (e) {}
        }));
        this.isScanning.stage1Progress = Math.min(100, ((i + 20) / total) * 100);
        this.notifyUI();
      }
      results.sort();
      this.stage1Results = results;
      this.scanTimes.stage1Duration = Date.now() - this.scanTimes.stage1LastStart;
      this.saveState();
      this.updateSubscriptions();
      await this.binance.syncTime();
    } catch (e: any) {
      StorageService.addLog({ module: 'Scanner', type: 'error', message: `第一阶段扫描失败: ${e.message}` });
    } finally {
      this.isScanning.stage1 = false;
      this.notifyUI();
    }
  }

  public async runStage2() {
    if (!this.masterSwitch || this.isScanning.stage2) return;
    this.isScanning.stage2 = true;
    this.isScanning.stage2Progress = 0;
    this.scanTimes.stage2LastStart = Date.now();
    this.notifyUI();

    try {
      const candidates: any[] = [];
      const failed: any[] = [];
      const total = this.stage1Results.length;
      let processed = 0;
      for (const symbol of this.stage1Results) {
        processed++;
        this.isScanning.stage2Progress = (processed / total) * 100;
        const k5 = this.stage2Data.get(symbol.toLowerCase());
        const k15 = this.stage2Data15m.get(symbol.toLowerCase());
        const k15Closed = this.stage2Data15mClosed.get(symbol.toLowerCase());
        if (!k5 || !k15) { failed.push({ symbol, reason: '无K线数据' }); continue; }
        const k5Change = ((parseFloat(k5.c) - parseFloat(k5.o)) / parseFloat(k5.o)) * 100;
        const kAbsChange = ((parseFloat(k15.c) - parseFloat(k15.o)) / parseFloat(k15.o)) * 100;
        const aChange = ((parseFloat(k15.h) - parseFloat(k15.c)) / parseFloat(k15.c)) * 100;
        const volume = parseFloat(k15.q);
        let match = true;
        if (this.settings.scanner.stage2Cond1Enabled && (kAbsChange < this.settings.scanner.stage2K21 || kAbsChange > this.settings.scanner.stage2K22)) match = false;
        const lastTrade = this.cooldowns.get(symbol) || 0;
        if (Date.now() - lastTrade < this.settings.scanner.stage2Cooldown * 60000) { failed.push({ symbol, reason: '冷却中' }); continue; }
        const coinData = { symbol, volume, price: k15Closed ? parseFloat(k15Closed.c) : parseFloat(k15.o), k5Change, k15Change: kAbsChange, aChange };
        if (match) candidates.push(coinData); else failed.push({ ...coinData, reason: '不匹配' });
      }
      candidates.sort((a, b) => b.volume - a.volume);
      this.stage2Results = candidates;
      this.stage2Failed = failed;
      this.scanTimes.stage2Duration = Date.now() - this.scanTimes.stage2LastStart;
      if (candidates.length > 0) {
        this.bestSymbol = candidates[0];
        this.scanTimes.bestSelectionTime = Date.now();
      }
    } catch (e: any) {
      StorageService.addLog({ module: 'Scanner', type: 'error', message: `第二阶段扫描失败: ${e.message}` });
    } finally {
      this.isScanning.stage2 = false;
      this.isScanning.stage2Progress = 100;
      this.notifyUI();
    }
  }

  private async placeSecondaryOrders(pending: any) {
    try {
      const { symbol, quantity, targetOpenTime } = pending;
      const klines = await this.binance.getKLines(symbol, this.settings.order.kClosedPeriod as any, 5);
      const finalK = klines.find((k: any) => k[0] === targetOpenTime) || klines[klines.length - 2];
      const kOpen = parseFloat(finalK[1]);
      const kClose = parseFloat(finalK[4]);
      const k15Abs = Math.abs(((kClose - kOpen) / kOpen) * 100);
      const tpPrice = kClose * (1 + (k15Abs * this.settings.order.takeProfitRatio) / 10000);
      const slPrice = kClose * (1 - (k15Abs * this.settings.order.stopLossRatio) / 10000);
      await this.binance.createOrder({ symbol, side: 'SELL', type: 'LIMIT', quantity, price: this.formatPrice(symbol, tpPrice), reduceOnly: 'true' });
      await this.binance.createAlgoOrder({ symbol, side: 'SELL', algoType: 'CONDITIONAL', type: 'STOP_MARKET', stopPrice: this.formatPrice(symbol, slPrice), triggerPrice: this.formatPrice(symbol, slPrice), quantity, reduceOnly: 'true' });
      this.refreshAccountInfo();
    } catch (e: any) {
      StorageService.addLog({ module: 'Order', type: 'error', message: `二次下单失败: ${e.message}` });
    }
  }

  private async executeTrade(best: any) {
    if (this.activePosition) return;
    try {
      const symbol = best.symbol;
      const balance = parseFloat(this.accountInfo?.totalWalletBalance || '0');
      const qty = this.formatQuantity(symbol, (Math.min(balance * this.settings.order.leverage * this.settings.order.positionRatio, this.settings.order.maxPositionAmount)) / best.price);
      await this.binance.setLeverage(symbol, this.settings.order.leverage);
      const order = await this.binance.createOrder({ symbol, side: 'BUY', type: 'MARKET', quantity: qty });
      const entryPrice = order.avgPrice ? parseFloat(order.avgPrice) : best.price;
      this.activePosition = { symbol, side: 'BUY', amount: parseFloat(qty), leverage: this.settings.order.leverage, entryPrice, markPrice: entryPrice, unrealizedProfit: 0, updateTime: Date.now(), entryTime: Date.now() };
      const periodSec = this.parsePeriod(this.settings.order.kClosedPeriod);
      const targetOpenTimeSec = Math.floor((Date.now() / 1000 - 180) / periodSec) * periodSec;
      this.pendingSecondaryOrders = { symbol, entryPrice, quantity: qty, targetOpenTime: targetOpenTimeSec * 1000, triggerTime: (targetOpenTimeSec + periodSec) * 1000 + 200, kClosedPeriod: this.settings.order.kClosedPeriod };
      this.cooldowns.set(symbol, Date.now());
      this.saveState();
    } catch (e: any) {
      StorageService.addLog({ module: 'Order', type: 'error', message: `下单失败: ${e.message}` });
    }
  }

  private saveState() {
    StorageService.saveState({
      stage0Results: this.stage0Results,
      stage0PResults: this.stage0PResults,
      stage1Results: this.stage1Results,
      cooldowns: Object.fromEntries(this.cooldowns),
      activePosition: this.activePosition,
      consecutiveReverseOrders: this.consecutiveReverseOrders
    });
  }

  private notifyUI() {
    if (this.isStopped) return;
    this.onUpdate({
      stage0Results: this.stage0Results,
      stage0PResults: this.stage0PResults,
      stage0PReasons: Object.fromEntries(this.stage0PReasons),
      stage1Results: this.stage1Results,
      stage2Results: this.stage2Results,
      stage2Failed: this.stage2Failed,
      activePosition: this.activePosition,
      activeOrders: this.activeOrders,
      accountInfo: this.accountInfo,
      btcData: this.btcData,
      wsStatus: this.ws.status,
      wsError: this.wsError,
      lastWSMessageTime: this.lastWSMessageTime,
      apiError: this.apiError,
      ip: this.ip,
      scanTimes: this.scanTimes,
      bestSymbol: this.bestSymbol,
      isScanning: this.isScanning
    });
  }

  async updateSettings(settings: AppSettings) {
    this.settings = settings;
    this.masterSwitch = settings.masterSwitch;
    this.binance = new BinanceService(settings.binance.apiKey, settings.binance.secretKey, settings.binance.baseUrl);
    this.ws.setUrl(settings.binance.wsUrl);
    if (this.masterSwitch) {
      await this.binance.syncTime();
      await this.refreshAccountInfo();
    }
  }

  setMasterSwitch(val: boolean) {
    const prev = this.masterSwitch;
    this.masterSwitch = val;
    this.settings.masterSwitch = val;
    StorageService.saveSettings(this.settings);
    if (val && !prev) {
      this.initializeStrategy();
    } else if (!val && prev) {
      this.ws.close();
      if (this.listenKeyTimer) clearInterval(this.listenKeyTimer);
      this.listenKeyTimer = null;
      this.listenKey = null;
      this.notifyUI();
    }
  }

  async forceRunStage0() {
    await this.runStage0();
  }

  async forceRunStage0P() {
    await this.runStage0P();
  }

  async forceRunStage1() {
    await this.runStage1();
  }

  async forceRunStage2() {
    await this.runStage2();
  }
}
