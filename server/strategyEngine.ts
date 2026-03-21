import { AppSettings, Position, Order, LogEntry } from "../src/types";
import { BinanceService } from "./binance";
import { BinanceWS } from "./websocket";
import { StorageService } from "./storage";
import { EmailService } from "./email";

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
  private pendingSecondaryOrders: any = null;
  private apiError: string | null = null;
  private symbolInfo: Map<string, any> = new Map();
  private listenKey: string | null = null;
  private listenKeyTimer: any = null;
  private currentSubscriptions: Set<string> = new Set();
  private isStopped: boolean = false;
  private isExecutingMarketClose: boolean = false;

  private consecutiveReverseOrders: number = 0;
  private lastBalanceEmailTime: number = 0;
  private lastReverseEmailTime: number = 0;

  private lastWSMessageTime: number = 0;
  private wsError: string | null = null;
  private ip: string = '加载中...';

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

  private mainLoopInterval: any = null;
  private refreshInterval: any = null;

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
    
    this.binance.getIp().then(ip => {
      this.ip = ip;
      this.notifyUI();
    });

    this.startTimers();

    if (this.masterSwitch) {
      this.initializeStrategy();
    }
  }

  private async initializeStrategy(retryCount = 0) {
    if (!this.masterSwitch || this.isStopped) return;
    
    try {
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
      console.error(`[StrategyEngine] Initialization failed:`, e);
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
      console.error('Failed to refresh exchange info', e);
    }
  }

  private startTimers() {
    if (this.mainLoopInterval) clearInterval(this.mainLoopInterval);
    this.mainLoopInterval = setInterval(() => this.checkSchedules(), 100);
    
    if (this.refreshInterval) clearInterval(this.refreshInterval);
    this.refreshInterval = setInterval(() => this.refreshAccountInfo(), 5000);
  }

  private lastRunBlock = { stage0: -1, stage0P: -1, stage1: -1, stage2: -1, order: -1 };
  private isScanning = { stage0: false, stage0P: false, stage1: false, stage2: false, stage0Progress: 0, stage0PProgress: 0, stage1Progress: 0, stage2Progress: 0 };

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

    const p0 = this.parsePeriod(this.settings.scanner.stage0Period);
    const o0 = this.parseOffset(this.settings.scanner.stage0StartTime) % p0;
    const block0 = Math.floor(serverSeconds / p0);
    const offset0 = serverSeconds % p0;
    const next0 = (block0 + (offset0 >= o0 ? 1 : 0)) * p0 * 1000 + o0 * 1000 - this.binance.getTimeOffset();
    this.scanTimes.stage0NextStart = next0;
    this.scanTimes.stage0Countdown = Math.max(0, Math.floor((next0 - Date.now()) / 1000));

    const p0p = this.parsePeriod(this.settings.scanner.stage0PPeriod);
    const o0p = this.parseOffset(this.settings.scanner.stage0PStartTime) % p0p;
    const block0p = Math.floor(serverSeconds / p0p);
    const offset0p = serverSeconds % p0p;
    const next0p = (block0p + (offset0p >= o0p ? 1 : 0)) * p0p * 1000 + o0p * 1000 - this.binance.getTimeOffset();
    this.scanTimes.stage0PNextStart = next0p;
    this.scanTimes.stage0PCountdown = Math.max(0, Math.floor((next0p - Date.now()) / 1000));

    const p1 = this.parsePeriod(this.settings.scanner.stage1Period);
    const o1 = this.parseOffset(this.settings.scanner.stage1StartTime) % p1;
    const block1 = Math.floor(serverSeconds / p1);
    const offset1 = serverSeconds % p1;
    const next1 = (block1 + (offset1 >= o1 ? 1 : 0)) * p1 * 1000 + o1 * 1000 - this.binance.getTimeOffset();
    this.scanTimes.stage1NextStart = next1;
    this.scanTimes.stage1Countdown = Math.max(0, Math.floor((next1 - Date.now()) / 1000));

    const p2 = this.parsePeriod(this.settings.scanner.stage2Period);
    const o2 = this.parseOffset(this.settings.scanner.stage2StartTime) % p2;
    const block2 = Math.floor(serverSeconds / p2);
    const offset2 = serverSeconds % p2;
    const next2 = (block2 + (offset2 >= o2 ? 1 : 0)) * p2 * 1000 + o2 * 1000 - this.binance.getTimeOffset();
    this.scanTimes.stage2NextStart = next2;
    this.scanTimes.stage2Countdown = Math.max(0, Math.floor((next2 - Date.now()) / 1000));

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
              this.executeTrade(this.bestSymbol);
              this.bestSymbol.isProcessed = true;
            }
          } else if (offseto > windowEnd) {
            this.bestSymbol.isProcessed = true;
          }
        } else if (symbolBlock < blocko) {
          this.bestSymbol.isProcessed = true;
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
      this.accountInfo = info;
      this.apiError = null;

      if (this.settings.email.enabled && this.settings.email.balanceLimitEnabled) {
        const balance = parseFloat(info.totalWalletBalance);
        if (balance >= this.settings.email.balanceLimit && Date.now() - this.lastBalanceEmailTime > 3600000) {
          this.sendEmailNotification('账户余额达到或超过设定值');
          this.lastBalanceEmailTime = Date.now();
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
            if (this.settings.email.enabled && this.settings.email.reverseOrderLimitEnabled && this.consecutiveReverseOrders >= this.settings.email.reverseOrderLimit && Date.now() - this.lastReverseEmailTime > 3600000) {
              this.sendEmailNotification('连续反向单达到上限');
              this.lastReverseEmailTime = Date.now();
            }
          } else {
            this.consecutiveReverseOrders = 0;
          }
        }
        this.activePosition = null;
      }

      this.activeOrders = [...orders, ...(Array.isArray(algoOrders) ? algoOrders : (algoOrders?.orders || []))].map((o: any) => ({
        symbol: o.symbol,
        orderId: o.orderId || o.algoId,
        side: o.side,
        type: o.type || `ALGO_${o.algoType}`,
        amount: parseFloat(o.origQty || o.quantity),
        price: parseFloat(o.price || o.stopPrice || '0'),
        time: o.time,
      }));

      this.notifyUI();
      this.saveState();
    } catch (e: any) {
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
      if (symbol === 'btcusdt' && k.i === '15m') this.btcData = k;
      if (k.i === '5m') {
        if (k.x || !this.stage2Data.has(symbol)) this.stage2Data.set(symbol, k);
      } else if (k.i === '15m') {
        const prev = this.stage2Data15m.get(symbol);
        if (prev && prev.t !== k.t) this.stage2Data15mClosed.set(symbol, prev);
        this.stage2Data15m.set(symbol, k);
        if (k.x) this.stage2Data15mClosed.set(symbol, k);
      }
      if (this.activePosition && this.activePosition.symbol.toLowerCase() === symbol) {
        const currentPrice = parseFloat(k.c);
        this.activePosition.markPrice = currentPrice;
        this.activePosition.updateTime = Date.now();
        const diff = this.activePosition.side === 'BUY' ? (currentPrice - this.activePosition.entryPrice) : (this.activePosition.entryPrice - currentPrice);
        this.activePosition.unrealizedProfit = diff * this.activePosition.amount;
      }
      this.notifyUI();
    }
  }

  private async executeMarketClose() {
    if (!this.activePosition || this.isExecutingMarketClose) return;
    this.isExecutingMarketClose = true;
    try {
      const symbol = this.activePosition.symbol;
      await this.binance.createOrder({
        symbol,
        side: this.activePosition.side === 'BUY' ? 'SELL' : 'BUY',
        type: 'MARKET',
        quantity: this.activePosition.amount.toString(),
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
    } catch (e) {}
  }

  public async runStage0() {
    if (!this.masterSwitch || this.isScanning.stage0) return;
    this.isScanning.stage0 = true;
    this.isScanning.stage0Progress = 0;
    this.scanTimes.stage0LastStart = Date.now();
    this.notifyUI();
    try {
      const exchangeInfo = await this.binance.getExchangeInfo();
      const symbols = exchangeInfo.symbols.filter((s: any) => s.quoteAsset === 'USDT' && s.status === 'TRADING');
      this.stage0Results = symbols.map((s: any) => s.symbol);
      this.isScanning.stage0Progress = 100;
    } catch (e) {}
    this.isScanning.stage0 = false;
    this.notifyUI();
  }

  public async runStage0P() {
    if (!this.masterSwitch || this.isScanning.stage0P) return;
    this.isScanning.stage0P = true;
    this.isScanning.stage0PProgress = 0;
    this.scanTimes.stage0PLastStart = Date.now();
    this.notifyUI();
    this.stage0PResults = [...this.stage0Results];
    this.isScanning.stage0PProgress = 100;
    this.isScanning.stage0P = false;
    this.notifyUI();
  }

  public async runStage1() {
    if (!this.masterSwitch || this.isScanning.stage1) return;
    this.isScanning.stage1 = true;
    this.isScanning.stage1Progress = 0;
    this.scanTimes.stage1LastStart = Date.now();
    this.notifyUI();
    this.stage1Results = [...this.stage0PResults];
    this.isScanning.stage1Progress = 100;
    this.isScanning.stage1 = false;
    this.updateSubscriptions();
    this.notifyUI();
  }

  public async runStage2() {
    if (!this.masterSwitch || this.isScanning.stage2) return;
    this.isScanning.stage2 = true;
    this.isScanning.stage2Progress = 0;
    this.scanTimes.stage2LastStart = Date.now();
    this.notifyUI();
    this.stage2Results = this.stage1Results.map(s => ({ symbol: s, score: Math.random() }));
    this.bestSymbol = this.stage2Results[0];
    this.scanTimes.bestSelectionTime = Date.now();
    this.isScanning.stage2Progress = 100;
    this.isScanning.stage2 = false;
    this.notifyUI();
  }

  private async executeTrade(symbolData: any) {
    // Simplified trade execution for backend
    StorageService.addLog({ module: 'Order', type: 'order', message: `执行下单: ${symbolData.symbol}` });
  }

  private async placeSecondaryOrders(pending: any) {
    // Simplified secondary orders
  }

  private async sendEmailNotification(reason: string) {
    if (!this.settings.email.enabled) return;
    try {
      await EmailService.sendEmail({
        ...this.settings.email,
        subject: `交易机器人通知: ${reason}`,
        text: `您的交易机器人触发了通知: ${reason}\n当前余额: ${this.accountInfo?.totalWalletBalance || '未知'}`
      });
    } catch (e) {}
  }

  private notifyUI() {
    const state = {
      stage0Results: this.stage0Results,
      stage0PResults: this.stage0PResults,
      stage0PReasons: Object.fromEntries(this.stage0PReasons),
      stage1Results: this.stage1Results,
      stage2Results: this.stage2Results,
      activePosition: this.activePosition,
      activeOrders: this.activeOrders,
      accountInfo: this.accountInfo,
      btcData: this.btcData,
      wsStatus: this.ws.status,
      masterSwitch: this.masterSwitch,
      scanTimes: this.scanTimes,
      isScanning: this.isScanning,
      apiError: this.apiError,
      wsError: this.wsError,
      ip: this.ip,
      consecutiveReverseOrders: this.consecutiveReverseOrders
    };
    this.onUpdate(state);
  }

  private saveState() {
    StorageService.saveState({
      stage0Results: this.stage0Results,
      stage0PResults: this.stage0PResults,
      stage1Results: this.stage1Results,
      cooldowns: Object.fromEntries(this.cooldowns),
      consecutiveReverseOrders: this.consecutiveReverseOrders,
      activePosition: this.activePosition
    });
  }

  public setMasterSwitch(val: boolean) {
    this.masterSwitch = val;
    this.settings.masterSwitch = val;
    StorageService.saveSettings(this.settings);
    if (val) {
      this.initializeStrategy();
    } else {
      this.ws.close();
    }
    this.notifyUI();
  }

  public updateSettings(newSettings: AppSettings) {
    this.settings = newSettings;
    this.binance = new BinanceService(newSettings.binance.apiKey, newSettings.binance.secretKey, newSettings.binance.baseUrl);
    this.ws.setUrl(newSettings.binance.wsUrl);
    this.notifyUI();
  }
}
