import CryptoJS from 'crypto-js';
import axios from 'axios';

export class BinanceService {
  private apiKey: string;
  private secretKey: string;
  private baseUrl: string;
  private timeOffset: number = 0;
  private ipSelection: 'local' | 'proxy' = 'local';

  constructor(apiKey: string, secretKey: string, baseUrl: string) {
    this.apiKey = apiKey.trim();
    this.secretKey = secretKey.trim();
    this.baseUrl = baseUrl.trim();
    this.syncTime();
  }

  setIpSelection(selection: 'local' | 'proxy') {
    this.ipSelection = selection;
  }

  async syncTime() {
    try {
      const start = Date.now();
      const url = `${this.baseUrl}/fapi/v1/time`;
      
      const response = await axios.get(url, { timeout: 10000 });
      const data = response.data;

      const end = Date.now();
      const serverTime = data.serverTime;
      // Offset = ServerTime - (LocalTime + Latency/2)
      this.timeOffset = serverTime - (start + (end - start) / 2);
      console.log(`[Server] Binance Time Synced. Offset: ${this.timeOffset}ms`);
    } catch (e) {
      console.error('[Server] Failed to sync time with Binance', e);
    }
  }

  getTimeOffset() {
    return this.timeOffset;
  }

  private async request(method: string, path: string, params: any = {}, signed: boolean = false) {
    const timestamp = Math.floor(Date.now() + this.timeOffset);
    const requestParams = { ...params };

    if (signed) {
      requestParams.timestamp = timestamp;
      requestParams.recvWindow = 60000;
    }

    let queryString = Object.entries(requestParams)
      .map(([key, val]) => `${key}=${val}`)
      .join('&');

    if (signed) {
      const signature = CryptoJS.HmacSHA256(queryString, this.secretKey).toString();
      queryString += `&signature=${signature}`;
    }

    const url = `${this.baseUrl}${path}${queryString ? '?' + queryString : ''}`;
    const headers = {
      'X-MBX-APIKEY': this.apiKey,
    };
    
    try {
      const response = await axios({
        url,
        method,
        headers,
        timeout: 20000
      });
      return response.data;
    } catch (e: any) {
      const errorData = e.response?.data;
      const status = e.response?.status;

      if (errorData) {
        if (errorData.code === -1021 && !params._isRetry) {
          console.warn('[Server] Timestamp error detected, re-syncing time and retrying...');
          await this.syncTime();
          return this.request(method, path, { ...params, _isRetry: true }, signed);
        }

        if (errorData.code === -2015) {
          throw new Error(`币安 API 权限/IP 错误: 请确保已在币安 API 设置中勾选 "允许合约" 权限。如果开启了 IP 限制，请将服务器公网 IP 加入白名单。`);
        }

        throw new Error(errorData.msg || `Binance API Error (${status})`);
      }

      if (!params._isRetry) {
        console.warn('[Server] Network error detected, retrying once...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        return this.request(method, path, { ...params, _isRetry: true }, signed);
      }
      
      console.error('[Server] Binance Request Failed:', e.message);
      throw e;
    }
  }

  async getExchangeInfo() {
    return this.request('GET', '/fapi/v1/exchangeInfo');
  }

  async getKLines(symbol: string, interval: string, limit: number = 500, startTime?: number, endTime?: number) {
    const params: any = { symbol, interval, limit };
    if (startTime) params.startTime = startTime;
    if (endTime) params.endTime = endTime;
    return this.request('GET', '/fapi/v1/klines', params);
  }

  async getAccountInfo() {
    return this.request('GET', '/fapi/v2/account', {}, true);
  }

  async getPositions() {
    return this.request('GET', '/fapi/v2/positionRisk', {}, true);
  }

  async getOpenOrders(symbol?: string) {
    return this.request('GET', '/fapi/v1/openOrders', symbol ? { symbol } : {}, true);
  }

  async getOpenAlgoOrders(symbol?: string) {
    return this.request('GET', '/fapi/v1/openAlgoOrders', symbol ? { symbol } : {}, true);
  }

  async cancelAlgoOrder(algoId: string) {
    return this.request('DELETE', '/fapi/v1/algoOrder', { algoId }, true);
  }

  async createOrder(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'LIMIT' | 'MARKET' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    quantity?: string;
    price?: string;
    stopPrice?: string;
    timeInForce?: 'GTC' | 'IOC' | 'FOK';
    reduceOnly?: string;
    closePosition?: string;
    workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE';
    priceProtect?: string;
    positionSide?: string;
  }) {
    return this.request('POST', '/fapi/v1/order', params, true);
  }

  async createAlgoOrder(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    algoType: 'VP' | 'TWAP' | 'CONDITIONAL';
    type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    quantity?: string;
    stopPrice?: string;
    triggerPrice?: string;
    reduceOnly?: string;
    workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE';
    [key: string]: any;
  }) {
    return this.request('POST', '/fapi/v1/algoOrder', params, true);
  }

  async cancelAllOrders(symbol: string) {
    return this.request('DELETE', '/fapi/v1/allOpenOrders', { symbol }, true);
  }

  async setLeverage(symbol: string, leverage: number) {
    return this.request('POST', '/fapi/v1/leverage', { symbol, leverage }, true);
  }

  async createListenKey() {
    return this.request('POST', '/fapi/v1/listenKey', {}, false);
  }

  async keepAliveListenKey() {
    return this.request('PUT', '/fapi/v1/listenKey', {}, false);
  }
}
