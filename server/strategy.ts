import { BinanceService } from '../src/services/binance';
import { SupabaseService } from '../src/services/supabase';
import { BackendStorage } from './storage';
import { BinanceWS } from './websocket';
import { AppSettings, LogEntry } from '../src/types';

export class BackendStrategyEngine {
  private settings: AppSettings;
  private binance: BinanceService;
  private ws: BinanceWS;
  private masterSwitch: boolean = false;
  private onUpdate: (state: any) => void;
  private onLog: (log: LogEntry) => void;

  private stage0Results: string[] = [];
  private stage0PResults: string[] = [];
  private stage0PReasons: Map<string, string> = new Map();
  private stage1Results: string[] = [];
  private stage2Results: any[] = [];
  private stage2Failed: any[] = [];
  private bestSymbol: any = null;

  private stage2Data: Map<string, any> = new Map();
  private stage2Data15m: Map<string, any> = new Map();
  private stage2Data15mClosed: Map<string, any> = new Map();
  private btcData: any = null;

  private activePosition: any = null;
  private activeOrders: any[] = [];
  private accountInfo: any = null;
  private listenKey: string | null = null;
  private listenKeyTimer: any = null;

  private isScanning = { stage0: false, stage0P: false, stage1: false, stage2: false, stage0Progress: 0, stage0PProgress: 0, stage1Progress: 0, stage2Progress: 0 };
  private scanTimes = { stage0Duration: 0, stage0PDuration: 0, stage1Duration: 0, stage2Duration: 0, stage0LastStart: 0, stage0PLastStart: 0, stage1LastStart: 0, stage2LastStart: 0, stage0NextStart: 0, stage0PNextStart: 0, stage1NextStart: 0, stage2NextStart: 0, stage0Countdown: 0, stage0PCountdown: 0, stage1Countdown: 0, stage2Countdown: 0, orderNext: 0, bestSelectionTime: 0 };

  private cooldowns: Map<string, number> = new Map();
  private pendingSecondaryOrders: any = null;
  private consecutiveReverseOrders: number = 0;

  private wsError: string | null = null;
  private apiError: string | null = null;
  private lastWSMessageTime: number = 0;
  private ip: string = '加载中...';
  private isStopped: boolean = false;

  constructor(settings: AppSettings, onUpdate: (state: any) => void, onLog: (log: LogEntry) => void) {
    this.settings = settings;
    this.onUpdate = onUpdate;
    this.onLog = onLog;
    this.masterSwitch = settings.masterSwitch;

    this.binance = new BinanceService(settings.binance.apiKey, settings.binance.secretKey, settings.binance.baseUrl);
    this.binance.setIpSelection(settings.ipSelection);

    this.ws = new BinanceWS(settings.binance.wsUrl, (data) => this.handleWSMessage(data));

    // Load saved state
    const saved = BackendStorage.getState();
    if (saved) {
      this.stage0Results = saved.stage0Results || [];
      this.stage0PResults = saved.stage0PResults || [];
      this.stage1Results = saved.stage1Results || [];
      this.cooldowns = new Map(Object.entries(saved.cooldowns || {}));
      this.activePosition = saved.activePosition || null;
      this.consecutiveReverseOrders = saved.consecutiveReverseOrders || 0;
    }
  }

  public async start() {
    console.log('[Backend Engine] Starting...');
    this.isStopped = false;
    
    // Fetch IP
    this.binance.getIp().then(ip => {
      this.ip = ip;
      this.notifyUI();
    });

    // Initial sync
    await this.binance.syncTime();
    
    if (this.masterSwitch) {
      this.setMasterSwitch(true);
    }

    // Start schedule checker
    setInterval(() => this.checkSchedules(), 1000);
    
    // Start account refresh loop
    setInterval(() => {
      if (this.masterSwitch) this.refreshAccountInfo();
    }, 30000);

    this.notifyUI();
  }

  private async checkSchedules() {
    if (!this.masterSwitch || this.isStopped) return;

    const serverTime = Date.now() + this.binance.getTimeOffset();
    const now = new Date(serverTime);
    const seconds = now.getSeconds();
    const ms = now.getMilliseconds();
    const timeStr = now.toTimeString().split(' ')[0]; // HH:MM:SS

    // Stage 0: Every hour at stage0StartTime
    if (timeStr.endsWith(this.settings.scanner.stage0StartTime) && !this.isScanning.stage0) {
      this.runStage0();
    }

    // Stage 0P: Every stage0PPeriod at stage0PStartTime
    if (this.isTimeMatch(serverTime, this.settings.scanner.stage0PPeriod, this.settings.scanner.stage0PStartTime)) {
      this.runStage0P();
    }

    // Stage 1: Every stage1Period at stage1StartTime
    if (this.isTimeMatch(serverTime, this.settings.scanner.stage1Period, this.settings.scanner.stage1StartTime)) {
      this.runStage1();
    }

    // Stage 2: Every stage2Period at stage2StartTime
    if (this.isTimeMatch(serverTime, this.settings.scanner.stage2Period, this.settings.scanner.stage2StartTime)) {
      this.runStage2();
    }

    // Order Execution: Every order.period at order.startTime
    if (this.isTimeMatch(serverTime, this.settings.order.period, this.settings.order.startTime)) {
      if (this.bestSymbol && !this.bestSymbol.isProcessed) {
        this.executeTrade(this.bestSymbol);
      }
    }

    // Secondary Orders (TP/SL)
    if (this.pendingSecondaryOrders && serverTime >= this.pendingSecondaryOrders.triggerTime) {
      const pending = this.pendingSecondaryOrders;
      this.pendingSecondaryOrders = null;
      this.placeSecondaryOrders(pending);
    }

    // Update countdowns
    this.updateCountdowns(serverTime);
    this.notifyUI();
  }

  private isTimeMatch(serverTime: number, period: string, startTimeStr: string): boolean {
    const periodMs = this.parsePeriod(period) * 1000;
    const offsetMs = this.parseStartTime(startTimeStr);
    const currentCycleStart = Math.floor(serverTime / periodMs) * periodMs;
    const targetTime = currentCycleStart + offsetMs;
    
    // Match within 1 second window
    return Math.abs(serverTime - targetTime) < 1000 && serverTime >= targetTime;
  }

  private parsePeriod(p: string): number {
    const num = parseInt(p);
    if (p.endsWith('m')) return num * 60;
    if (p.endsWith('h')) return num * 3600;
    if (p.endsWith('d')) return num * 86400;
    return 60;
  }

  private parseStartTime(s: string): number {
    // Format: HH:MM:SS.mmm or MM:SS.mmm or SS.mmm
    const parts = s.split(':');
    let ms = 0;
    if (parts.length === 3) {
      ms = (parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2])) * 1000;
    } else if (parts.length === 2) {
      ms = (parseInt(parts[0]) * 60 + parseFloat(parts[1])) * 1000;
    } else {
      ms = parseFloat(parts[0]) * 1000;
    }
    return ms;
  }

  private updateCountdowns(serverTime: number) {
    const update = (period: string, start: string) => {
      const p = this.parsePeriod(period) * 1000;
      const s = this.parseStartTime(start);
      const next = Math.ceil((serverTime - s) / p) * p + s;
      return { next, diff: Math.max(0, Math.floor((next - serverTime) / 1000)) };
    };

    const s0 = update(this.settings.scanner.stage0Period, this.settings.scanner.stage0StartTime);
    const s0p = update(this.settings.scanner.stage0PPeriod, this.settings.scanner.stage0PStartTime);
    const s1 = update(this.settings.scanner.stage1Period, this.settings.scanner.stage1StartTime);
    const s2 = update(this.settings.scanner.stage2Period, this.settings.scanner.stage2StartTime);

    this.scanTimes.stage0NextStart = s0.next;
    this.scanTimes.stage0Countdown = s0.diff;
    this.scanTimes.stage0PNextStart = s0p.next;
    this.scanTimes.stage0PCountdown = s0p.diff;
    this.scanTimes.stage1NextStart = s1.next;
    this.scanTimes.stage1Countdown = s1.diff;
    this.scanTimes.stage2NextStart = s2.next;
    this.scanTimes.stage2Countdown = s2.diff;
  }

  private async handleWSMessage(data: any) {
    this.lastWSMessageTime = Date.now();
    
    if (data.e === 'kline') {
      const k = data.k;
      const symbol = data.s.toLowerCase();
      const klineData = { t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, v: k.v, q: k.q, x: k.x };
      
      if (k.i === '5m') this.stage2Data.set(symbol, klineData);
      if (k.i === '15m') {
        this.stage2Data15m.set(symbol, klineData);
        if (k.x) this.stage2Data15mClosed.set(symbol, klineData);
      }
      if (data.s === 'BTCUSDT' && k.i === '15m') this.btcData = klineData;
    }

    if (data.e === 'ORDER_TRADE_UPDATE') {
      const o = data.o;
      this.addLog('Order', 'order', `订单更新: ${o.s} ${o.S} ${o.x} ${o.X} 价格:${o.ap || o.p} 数量:${o.q}`);
      this.refreshAccountInfo();
    }

    if (data.e === 'ACCOUNT_UPDATE') {
      this.refreshAccountInfo();
    }
  }

  private async refreshAccountInfo() {
    try {
      const info = await this.binance.getAccountInfo();
      this.accountInfo = info;
      const positions = await this.binance.getPositions();
      const active = positions.find((p: any) => parseFloat(p.positionAmt) !== 0);
      
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
          entryTime: this.activePosition?.entryTime || Date.now()
        };
      } else {
        this.activePosition = null;
      }

      const orders = await this.binance.getOpenOrders();
      const algoOrders = await this.binance.getOpenAlgoOrders();
      this.activeOrders = [...(orders || []), ...(algoOrders || [])];
      
      this.notifyUI();
      this.saveState();
    } catch (e: any) {
      this.apiError = e.message;
      this.notifyUI();
    }
  }

  private async refreshExchangeInfo() {
    try {
      await this.binance.getExchangeInfo();
    } catch (e) {}
  }

  private async setupUserDataStream() {
    try {
      const res = await this.binance.createListenKey();
      this.listenKey = res.listenKey;
      this.ws.setListenKey(this.listenKey);
      
      if (this.listenKeyTimer) clearInterval(this.listenKeyTimer);
      this.listenKeyTimer = setInterval(() => {
        this.binance.keepAliveListenKey().catch(() => {
          this.addLog('System', 'error', 'ListenKey 续期失败，尝试重新创建');
          this.setupUserDataStream();
        });
      }, 30 * 60 * 1000);
    } catch (e: any) {
      this.addLog('System', 'error', `创建 ListenKey 失败: ${e.message}`);
    }
  }

  private async runStage0() {
    if (!this.masterSwitch || this.isScanning.stage0) return;
    this.isScanning.stage0 = true;
    this.isScanning.stage0Progress = 0;
    this.scanTimes.stage0LastStart = Date.now();
    this.notifyUI();

    this.addLog('Scanner', 'scanner', '开始全市场扫描 (Stage 0)');
    const startTime = Date.now();
    try {
      const exchangeInfo = await this.binance.getExchangeInfo();
      const symbols = exchangeInfo.symbols
        .filter((s: any) => s.quoteAsset === 'USDT' && s.status === 'TRADING' && !s.symbol.includes('_'))
        .map((s: any) => s.symbol);

      const results: string[] = [];
      const total = symbols.length;
      for (let i = 0; i < symbols.length; i += 50) {
        const batch = symbols.slice(i, i + 50);
        await Promise.all(batch.map(async (symbol: string) => {
          try {
            const klines = await this.binance.getKLines(symbol, this.settings.scanner.stage0KLineInterval, this.settings.scanner.stage0KCountMax);
            if (klines.length >= this.settings.scanner.stage0KCountMin) {
              results.push(symbol);
            }
          } catch (e) {}
        }));
        this.isScanning.stage0Progress = Math.min(100, ((i + 50) / total) * 100);
        this.notifyUI();
      }

      results.sort();
      this.stage0Results = results;
      this.scanTimes.stage0Duration = Date.now() - startTime;
      this.saveState();
      this.addLog('Scanner', 'scanner', `全市场扫描完成，耗时 ${Date.now() - startTime}ms，符合条件币对: ${results.length}`);

      if (!this.settings.scanner.stage0PEnabled) {
        this.stage0PResults = [...results];
        this.stage0PReasons.clear();
        this.notifyUI();
      }
    } catch (e: any) {
      this.addLog('Scanner', 'error', `全市场扫描失败: ${e.message}`);
    } finally {
      this.isScanning.stage0 = false;
      this.isScanning.stage0Progress = 100;
      this.notifyUI();
    }
  }

  private async runStage0P() {
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

    this.addLog('Scanner', 'scanner', '开始第0阶段扫描 (Stage 0P)');
    const startTime = Date.now();
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
            const check = async (interval: string, count: number, ref: number, label: string) => {
              const klines = await this.binance.getKLines(symbol, interval as any, count + 1);
              const completed = klines.slice(0, -1);
              for (const k of completed) {
                const change = Math.abs(((parseFloat(k[4]) - parseFloat(k[1])) / parseFloat(k[1])) * 100);
                if (change >= ref) return { ok: false, reason: `${label} K线涨跌幅 ${change.toFixed(2)}% >= 参考值 ${ref}%` };
              }
              return { ok: true, reason: '' };
            };

            if (this.settings.scanner.stage0P15mEnabled) {
              const res = await check('15m', this.settings.scanner.stage0P15mCount, this.settings.scanner.stage0P15mRef, '15m');
              if (!res.ok) { isOk = false; reason = res.reason; }
            }
            if (isOk && this.settings.scanner.stage0P1hEnabled) {
              const res = await check('1h', this.settings.scanner.stage0P1hCount, this.settings.scanner.stage0P1hRef, '1h');
              if (!res.ok) { isOk = false; reason = res.reason; }
            }
            if (isOk && this.settings.scanner.stage0P4hEnabled) {
              const res = await check('4h', this.settings.scanner.stage0P4hCount, this.settings.scanner.stage0P4hRef, '4h');
              if (!res.ok) { isOk = false; reason = res.reason; }
            }
            if (isOk && this.settings.scanner.stage0PDayEnabled) {
              const res = await check('1d', this.settings.scanner.stage0PDayCount, this.settings.scanner.stage0PDayRef, '日线');
              if (!res.ok) { isOk = false; reason = res.reason; }
            }

            if (isOk) results.push(symbol);
            else reasons.set(symbol, reason);
          } catch (e) {}
        }));
        this.isScanning.stage0PProgress = Math.min(100, ((i + 20) / total) * 100);
        this.notifyUI();
      }

      results.sort();
      this.stage0PResults = results;
      this.stage0PReasons = reasons;
      this.scanTimes.stage0PDuration = Date.now() - startTime;
      this.saveState();
      this.addLog('Scanner', 'scanner', `第0阶段扫描完成，符合条件币对: ${results.length}`);
    } catch (e: any) {
      this.addLog('Scanner', 'error', `第0阶段扫描失败: ${e.message}`);
    } finally {
      this.isScanning.stage0P = false;
      this.isScanning.stage0PProgress = 100;
      this.notifyUI();
    }
  }

  private async runStage1() {
    if (!this.masterSwitch || this.isScanning.stage1) return;
    this.bestSymbol = null;
    this.isScanning.stage1 = true;
    this.isScanning.stage1Progress = 0;
    this.scanTimes.stage1LastStart = Date.now();
    this.notifyUI();

    this.addLog('Scanner', 'scanner', '开始第一阶段扫描 (Stage 1)');
    const startTime = Date.now();
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
            const klines = await this.binance.getKLines(symbol, this.settings.scanner.stage1Period as any, 1);
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
      this.scanTimes.stage1Duration = Date.now() - startTime;
      this.saveState();
      this.updateSubscriptions();
      await this.binance.syncTime();
      this.addLog('Scanner', 'scanner', `第一阶段扫描完成，符合条件币对: ${results.length}`);
    } catch (e: any) {
      this.addLog('Scanner', 'error', `第一阶段扫描失败: ${e.message}`);
    } finally {
      this.isScanning.stage1 = false;
      this.notifyUI();
    }
  }

  private async runStage2() {
    if (!this.masterSwitch || this.isScanning.stage2) return;
    this.isScanning.stage2 = true;
    this.isScanning.stage2Progress = 0;
    this.scanTimes.stage2LastStart = Date.now();
    this.notifyUI();

    this.addLog('Scanner', 'scanner', '开始第二阶段扫描 (Stage 2)');
    const startTime = Date.now();
    try {
      const candidates: any[] = [];
      const failed: any[] = [];
      const total = this.stage1Results.length;
      let processed = 0;

      for (const symbol of this.stage1Results) {
        processed++;
        this.isScanning.stage2Progress = (processed / total) * 100;
        if (processed % 5 === 0) this.notifyUI();

        const k5 = this.stage2Data.get(symbol.toLowerCase());
        const k15 = this.stage2Data15m.get(symbol.toLowerCase());
        const k15Closed = this.stage2Data15mClosed.get(symbol.toLowerCase());
        
        if (!k5 || !k15) {
          failed.push({ symbol, reason: !k5 ? '无5mK线数据' : '无15mK线数据' });
          continue;
        }

        const serverTime = Date.now() + this.binance.getTimeOffset();
        const p5 = 5 * 60 * 1000;
        const p15 = 15 * 60 * 1000;
        const current15mStart = Math.floor(serverTime / p15) * p15;

        if (k15.t !== current15mStart) {
          failed.push({ symbol, reason: `15mK线延迟` });
          continue;
        }

        const k5Change = ((parseFloat(k5.c) - parseFloat(k5.o)) / parseFloat(k5.o)) * 100;
        const k15ChangeCurrent = ((parseFloat(k15.c) - parseFloat(k15.o)) / parseFloat(k15.o)) * 100;
        const aChange = ((parseFloat(k15.h) - parseFloat(k15.c)) / parseFloat(k15.c)) * 100;
        const volume = parseFloat(k15.q);

        let kbChange = 0;
        if (this.btcData) kbChange = ((parseFloat(this.btcData.c) - parseFloat(this.btcData.o)) / parseFloat(this.btcData.o)) * 100;

        let match = true;
        let reason = '';
        if (this.settings.scanner.stage2Cond1Enabled && (k15ChangeCurrent < this.settings.scanner.stage2K21 || k15ChangeCurrent > this.settings.scanner.stage2K22)) { match = false; reason = 'K2不在范围'; }
        else if (this.settings.scanner.stage2Cond2Enabled && (aChange < this.settings.scanner.stage2A21 || aChange > this.settings.scanner.stage2A22)) { match = false; reason = 'A不在范围'; }
        else if (this.settings.scanner.stage2Cond3Enabled && (volume < this.settings.scanner.stage2M21 || volume > this.settings.scanner.stage2M22)) { match = false; reason = '交易额不在范围'; }
        else if (this.settings.scanner.stage2Cond4Enabled && (k5Change < this.settings.scanner.stage2K51 || k5Change > this.settings.scanner.stage2K52)) { match = false; reason = 'K5不在范围'; }
        else if (this.settings.scanner.stage2Cond5Enabled && this.btcData && (kbChange < this.settings.scanner.stage2KB1 || kbChange > this.settings.scanner.stage2KB2)) { match = false; reason = 'KB不在范围'; }

        const openPrice = parseFloat(k15.o);
        const closePriceRef = k15Closed ? parseFloat(k15Closed.c) : openPrice;
        const k15ChangeRef = k15Closed ? ((parseFloat(k15Closed.c) - parseFloat(k15Closed.o)) / parseFloat(k15Closed.o)) * 100 : 0;

        const lastTrade = this.cooldowns.get(symbol) || 0;
        if (Date.now() - lastTrade < this.settings.scanner.stage2Cooldown * 60000) {
          failed.push({ symbol, reason: '冷却中' });
          continue;
        }

        const k15AbsRef = Math.abs(k15ChangeRef);
        const tpOffset = (k15AbsRef * this.settings.order.takeProfitRatio) / 100;
        const slOffset = (k15AbsRef * this.settings.order.stopLossRatio) / 100;

        const coinData = { 
          symbol, volume, price: closePriceRef, open: openPrice, close: closePriceRef, high: parseFloat(k15.h), low: parseFloat(k15.l),
          k5Change, k15Change: k15ChangeRef, aChange, kAbsChange: k15ChangeCurrent, kbChange,
          tpPrice: this.formatPrice(symbol, closePriceRef * (1 + tpOffset)),
          slPrice: this.formatPrice(symbol, closePriceRef * (1 - slOffset)),
        };

        if (match) candidates.push(coinData);
        else failed.push({ ...coinData, reason });
      }

      candidates.sort((a, b) => b.volume - a.volume);
      this.stage2Results = candidates;
      this.stage2Failed = failed;
      this.scanTimes.stage2Duration = Date.now() - startTime;

      if (candidates.length > 0) {
        this.bestSymbol = candidates[0];
        this.scanTimes.bestSelectionTime = Date.now();
        this.addLog('Scanner', 'scanner', `第二阶段扫描完成，优选币对: ${this.bestSymbol.symbol}`);
      } else {
        this.addLog('Scanner', 'scanner', `第二阶段扫描完成，未发现符合条件的币对`);
      }
    } catch (e: any) {
      this.addLog('Scanner', 'error', `第二阶段扫描失败: ${e.message}`);
    } finally {
      this.isScanning.stage2 = false;
      this.isScanning.stage2Progress = 100;
      this.notifyUI();
    }
  }

  private async executeTrade(best: any) {
    if (this.activePosition) return;
    try {
      const symbol = best.symbol;
      const price = best.price;
      const balance = parseFloat(this.accountInfo?.totalWalletBalance || '0');
      const kje = Math.min(balance * this.settings.order.leverage * this.settings.order.positionRatio, this.settings.order.maxPositionAmount);
      const kcl = kje / price;
      const formattedQty = this.formatQuantity(symbol, kcl);

      this.addLog('Order', 'order', `下单指令: ${symbol}, 价格: ${price}, 数量: ${formattedQty}`);
      await this.binance.setLeverage(symbol, this.settings.order.leverage);
      const order = await this.binance.createOrder({ symbol, side: 'BUY', type: 'MARKET', quantity: formattedQty });

      let entryPrice = price;
      if (order && order.avgPrice && parseFloat(order.avgPrice) > 0) entryPrice = parseFloat(order.avgPrice);
      
      const entryTime = order.updateTime || order.transactTime || Date.now();
      this.activePosition = { symbol, side: 'BUY', amount: parseFloat(formattedQty), leverage: this.settings.order.leverage, entryPrice, markPrice: entryPrice, unrealizedProfit: 0, updateTime: Date.now(), entryTime };
      
      const periodSec = this.parsePeriod(this.settings.order.kClosedPeriod);
      const serverSeconds = (Date.now() + this.binance.getTimeOffset()) / 1000;
      const targetOpenTimeSec = Math.floor((serverSeconds - 180) / periodSec) * periodSec;

      this.pendingSecondaryOrders = { symbol, entryPrice, quantity: formattedQty, targetOpenTime: targetOpenTimeSec * 1000, triggerTime: (targetOpenTimeSec + periodSec) * 1000 + 200 };

      this.notifyUI();
      this.updateSubscriptions();
      this.cooldowns.set(symbol, Date.now());
      this.saveState();
    } catch (e: any) {
      this.addLog('Order', 'error', `下单失败: ${e.message}`);
    }
  }

  private async placeSecondaryOrders(pending: any) {
    try {
      const { symbol, quantity, targetOpenTime } = pending;
      const klines = await this.binance.getKLines(symbol, this.settings.order.kClosedPeriod as any, 5);
      const closedK = klines.find((k: any) => k[0] === targetOpenTime) || klines[klines.length - 2];
      const kOpen = parseFloat(closedK[1]);
      const kClose = parseFloat(closedK[4]);
      const k15Change = ((kClose - kOpen) / kOpen) * 100;
      const k15Abs = Math.abs(k15Change);
      const tpPrice = kClose * (1 + (k15Abs * this.settings.order.takeProfitRatio) / 100);
      const slPrice = kClose * (1 - (k15Abs * this.settings.order.stopLossRatio) / 100);
      const formattedTp = this.formatPrice(symbol, tpPrice);
      const formattedSl = this.formatPrice(symbol, slPrice);

      await this.binance.createOrder({ symbol, side: 'SELL', type: 'LIMIT', quantity, price: formattedTp, timeInForce: 'GTC', reduceOnly: 'true' });
      await this.binance.createAlgoOrder({ symbol, side: 'SELL', algoType: 'CONDITIONAL', type: 'STOP_MARKET', stopPrice: formattedSl, triggerPrice: formattedSl, quantity, reduceOnly: 'true' });

      this.addLog('Order', 'order', `二次订单完成: ${symbol}`);
      this.refreshAccountInfo();
    } catch (e: any) {
      this.addLog('Order', 'error', `放置二次订单失败: ${e.message}`);
    }
  }

  private updateSubscriptions() {
    const streams = ['btcusdt@kline_15m'];
    if (this.masterSwitch) {
      this.stage1Results.forEach(s => {
        streams.push(`${s.toLowerCase()}@kline_5m`);
        streams.push(`${s.toLowerCase()}@kline_15m`);
      });
    }
    this.ws.subscribe(streams);
  }

  private formatPrice(symbol: string, price: number): string {
    return price.toFixed(4); // Simplified
  }

  private formatQuantity(symbol: string, qty: number): string {
    return qty.toFixed(3); // Simplified
  }

  private addLog(module: string, type: 'scanner' | 'order' | 'error' | 'system', message: string) {
    const log = BackendStorage.addLog({ module, type, message });
    this.onLog(log);
  }

  private saveState() {
    BackendStorage.saveState({
      stage0Results: this.stage0Results,
      stage0PResults: this.stage0PResults,
      stage1Results: this.stage1Results,
      cooldowns: Object.fromEntries(this.cooldowns),
      activePosition: this.activePosition,
      consecutiveReverseOrders: this.consecutiveReverseOrders
    });
  }

  private notifyUI() {
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
      isScanning: this.isScanning,
      masterSwitch: this.masterSwitch
    });
  }

  public setMasterSwitch(val: boolean) {
    this.masterSwitch = val;
    this.settings.masterSwitch = val;
    BackendStorage.saveSettings(this.settings);
    
    if (val) {
      this.binance.syncTime();
      this.refreshExchangeInfo();
      this.setupUserDataStream();
      this.ws.connect(
        () => { this.wsError = null; this.notifyUI(); this.updateSubscriptions(); },
        () => this.notifyUI(),
        (err) => { this.wsError = 'WS Error'; this.notifyUI(); }
      );
      this.refreshAccountInfo();
      this.runStage0();
    } else {
      this.updateSubscriptions();
      this.ws.close();
      if (this.listenKeyTimer) clearInterval(this.listenKeyTimer);
      this.listenKeyTimer = null;
      this.listenKey = null;
      this.notifyUI();
    }
  }

  public updateSettings(settings: AppSettings) {
    this.settings = settings;
    this.masterSwitch = settings.masterSwitch;
    this.binance = new BinanceService(settings.binance.apiKey, settings.binance.secretKey, settings.binance.baseUrl);
    this.ws.setUrl(settings.binance.wsUrl);
    if (this.masterSwitch) {
      this.binance.syncTime();
      this.refreshAccountInfo();
    }
  }

  public getFullState() {
    return {
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
      isScanning: this.isScanning,
      masterSwitch: this.masterSwitch
    };
  }
}
